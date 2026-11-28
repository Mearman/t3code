import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type MessageId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  CLAUDE_MOVE_COMPACTION_LIMIT,
  moveClaudeThreads,
  type ClaudeAccountMoveDependencies,
  type ClaudeAccountMoveThread,
} from "./ClaudeAccountMove.ts";
import { claudeAccountIdentity, makeClaudeThreadAccountStore } from "./ClaudeThreadAccounts.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const claude = ProviderDriverKind.make("claudeAgent");
const personal = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const threadId = ThreadId.make("thread-move");
const providerThreadId = ProviderThreadId.make("provider-thread-move");
const session = "11111111-2222-3333-4444-555555555555";
const projectDir = "-work-repo";
const transcriptPath = `projects/${projectDir}/${session}.jsonl`;
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
// What a `/compact` turn leaves: the boundary, the summary, then the command and its output.
const compactedTail =
  line({ type: "system", subtype: "compact_boundary" }) +
  line({ type: "user", isCompactSummary: true, message: "summary" }) +
  line({ type: "user", message: { content: "<command-name>/compact</command-name>" } }) +
  line({ type: "user", message: { content: "<local-command-stdout>Compacted" } });

interface Options {
  readonly sharedStore?: boolean;
  readonly transcript?: string;
  /** How the compaction run ends; "never" leaves it running. */
  readonly compaction?: OrchestrationV2RunStatus | "never";
  readonly held?: boolean;
  /** What changes while the old account compacts. */
  readonly duringCompaction?: {
    readonly runStatus?: OrchestrationV2RunStatus;
    readonly held?: boolean;
  };
  /** Fails switching the selection, after the files have moved. */
  readonly failSelection?: boolean;
  /** Runs while switching the selection; tests interrupt the move there. */
  readonly onSelection?: Effect.Effect<void>;
  readonly runStatus?: OrchestrationV2RunStatus;
  readonly targetFile?: string;
}

const harness = (options: Options = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const source = path.join(root, "personal");
    const target = path.join(root, "work");
    const write = (home: string, relative: string, text: string) =>
      fileSystem
        .makeDirectory(path.dirname(path.join(home, relative)), { recursive: true })
        .pipe(Effect.andThen(fileSystem.writeFileString(path.join(home, relative), text)));
    yield* write(
      source,
      transcriptPath,
      options.transcript ?? line({ type: "user", message: "hi" }),
    );
    yield* write(source, `file-history/${session}/backup@v1`, "backup");
    if (options.sharedStore) {
      yield* fileSystem.makeDirectory(target);
      yield* fileSystem.symlink(path.join(source, "projects"), path.join(target, "projects"));
    } else yield* fileSystem.makeDirectory(path.join(target, "projects"), { recursive: true });
    if (options.targetFile !== undefined) yield* write(target, transcriptPath, options.targetFile);

    const commands: Array<string> = [];
    let selected = personal;
    let runStatus = options.runStatus;
    let held = options.held === true;
    const compactionWaiting = yield* Deferred.make<void>();
    const accounts = yield* makeClaudeThreadAccountStore(path.join(root, "accounts.json"));
    yield* accounts.check(
      threadId,
      claudeAccountIdentity({ email: "personal@example.com", tokenSource: "claude.ai" }),
    );
    const projection = (): ClaudeAccountMoveThread => ({
      thread: {
        modelSelection: { instanceId: selected, model: "claude-test" },
        activeProviderThreadId: providerThreadId,
      },
      runs: runStatus === undefined ? [] : [{ status: runStatus }],
      providerThreads: [
        {
          id: providerThreadId,
          nativeThreadRef: { driver: claude, nativeId: session, strength: "strong" },
        },
      ],
      providerSessions: [
        { id: ProviderSessionId.make("live"), providerInstanceId: personal, status: "ready" },
      ],
    });
    const store = (home: string, key: string, isHeld: () => boolean) => ({
      driverKind: claude,
      continuationIdentity: { driverKind: claude, continuationKey: key },
      nativeThreadStore: {
        root: home,
        hasNativeThread: () => Effect.succeed(true),
        checkNativeThreadFree: (input: { readonly providerThreadId: ProviderThreadId }) =>
          isHeld()
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterThreadInUseError({
                  driver: claude,
                  providerThreadId: input.providerThreadId,
                  detail: "Another Claude Code process has this session open.",
                  cause: "held",
                  holderObserved: true,
                }),
              )
            : Effect.void,
      },
    });
    let compactMessage: MessageId | undefined;
    const deps: ClaudeAccountMoveDependencies = {
      orchestration: {
        getThreadProjection: () => Effect.sync(projection),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command.type);
            if (command.type === "message.dispatch") compactMessage = command.messageId;
            if (command.type === "thread.model-selection.set") {
              if (options.onSelection !== undefined) yield* options.onSelection;
              if (options.failSelection === true)
                return yield* new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "refused",
                });
              selected = command.modelSelection.instanceId;
            }
            return { sequence: commands.length };
          }),
        runUpdates: () => {
          if (compactMessage === undefined) return Stream.empty;
          if (options.compaction === "never")
            return Stream.fromEffect(Deferred.succeed(compactionWaiting, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            );
          runStatus = options.duringCompaction?.runStatus ?? runStatus;
          held = options.duringCompaction?.held ?? held;
          return Stream.fromIterable<{
            readonly userMessageId: MessageId;
            readonly status: OrchestrationV2RunStatus;
          }>([
            { userMessageId: compactMessage, status: "running" },
            { userMessageId: compactMessage, status: options.compaction ?? "completed" },
          ]);
        },
      },
      releaseSession: () =>
        Effect.gen(function* () {
          // The copy must not have started while T3 Code's own process can still write.
          const copied = yield* fileSystem.exists(path.join(target, transcriptPath));
          commands.push(copied && !options.sharedStore ? "release-after-copy" : "release");
        }),
      listThreads: (instanceId) => Effect.succeed(instanceId === selected ? [threadId] : []),
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === personal
            ? store(source, "claude:store:personal", () => held)
            : instanceId === work
              ? store(
                  target,
                  options.sharedStore ? "claude:store:personal" : "claude:store:work",
                  () => false,
                )
              : undefined,
        ),
      accounts,
    };
    const move = (compact = true, targetInstanceId = work) =>
      moveClaudeThreads(deps, {
        selection: { threadIds: [threadId] },
        targetInstanceId,
        compact,
      });
    const moveAll = () =>
      moveClaudeThreads(deps, {
        selection: { fromInstanceId: personal },
        targetInstanceId: work,
        compact: false,
      });
    return {
      fileSystem,
      path,
      source,
      target,
      commands,
      compactionWaiting,
      accounts,
      move,
      moveAll,
      selected: () => selected,
    };
  });

