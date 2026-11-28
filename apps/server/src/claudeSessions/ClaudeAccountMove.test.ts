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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  moveClaudeThreads,
  type ClaudeAccountMoveDependencies,
  type ClaudeAccountMoveThread,
} from "./ClaudeAccountMove.ts";
import { claudeAccountIdentity, makeClaudeThreadAccountStore } from "./ClaudeThreadAccounts.ts";

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
const compactedTail =
  line({ type: "system", subtype: "compact_boundary" }) +
  line({ type: "user", isCompactSummary: true, message: "summary" });

interface Options {
  readonly sharedStore?: boolean;
  readonly transcript?: string;
  readonly compaction?: OrchestrationV2RunStatus;
  readonly held?: boolean;
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
      runs: options.runStatus === undefined ? [] : [{ status: options.runStatus }],
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
    const store = (home: string, key: string, held: boolean) => ({
      driverKind: claude,
      continuationIdentity: { driverKind: claude, continuationKey: key },
      nativeThreadStore: {
        root: home,
        hasNativeThread: () => Effect.succeed(true),
        checkNativeThreadFree: (input: { readonly providerThreadId: ProviderThreadId }) =>
          held
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
          Effect.sync(() => {
            commands.push(command.type);
            if (command.type === "message.dispatch") compactMessage = command.messageId;
            if (command.type === "thread.model-selection.set")
              selected = command.modelSelection.instanceId;
            return { sequence: commands.length };
          }),
        runUpdates: () =>
          compactMessage === undefined
            ? Stream.empty
            : Stream.fromIterable<{
                readonly userMessageId: MessageId;
                readonly status: OrchestrationV2RunStatus;
              }>([
                { userMessageId: compactMessage, status: "running" },
                { userMessageId: compactMessage, status: options.compaction ?? "completed" },
              ]),
      },
      listThreads: (instanceId) => Effect.succeed(instanceId === selected ? [threadId] : []),
      getInstance: (instanceId) =>
        Effect.succeed(
          instanceId === personal
            ? store(source, "claude:store:personal", options.held === true)
            : instanceId === work
              ? store(
                  target,
                  options.sharedStore ? "claude:store:personal" : "claude:store:work",
                  false,
                )
              : undefined,
        ),
      accounts,
    };
    const move = (compact = true) =>
      moveClaudeThreads(deps, {
        selection: { threadIds: [threadId] },
        targetInstanceId: work,
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
      "thread.model-selection.set",
    ]);
    for (const relative of [transcriptPath, `file-history/${session}/backup@v1`]) {
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
