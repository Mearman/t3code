import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  ProviderDriverKind,
  ProviderSetupError,
  type ClaudeThreadMoveInput,
  type ClaudeThreadMoveOutcome,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  CLAUDE_MOVE_LINKS_ORIGINALS,
  claudeTranscriptEndsCompacted,
  copyClaudeSession,
  listClaudeSessionFiles,
  locateClaudeTranscript,
} from "./ClaudeSessionFiles.ts";
import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
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
  /** Run states of `threadId` recorded after `afterSequence`, oldest first. */
  readonly runUpdates: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
  }) => Stream.Stream<
    { readonly userMessageId: MessageId; readonly status: OrchestrationV2RunStatus },
    OrchestratorV2Error
  >;
}

export interface ClaudeAccountMoveDependencies {
  readonly orchestration: ClaudeAccountMoveOrchestration;
  /** Top-level threads, active or archived, whose selection is `instanceId`. */
  readonly listThreads: (
    instanceId: ClaudeThreadMoveInput["targetInstanceId"],
  ) => Effect.Effect<ReadonlyArray<ThreadId>, OrchestratorV2Error>;
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
    );
  return Option.isSome(ended) && ended.value.status === "completed";
});

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
  const fileSystem = yield* FileSystem.FileSystem;
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
  if (projection.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)))
    return outcome("busy", { detail: "The thread is working. Move it once it has finished." });

  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  const nativeId = providerThread?.nativeThreadRef?.nativeId ?? undefined;
  const sameStore =
    source.continuationIdentity.continuationKey === target.continuationIdentity.continuationKey;
  let copied = false;
  if (providerThread !== undefined && nativeId !== undefined) {
    const free = yield* Effect.result(
      source.nativeThreadStore.checkNativeThreadFree({
        providerThreadId: providerThread.id,
        nativeId,
      }),
    );
    if (free._tag === "Failure") return outcome("held", { detail: free.failure.detail });
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
    }
    if (!sameStore) {
      // A live process may still write the session; release it before its files move.
      const current = yield* deps.orchestration.getThreadProjection(threadId);
      for (const session of current.providerSessions) {
        if (session.providerInstanceId !== sourceId || session.status === "stopped") continue;
        yield* deps.orchestration.dispatch({
          type: "provider-session.detach",
          commandId: CommandId.make(`server:account-move-detach:${yield* random.uuidV4()}`),
          threadId,
          providerSessionId: session.id,
          reason: "account-move",
        });
      }
      const files = yield* listClaudeSessionFiles(
        source.nativeThreadStore.root,
        projectDir,
        nativeId,
      );
      const result = yield* Effect.result(
        copyClaudeSession({
          source: source.nativeThreadStore.root,
          target: target.nativeThreadStore.root,
          files,
          linkOriginals: CLAUDE_MOVE_LINKS_ORIGINALS,
        }),
      );
      if (result._tag === "Failure")
        return outcome("copyFailed", { detail: describeFailure(result.failure) });
      copied = yield* fileSystem.exists(
        path.join(target.nativeThreadStore.root, "projects", projectDir, `${nativeId}.jsonl`),
      );
    }
  }
  yield* deps.orchestration.dispatch({
    type: "thread.model-selection.set",
    commandId: CommandId.make(`server:account-move:${yield* random.uuidV4()}`),
    threadId,
    modelSelection: { ...thread.modelSelection, instanceId: input.targetInstanceId },
  });
  // The user confirmed the new account by moving, so its next send records that account.
  yield* deps.accounts.forget(threadId);
  return outcome("moved", copied ? { copied } : {});
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
  const threadIds =
    "threadIds" in input.selection
      ? input.selection.threadIds
      : yield* deps.listThreads(input.selection.fromInstanceId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId: input.targetInstanceId,
                operation: "moveThreads",
                detail: "Could not list that account's threads.",
                cause,
              }),
          ),
        );
  for (const threadId of threadIds) {
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