const isLink = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.readLink(file).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

it.effect("compacts under the old account, then switches within a shared store", () =>
  Effect.gen(function* () {
    const h = yield* harness({ sharedStore: true });
    const { outcomes } = yield* h.move();
    assert.deepEqual(outcomes, [{ threadId, status: "moved" }]);
    assert.deepEqual(h.commands, ["message.dispatch", "thread.model-selection.set"]);
    assert.strictEqual(h.selected(), work);
    assert.isUndefined(yield* h.accounts.read(threadId));
    assert.isFalse(yield* isLink(h.fileSystem, h.path.join(h.source, transcriptPath)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("does not compact again when the session already ends compacted, or when skipped", () =>
  Effect.gen(function* () {
    const compacted = yield* harness({ sharedStore: true, transcript: compactedTail });
    yield* compacted.move();
    assert.deepEqual(compacted.commands, ["thread.model-selection.set"]);
    const skipped = yield* harness({ sharedStore: true });
    yield* skipped.move(false);
    assert.deepEqual(skipped.commands, ["thread.model-selection.set"]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moves nothing when the old account cannot compact", () =>
  Effect.gen(function* () {
    const h = yield* harness({ compaction: "failed" });
    const { outcomes } = yield* h.move();
    assert.strictEqual(outcomes[0]?.status, "compactionFailed");
    assert.deepEqual(h.commands, ["message.dispatch"]);
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcriptPath)));
    assert.isDefined(yield* h.accounts.read(threadId));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moves nothing while another process holds the session or the thread is working", () =>
  Effect.gen(function* () {
    const held = yield* harness({ held: true });
    const heldOutcome = (yield* held.move()).outcomes[0];
    assert.strictEqual(heldOutcome?.status, "held");
    assert.include(heldOutcome?.detail ?? "", "Another Claude Code process");
    assert.deepEqual(held.commands, []);
    const busy = yield* harness({ runStatus: "running" });
    assert.strictEqual((yield* busy.move()).outcomes[0]?.status, "busy");
    assert.deepEqual(busy.commands, []);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("across stores, releases the session, copies, links and then switches", () =>
  Effect.gen(function* () {
    const h = yield* harness({});
    const { outcomes } = yield* h.move();
    assert.deepEqual(outcomes, [{ threadId, status: "moved", copied: true }]);
    assert.deepEqual(h.commands, [
      "message.dispatch",
      "provider-session.detach",
      "release",
      "thread.model-selection.set",
    ]);
    for (const relative of [transcriptPath, `file-history/${session}`]) {
      const original = h.path.join(h.source, relative);
      assert.strictEqual(yield* h.fileSystem.readLink(original), h.path.join(h.target, relative));
    }
    assert.strictEqual(h.selected(), work);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("leaves the thread and its files as they were when the copy cannot be made", () =>
  Effect.gen(function* () {
    const h = yield* harness({ targetFile: "a different session\n" });
    const outcome = (yield* h.move(false)).outcomes[0];
    assert.strictEqual(outcome?.status, "copyFailed");
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* isLink(h.fileSystem, h.path.join(h.source, transcriptPath)));
    assert.isFalse(h.commands.includes("thread.model-selection.set"));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moves every thread on an account when the selection names the account", () =>
  Effect.gen(function* () {
    const h = yield* harness({ sharedStore: true });
    assert.deepEqual((yield* h.moveAll()).outcomes, [{ threadId, status: "moved" }]);
    assert.strictEqual(h.selected(), work);
    assert.deepEqual((yield* h.moveAll()).outcomes, []);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("re-checks after compacting, and moves nothing if the thread was taken meanwhile", () =>
  Effect.gen(function* () {
    const working = yield* harness({ duringCompaction: { runStatus: "running" } });
    assert.strictEqual((yield* working.move()).outcomes[0]?.status, "busy");
    assert.deepEqual(working.commands, ["message.dispatch"]);
    assert.strictEqual(working.selected(), personal);
    const taken = yield* harness({ duringCompaction: { held: true } });
    assert.strictEqual((yield* taken.move()).outcomes[0]?.status, "held");
    assert.deepEqual(taken.commands, ["message.dispatch"]);
    assert.isFalse(yield* taken.fileSystem.exists(taken.path.join(taken.target, transcriptPath)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("gives up on a compaction that never ends, moving nothing", () =>
  Effect.gen(function* () {
    const h = yield* harness({ compaction: "never" });
    const fiber = yield* Effect.forkChild(h.move());
    yield* Deferred.await(h.compactionWaiting);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(CLAUDE_MOVE_COMPACTION_LIMIT);
    const { outcomes } = yield* Fiber.join(fiber);
    assert.strictEqual(outcomes[0]?.status, "compactionFailed");
    assert.strictEqual(h.selected(), personal);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("puts the files back when switching the selection fails after they moved", () =>
  Effect.gen(function* () {
    const h = yield* harness({ failSelection: true });
    const outcome = (yield* h.move(false)).outcomes[0];
    assert.strictEqual(outcome?.status, "failed");
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* isLink(h.fileSystem, h.path.join(h.source, transcriptPath)));
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcriptPath)));
    assert.isDefined(yield* h.accounts.read(threadId));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a move cut off while it switches finishes, leaving files and selection agreeing", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const h = yield* harness({
      onSelection: Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Effect.sleep("1 second")),
      ),
    });
    const fiber = yield* Effect.forkChild(h.move(false));
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.await(fiber);
    assert.strictEqual(h.selected(), work);
    assert.strictEqual(
      yield* h.fileSystem.readLink(h.path.join(h.source, transcriptPath)),
      h.path.join(h.target, transcriptPath),
    );
    const leftovers = (yield* h.fileSystem.readDirectory(h.source, { recursive: true })).filter(
      (entry) => entry.includes(".t3-move"),
    );
    assert.deepEqual(leftovers, []);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moving a thread back to its first account keeps its history readable in both", () =>
  Effect.gen(function* () {
    const h = yield* harness({});
    yield* h.move(false);
    const back = (yield* h.move(false, personal)).outcomes[0];
    assert.deepEqual(back, { threadId, status: "moved" });
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* isLink(h.fileSystem, h.path.join(h.target, transcriptPath)));
    for (const home of [h.source, h.target])
      assert.include(yield* h.fileSystem.readFileString(h.path.join(home, transcriptPath)), "hi");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
