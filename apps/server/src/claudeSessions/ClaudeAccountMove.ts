import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  isListedThreadLineage,
  MessageId,
  ProviderDriverKind,
  type ClaudeThreadMoveInput,
  type ClaudeThreadMoveOutcome,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CLAUDE_MOVE_LINKS_ORIGINALS,
  claudeTranscriptEndsCompacted,
  ClaudeSessionRollbackError,
  listClaudeSessionParts,
  locateClaudeTranscript,
  moveClaudeSessionParts,
} from "./ClaudeSessionFiles.ts";
import type { OrchestratorV2Error, OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import type { ClaudeThreadAccountStore } from "./ClaudeThreadAccounts.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
// The move request stays open while the old account compacts; past this it gives up, moving
// nothing.
export const CLAUDE_MOVE_COMPACTION_LIMIT = Duration.minutes(30);

/** The parts of a thread projection a move reads. */
export interface ClaudeAccountMoveThread {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "modelSelection" | "activeProviderThreadId"
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2ThreadProjection["runs"][number], "status">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "id" | "nativeThreadRef">
  >;
  readonly providerSessions: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["providerSessions"][number],
      "id" | "providerInstanceId" | "status"
    >
  >;
}

/** What a move needs from orchestration; `Orchestrator` provides it in the server. */
export interface ClaudeAccountMoveOrchestration {
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeAccountMoveThread, OrchestratorV2Error>;
  readonly dispatch: (
    command:
      | {
          readonly type: "message.dispatch";
          readonly commandId: CommandId;
          readonly messageId: MessageId;
          readonly threadId: ThreadId;
          readonly text: string;
          readonly attachments: readonly [];
          readonly createdBy: "user";
          readonly creationSource: "server";
          readonly dispatchMode: { readonly type: "start_immediately" };
        }
      | {
          readonly type: "provider-session.detach";
          readonly commandId: CommandId;
          readonly threadId: ThreadId;
          readonly providerSessionId: OrchestrationV2ThreadProjection["providerSessions"][number]["id"];
          readonly reason: string;
        }
      | {
          readonly type: "thread.model-selection.set";
          readonly commandId: CommandId;
          readonly threadId: ThreadId;
          readonly modelSelection: OrchestrationV2ThreadProjection["thread"]["modelSelection"];
        },
  ) => Effect.Effect<{ readonly sequence: number }, OrchestratorV2Error>;
  /**
   * Runs `effect` while no message can be accepted for `threadId`; runs started any other way
   * are kept off the session by its store's fence instead.
   */
  readonly holdThreadMessages: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Run states of `threadId` recorded after `afterSequence`, oldest first, never dropped. */
  readonly runUpdates: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
  }) => Stream.Stream<
    { readonly userMessageId: MessageId; readonly status: OrchestrationV2RunStatus },
    OrchestratorV2Error
  >;
}

/**
 * The move's orchestration from the server's orchestrator. Run updates come from the internal
 * event stream, which never drops: the RPC subscriber stream may, which would read as a failure.
 */
export const claudeAccountMoveOrchestration = (
  orchestrator: Pick<
    OrchestratorV2Shape,
    "getThreadProjection" | "dispatch" | "holdThreadMessages" | "streamStoredEventsFrom"
  >,
): ClaudeAccountMoveOrchestration => ({
  getThreadProjection: orchestrator.getThreadProjection,
  dispatch: orchestrator.dispatch,
  holdThreadMessages: orchestrator.holdThreadMessages,
  runUpdates: ({ threadId, afterSequence }) =>
    orchestrator
      .streamStoredEventsFrom({ threadId, afterSequence, internal: true })
      .pipe(
        Stream.flatMap(({ event }) =>
          event.type === "run.created" || event.type === "run.updated"
            ? Stream.make(event.payload)
            : Stream.empty,
        ),
      ),
});

/** The top-level threads, active or archived, on `instanceId`: what a whole-account move takes. */
export const listClaudeAccountThreads = Effect.fn("ClaudeAccountMove.listThreads")(function* (
  orchestrator: Pick<OrchestratorV2Shape, "readShellSnapshot">,
  instanceId: ClaudeThreadMoveInput["targetInstanceId"],
) {
  const read = (location: "active" | "archive") =>
    orchestrator.readShellSnapshot({ location }).pipe(Effect.flatten);
  const snapshots = yield* Effect.all([read("active"), read("archive")]);
  return snapshots.flatMap((snapshot) =>
    [...snapshot.threads, ...snapshot.archivedThreads]
      .filter(
        (thread) =>
          thread.modelSelection.instanceId === instanceId && isListedThreadLineage(thread.lineage),
      )
      .map((thread) => thread.id),
  );
});

