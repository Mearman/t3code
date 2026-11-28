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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import {
  CLAUDE_MOVE_COMPACTION_LIMIT,
  claudeAccountMoveOrchestration,
  moveClaudeThreads,
  type ClaudeAccountMoveDependencies,
  type ClaudeAccountMoveThread,
} from "./ClaudeAccountMove.ts";
import { claudeAccountIdentity, makeClaudeThreadAccountStore } from "./ClaudeThreadAccounts.ts";
import { makeClaudeSessionMoveFence } from "./ClaudeSpawnedProcesses.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const claude = ProviderDriverKind.make("claudeAgent");
const personal = ProviderInstanceId.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const third = ProviderInstanceId.make("claudeAgent_third");
const threadId = ThreadId.make("thread-move");
const providerThreadId = ProviderThreadId.make("provider-thread-move");
const session = "11111111-2222-3333-4444-555555555555";
const projectDir = "-work-repo";
const transcriptPath = `projects/${projectDir}/${session}.jsonl`;
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const inUse = (id: ProviderThreadId) =>
  new ProviderAdapter.ProviderAdapterThreadInUseError({
    driver: claude,
    providerThreadId: id,
    detail: "Another Claude Code process has this session open.",
    cause: "held",
    holderObserved: true,
  });
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
  /** This host cannot link files, as on Windows without symbolic link rights. */
  readonly cannotLink?: boolean;
  /** T3 Code's own process outlives the release. */
  readonly ownProcessLingers?: boolean;
  /** Dropping the thread's account record dies. */
  readonly forgetDies?: boolean;
  /** Sends a message to the thread while its session is being released. */
  readonly messageDuringRelease?: boolean;
  /** Changes the thread's model while the old account compacts. */
  readonly modelDuringCompaction?: string;
  /** Gives the thread a new session while the old account compacts, as a rollback does. */
  readonly sessionDuringCompaction?: string;
  /** Changes the thread's model once its session is released, before the files move. */
  readonly modelAfterRelease?: string;
  /** A run becomes active just as the move takes the session's fence. */
  readonly runningAtFence?: boolean;
  /** Runs after the session is released, while the files are about to move. */
  readonly afterRelease?: (
    fence: ReturnType<typeof makeClaudeSessionMoveFence>,
  ) => Effect.Effect<void>;
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
    let model = "claude-test";
    let nativeId = session;
    const moveFence = makeClaudeSessionMoveFence();
    const third_ = path.join(root, "third");
    yield* fileSystem.makeDirectory(path.join(third_, "projects"), { recursive: true });
    let runStatus = options.runStatus;
    let held = options.held === true;
    const compactionWaiting = yield* Deferred.make<void>();
    const intake = yield* KeyedLock.make<ThreadId>();
    const sent: Array<Fiber.Fiber<void>> = [];
    const store_ = yield* makeClaudeThreadAccountStore(path.join(root, "accounts.json"));
    const accounts = options.forgetDies
      ? { ...store_, forget: () => Effect.die("the store is gone") }
      : store_;
    yield* accounts.check(
      threadId,
      claudeAccountIdentity({ email: "personal@example.com", tokenSource: "claude.ai" }),
    );
    const projection = (): ClaudeAccountMoveThread => ({
      thread: {
        modelSelection: { instanceId: selected, model },
        activeProviderThreadId: providerThreadId,
      },
      runs: runStatus === undefined ? [] : [{ status: runStatus }],
      providerThreads: [
        {
          id: providerThreadId,
          nativeThreadRef: { driver: claude, nativeId, strength: "strong" },
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
          isHeld() ? Effect.fail(inUse(input.providerThreadId)) : Effect.void,
        checkNativeThreadReleased: (input: { readonly providerThreadId: ProviderThreadId }) =>
          isHeld() || options.ownProcessLingers === true
            ? Effect.fail(inUse(input.providerThreadId))
            : Effect.void,
        whileNativeThreadFenced: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
          moveFence.whileMoving(
            id,
            Effect.suspend(() => {
              if (options.runningAtFence === true) runStatus = "running";
              return effect;
            }),
          ),
      },
    });
    let compactMessage: MessageId | undefined;
    const deps: ClaudeAccountMoveDependencies = {
      orchestration: {
        getThreadProjection: () => Effect.sync(projection),
        holdThreadMessages: (id, effect) => intake.withLock(id, effect),
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
              model = command.modelSelection.model;
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
          model = options.modelDuringCompaction ?? model;
          nativeId = options.sessionDuringCompaction ?? nativeId;
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
          // A message sent now waits for the move, the way the orchestrator's intake holds it.
          if (options.messageDuringRelease === true)
            sent.push(
              yield* Effect.forkDetach(
                intake.withLock(
                  threadId,
                  Effect.sync(() => {
                    commands.push(`message-accepted-on:${selected}`);
                  }),
                ),
              ),
            );
          if (options.afterRelease !== undefined) yield* options.afterRelease(moveFence);
          model = options.modelAfterRelease ?? model;
        }),
      canLinkFiles: options.cannotLink !== true,
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
              : instanceId === third
                ? store(third_, "claude:store:third", () => false)
                : undefined,
        ),
      accounts,
    };
    const move = (compact = true, targetInstanceId = work) =>
      moveClaudeThreads(deps, { threadIds: [threadId], targetInstanceId, compact });
    const messagesDelivered = Effect.forEach(sent, Fiber.join, { discard: true });
    return {
      fileSystem,
      path,
      source,
      target,
      commands,
      compactionWaiting,
      accounts,
      move,
      messagesDelivered,
      moveFence,
      third: third_,
      deps,
      selected: () => selected,
      model: () => model,
      setModel: (next: string) => {
        model = next;
      },
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

it.effect("a message sent during the move waits, then goes to the new account", () =>
  Effect.gen(function* () {
    const h = yield* harness({ messageDuringRelease: true });
    assert.strictEqual((yield* h.move(false)).outcomes[0]?.status, "moved");
    yield* h.messagesDelivered;
    assert.deepEqual(h.commands, [
      "provider-session.detach",
      "release",
      "thread.model-selection.set",
      `message-accepted-on:${work}`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moves nothing while T3 Code's own process for the thread has not exited", () =>
  Effect.gen(function* () {
    const h = yield* harness({ ownProcessLingers: true });
    const outcome = (yield* h.move(false)).outcomes[0];
    assert.strictEqual(outcome?.status, "held");
    assert.include(outcome?.detail, "has not exited");
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcriptPath)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses a move between stores where files cannot be linked, changing nothing", () =>
  Effect.gen(function* () {
    const h = yield* harness({ cannotLink: true });
    const outcome = (yield* h.move(false)).outcomes[0];
    assert.strictEqual(outcome?.status, "unsupported");
    assert.strictEqual(h.selected(), personal);
    assert.deepEqual(h.commands, []);
    const shared = yield* harness({ cannotLink: true, sharedStore: true });
    assert.strictEqual((yield* shared.move(false)).outcomes[0]?.status, "moved");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a thread that moved still reports moved when its account record cannot be dropped", () =>
  Effect.gen(function* () {
    const h = yield* harness({ forgetDies: true });
    const { outcomes } = yield* h.move(false);
    assert.deepEqual(outcomes, [{ threadId, status: "moved", copied: true }]);
    assert.strictEqual(h.selected(), work);
    const leftovers = (yield* h.fileSystem.readDirectory(h.source, { recursive: true })).filter(
      (entry) => entry.includes(".t3-move"),
    );
    assert.deepEqual(leftovers, []);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("reads compaction runs from the event stream that never drops", () =>
  Effect.gen(function* () {
    const reads: Array<unknown> = [];
    const orchestration = claudeAccountMoveOrchestration({
      getThreadProjection: () => Effect.die("unused"),
      dispatch: () => Effect.die("unused"),
      holdThreadMessages: (_id, effect) => effect,
      streamStoredEventsFrom: (input) => {
        reads.push(input);
        return Stream.empty;
      },
    });
    yield* Stream.runDrain(orchestration.runUpdates({ threadId, afterSequence: 4 }));
    assert.deepEqual(reads, [{ threadId, afterSequence: 4, internal: true }]);
  }),
);

it.effect(
  "keeps a model chosen while the old account compacted, and moves to the new account",
  () =>
    Effect.gen(function* () {
      const h = yield* harness({ modelDuringCompaction: "claude-other" });
      assert.strictEqual((yield* h.move()).outcomes[0]?.status, "moved");
      assert.strictEqual(h.selected(), work);
      assert.strictEqual(h.model(), "claude-other");
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a second move that waited for the first leaves the thread where the first put it", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const h = yield* harness({
      afterRelease: () =>
        Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    });
    // The first move to work holds the thread while a second move, read when it was still on
    // personal, waits to move it to a third account.
    const first = yield* Effect.forkChild(h.move(false, work));
    yield* Deferred.await(reached);
    const second = yield* Effect.forkChild(h.move(false, third));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(finish, undefined);
    assert.strictEqual((yield* Fiber.join(first)).outcomes[0]?.status, "moved");
    const { outcomes } = yield* Fiber.join(second);
    assert.strictEqual(outcomes[0]?.status, "busy");
    assert.include(outcomes[0]?.detail, "changed account");
    assert.strictEqual(h.selected(), work);
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.third, transcriptPath)));
    assert.isFalse(yield* isLink(h.fileSystem, h.path.join(h.target, transcriptPath)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("moves nothing while a Claude process is starting on the session by another route", () =>
  Effect.gen(function* () {
    const h = yield* harness({});
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    // A retried or requeued run reaches the session through the send gate, not the intake.
    const start = yield* Effect.forkChild(
      h.moveFence.unlessMoving(
        session,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ),
    );
    yield* Deferred.await(started);
    const outcome = (yield* h.move(false)).outcomes[0];
    assert.strictEqual(outcome?.status, "busy");
    assert.include(outcome?.detail, "turn is starting");
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcriptPath)));
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(start);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a start by any route while the files move is refused, not run on the old account", () =>
  Effect.gen(function* () {
    const refusedDuringMove: Array<string> = [];
    const h = yield* harness({
      afterRelease: (fence) =>
        fence.unlessMoving(session, Effect.void).pipe(
          Effect.map((ran) => {
            if (Option.isNone(ran)) refusedDuringMove.push("refused");
          }),
        ),
    });
    assert.strictEqual((yield* h.move(false)).outcomes[0]?.status, "moved");
    assert.deepEqual(refusedDuringMove, ["refused"]);
    assert.isTrue(Option.isSome(yield* h.moveFence.unlessMoving(session, Effect.void)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("leaves a thread whose session changed while the old account compacted", () =>
  Effect.gen(function* () {
    const h = yield* harness({ sessionDuringCompaction: "22222222-3333-4444-5555-666666666666" });
    const outcome = (yield* h.move()).outcomes[0];
    assert.strictEqual(outcome?.status, "busy");
    assert.include(outcome?.detail, "changed account or session");
    assert.strictEqual(h.selected(), personal);
    assert.isFalse(yield* h.fileSystem.exists(h.path.join(h.target, transcriptPath)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("keeps a model chosen while the files moved", () =>
  Effect.gen(function* () {
    const h = yield* harness({ modelAfterRelease: "claude-during-copy" });
    assert.strictEqual((yield* h.move(false)).outcomes[0]?.status, "moved");
    assert.strictEqual(h.selected(), work);
    assert.strictEqual(h.model(), "claude-during-copy");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses a run that started just before the fence without tearing down its session", () =>
  Effect.gen(function* () {
    const h = yield* harness({ runningAtFence: true });
    assert.strictEqual((yield* h.move(false)).outcomes[0]?.status, "busy");
    assert.notInclude(h.commands, "provider-session.detach");
    assert.strictEqual(h.selected(), personal);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