export interface ClaudeAccountMoveDependencies {
  readonly orchestration: ClaudeAccountMoveOrchestration;
  /** False where a move cannot link a session's files, so a move between stores is refused. */
  readonly canLinkFiles: boolean;
  /** Asks T3 Code's own process for the session to exit; the move then checks that it has. */
  readonly releaseSession: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ThreadProjection["providerSessions"][number]["id"];
  }) => Effect.Effect<void, { readonly message: string }>;
  readonly getInstance: (
    instanceId: ClaudeThreadMoveInput["targetInstanceId"],
  ) => Effect.Effect<
    Pick<ProviderInstance, "driverKind" | "continuationIdentity" | "nativeThreadStore"> | undefined
  >;
  readonly accounts: ClaudeThreadAccountStore;
}

const describeFailure = (cause: { readonly message: string }) => cause.message;

/**
 * Compacts under the current account by sending `/compact` as a T3 Code turn, then waits for that
 * run to end. Succeeds only when it completed.
 */
const compactThread = Effect.fn("ClaudeAccountMove.compact")(function* (
  deps: ClaudeAccountMoveDependencies,
  threadId: ThreadId,
  id: string,
) {
  const messageId = MessageId.make(`account-move-compact:${id}`);
  const { sequence } = yield* deps.orchestration.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`server:account-move-compact:${id}`),
    messageId,
    threadId,
    text: IDLE_COMPACTION_TEXT,
    attachments: [],
    createdBy: "user",
    creationSource: "server",
    dispatchMode: { type: "start_immediately" },
  });
  // The dispatch itself is in the stream, so its run cannot settle before it is read.
  const ended = yield* deps.orchestration
    .runUpdates({ threadId, afterSequence: Math.max(0, sequence - 1) })
    .pipe(
      Stream.filter(
        (run) => run.userMessageId === messageId && TERMINAL_RUN_STATUSES.has(run.status),
      ),
      Stream.runHead,
      Effect.timeoutOption(CLAUDE_MOVE_COMPACTION_LIMIT),
    );
  return (
    Option.isSome(ended) && Option.isSome(ended.value) && ended.value.value.status === "completed"
  );
});

type MoveSource = Pick<ProviderInstance, "nativeThreadStore">;

/** Why the thread cannot move right now, or undefined when nothing stops it. */
const refusal = Effect.fn("ClaudeAccountMove.refusal")(function* (
  projection: ClaudeAccountMoveThread,
  source: MoveSource,
) {
  if (projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))
    return {
      status: "busy",
      detail: "The thread is working. Move it once it has finished.",
    } as const;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  const nativeId = providerThread?.nativeThreadRef?.nativeId ?? undefined;
  if (providerThread === undefined || nativeId === undefined || !source.nativeThreadStore)
    return undefined;
  const free = yield* Effect.result(
    source.nativeThreadStore.checkNativeThreadFree({
      providerThreadId: providerThread.id,
      nativeId,
    }),
  );
  return free._tag === "Failure"
    ? ({ status: "held", detail: free.failure.detail } as const)
    : undefined;
});

const isRollbackError = Schema.is(ClaudeSessionRollbackError);

const moveOne = Effect.fn("ClaudeAccountMove.moveOne")(function* (
  deps: ClaudeAccountMoveDependencies,
  input: ClaudeThreadMoveInput,
  threadId: ThreadId,
) {
  const outcome = (
    status: ClaudeThreadMoveOutcome["status"],
    extra: Omit<ClaudeThreadMoveOutcome, "threadId" | "status"> = {},
  ): ClaudeThreadMoveOutcome => ({ threadId, status, ...extra });
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const projection = yield* deps.orchestration.getThreadProjection(threadId);
  const { thread } = projection;
  const sourceId = thread.modelSelection.instanceId;
  if (sourceId === input.targetInstanceId) return outcome("unchanged");
  const source = yield* deps.getInstance(sourceId);
  const target = yield* deps.getInstance(input.targetInstanceId);
  if (
    source?.driverKind !== CLAUDE_DRIVER ||
    target?.driverKind !== CLAUDE_DRIVER ||
    source.nativeThreadStore === undefined ||
    target.nativeThreadStore === undefined
  )
    return outcome("unsupported", { detail: "Only Claude threads move between Claude accounts." });
  const refused = yield* refusal(projection, source);
  if (refused !== undefined) return outcome(refused.status, { detail: refused.detail });

  const nativeId =
    projection.providerThreads.find((candidate) => candidate.id === thread.activeProviderThreadId)
      ?.nativeThreadRef?.nativeId ?? undefined;
  const sameStore =
    source.continuationIdentity.continuationKey === target.continuationIdentity.continuationKey;
  // The selection is read again inside the hold: one changed meanwhile (a model, an effort, or a
  // move that got there first) is kept, and a thread no longer on the source is left alone.
  // The session is read again too: a rollback can give the thread a new one, which this move
  // has not located or compacted.
  const currentSelection = Effect.gen(function* () {
    const current = yield* deps.orchestration.getThreadProjection(threadId);
    const currentNativeId =
      current.providerThreads.find(
        (candidate) => candidate.id === current.thread.activeProviderThreadId,
      )?.nativeThreadRef?.nativeId ?? undefined;
    return current.thread.modelSelection.instanceId === sourceId && currentNativeId === nativeId
      ? current.thread.modelSelection
      : undefined;
  });
  const movedMeanwhile = outcome("busy", {
    detail:
      "The thread changed account or session while this move waited. " +
      "Move it again if you still want to.",
  });
  const setSelection = Effect.fn("ClaudeAccountMove.setSelection")(function* (
    modelSelection: ClaudeAccountMoveThread["thread"]["modelSelection"],
  ) {
    yield* deps.orchestration.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`server:account-move:${yield* random.uuidV4()}`),
      threadId,
      modelSelection: { ...modelSelection, instanceId: input.targetInstanceId },
    });
  });
  // The user confirmed the new account by moving, so its next send records that account. If the
  // record cannot be dropped the next send asks to confirm it again, so the move still stands.
  const forgetAccount = deps.accounts
    .forget(threadId)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("claude-account-move.forget-account-failed", { threadId, cause }),
      ),
    );
  const switchOnly = Effect.gen(function* () {
    const selection = yield* deps.orchestration.holdThreadMessages(
      threadId,
      currentSelection.pipe(
        Effect.tap((current) => (current === undefined ? Effect.void : setSelection(current))),
      ),
    );
    if (selection === undefined) return movedMeanwhile;
    yield* forgetAccount;
    return outcome("moved");
  });
  if (nativeId === undefined) return yield* switchOnly;
  const projectDir = yield* locateClaudeTranscript(source.nativeThreadStore.root, nativeId);
  if (projectDir === undefined)
    return outcome("missing", {
      detail: "The session's history is not in this account's Claude folder.",
    });
  const transcript = path.join(
    source.nativeThreadStore.root,
    "projects",
    projectDir,
    `${nativeId}.jsonl`,
  );
  if (input.compact && !(yield* claudeTranscriptEndsCompacted(transcript))) {
    const compacted = yield* compactThread(deps, threadId, yield* random.uuidV4()).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!compacted)
      return outcome("compactionFailed", {
        detail: "The old account could not compact the conversation, so nothing moved.",
      });
    // Compaction takes a while; a message or a terminal may have taken the thread meanwhile.
    const after = yield* refusal(yield* deps.orchestration.getThreadProjection(threadId), source);
    if (after !== undefined) return outcome(after.status, { detail: after.detail });
  }
  if (sameStore) return yield* switchOnly;
  if (!deps.canLinkFiles)
    return outcome("unsupported", {
      detail:
        "Moving a thread to an account with its own history needs symbolic links, which this " +
        "computer does not allow.",
    });
  const sourceStore = source.nativeThreadStore;
  const targetStore = target.nativeThreadStore;
  const providerThreadId = thread.activeProviderThreadId;

  // From releasing the session to switching the thread no message is accepted for it, and no
  // Claude process may start on its session by any route (a retry, a requeued steer), so nothing
  // writes to the files while they move.
  const fenced = yield* deps.orchestration.holdThreadMessages(
    threadId,
    sourceStore.whileNativeThreadFenced(
      nativeId,
      Effect.gen(function* () {
        const selection = yield* currentSelection;
        if (selection === undefined) return { refused: movedMeanwhile } as const;
        // A run that started just before the fence is refused before its session is torn down.
        const working = yield* refusal(
          yield* deps.orchestration.getThreadProjection(threadId),
          source,
        );
        if (working !== undefined)
          return { refused: outcome(working.status, { detail: working.detail }) } as const;
        for (const session of (yield* deps.orchestration.getThreadProjection(threadId))
          .providerSessions) {
          if (session.providerInstanceId !== sourceId || session.status === "stopped") continue;
          yield* deps.orchestration.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make(`server:account-move-detach:${yield* random.uuidV4()}`),
            threadId,
            providerSessionId: session.id,
            reason: "account-move",
          });
          yield* deps.releaseSession({ threadId, providerSessionId: session.id });
        }
        const released = yield* refusal(
          yield* deps.orchestration.getThreadProjection(threadId),
          source,
        );
        if (released !== undefined)
          return { refused: outcome(released.status, { detail: released.detail }) } as const;
        // Releasing has a time limit, so a process of T3 Code's own may outlive it.
        if (providerThreadId !== null) {
          const exited = yield* Effect.result(
            sourceStore.checkNativeThreadReleased({ providerThreadId, nativeId }),
          );
          if (exited._tag === "Failure")
            return {
              refused: outcome("held", {
                detail: "T3 Code's Claude process for this thread has not exited yet. Try again.",
              }),
            } as const;
        }
        const parts = yield* listClaudeSessionParts(sourceStore.root, projectDir, nativeId);
        // Moving the files and the selection is one step: either both happen or neither does.
        const files = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const files = yield* Effect.result(
              moveClaudeSessionParts({
                source: sourceStore.root,
                target: targetStore.root,
                parts,
                linkOriginals: CLAUDE_MOVE_LINKS_ORIGINALS,
              }),
            );
            if (files._tag === "Failure") return { files } as const;
            // The selection can change while the files copy (the switch takes neither lock): a
            // new model is kept, and a new account or session means this move puts the files back.
            const latest = yield* Effect.result(currentSelection);
            if (latest._tag === "Failure" || latest.success === undefined) {
              yield* files.success.undo;
              return latest._tag === "Failure"
                ? yield* latest.failure
                : ({ refused: movedMeanwhile } as const);
            }
            const selected = yield* Effect.result(setSelection(latest.success));
            if (selected._tag === "Success") {
              yield* files.success.commit;
              return { files } as const;
            }
            yield* files.success.undo;
            return yield* selected.failure;
          }),
        );
        return files;
      }),
    ),
  );
  if (Option.isNone(fenced))
    return outcome("busy", {
      detail: "A turn is starting on this thread. Move it once the turn has finished.",
    });
  const moved = fenced.value;
  if ("refused" in moved) return moved.refused;
  if (moved.files._tag === "Failure")
    return outcome(isRollbackError(moved.files.failure) ? "failed" : "copyFailed", {
      detail: describeFailure(moved.files.failure),
    });
  yield* forgetAccount;
  return outcome("moved", moved.files.success.copied ? { copied: true } : {});
});

/**
 * Moves each thread to `targetInstanceId`, one at a time. Within one session store the thread
 * resumes natively on its next turn; across stores its session files are copied first. A thread
 * that cannot move is left exactly as it was, with the reason.
 */
export const moveClaudeThreads = Effect.fn("ClaudeAccountMove.move")(function* (
  deps: ClaudeAccountMoveDependencies,
  input: ClaudeThreadMoveInput,
) {
  const outcomes: Array<ClaudeThreadMoveOutcome> = [];
  for (const threadId of input.threadIds) {
    outcomes.push(
      yield* moveOne(deps, input, threadId).pipe(
        Effect.catch((cause) =>
          Effect.succeed<ClaudeThreadMoveOutcome>({
            threadId,
            status: "failed",
            detail: describeFailure(cause),
          }),
        ),
      ),
    );
  }
  return { outcomes };
});
