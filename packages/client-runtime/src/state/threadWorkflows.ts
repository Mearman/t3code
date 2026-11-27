import {
  type ClaudeHeldSessionSend,
  type ChatAttachment,
  isCompactionCommandMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type RunId,
} from "@t3tools/contracts";
import {
  isHeldRefusalCode,
  PROVIDER_THREAD_IN_USE_FAILURE_CODE,
  CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE,
} from "@t3tools/provider-core/client";
import {
  latestRootProviderFailure,
  latestT3ExecutedRun,
  runsByOrigin,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { copySorted } from "@t3tools/shared/Array";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { compactionBlocksSteering } from "./composerDispatch.ts";
import type { ThreadStructure } from "./models.ts";

type Projection = ThreadStructure;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
  /** Carries the attribution a sent message shows: automation, agent sender, or guest. */
  readonly message?: Message;
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canPromoteToSteer: boolean;
  /** The active run is a compaction, so promoting a queued message stops it instead of steering. */
  readonly promoteSkipsCompaction: boolean;
  readonly canSendNow: boolean;
}

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return (
    runsByOrigin(projection.runs, "t3").findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ??
    null
  );
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  // Merge-back carries the conversation back, transcript turns included.
  const conversationRuns = runsByOrigin(projection.runs, "any");
  const latestProviderFinishedRun = conversationRuns.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = conversationRuns.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSteersDuringCompaction(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  return (
    resolveThreadProviderSession(projection)?.capabilities.turns.activeSteeringDuringCompaction ===
    true
  );
}

function supportsSteering(turns: OrchestrationV2ProviderCapabilities["turns"]): boolean {
  return (
    turns.supportsActiveSteering ||
    (turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart)
  );
}

/** The server rejects a steer into a run that Stop has reached, though the run still reads as running. */
export function runStopRequested(
  projection: Pick<Projection, "turnItems"> | null | undefined,
  runId: Run["id"] | null | undefined,
): boolean {
  if (projection == null || runId == null) return false;
  return projection.turnItems.some(
    (item) => item.runId === runId && item.type === "run_interrupt_request",
  );
}

export function threadCanSteer(
  projection: Projection | null,
  input: {
    readonly compactCommandIsActive: boolean;
    readonly compactionRunning: boolean;
    readonly activeRunId: Run["id"] | null | undefined;
  },
): boolean {
  const turns = projection && resolveThreadProviderSession(projection)?.capabilities.turns;
  // A steer submitted before the session attaches can wait for its provider turn.
  if (turns && !supportsSteering(turns)) return false;
  if (runStopRequested(projection, input.activeRunId)) return false;
  return !compactionBlocksSteering({
    compactCommandIsActive: input.compactCommandIsActive,
    compactionRunning: input.compactionRunning,
    steersDuringCompaction: turns?.activeSteeringDuringCompaction === true,
    run: projection?.runs.find((run) => run.id === input.activeRunId),
    messages: projection?.messages,
  });
}

export function threadSupportsProviderHandoff(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;

  // Detaching a stopped session removes it from the projection. The server still
  // hands off from saved app history, which needs the source provider thread but
  // not its native ref.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
}

export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  if (!projection.runs.some((run) => run.status === "queued")) return [];

  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

export function deriveThreadQueueWorkflowState(
  projection: Projection,
  resolve: MFunctionType = mFallback,
): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const canSteer = capabilities !== undefined && supportsSteering(capabilities);
  const activeMessage = projection.messages.find(
    (message) => message.id === activeRun?.userMessageId,
  );
  const promoteSkipsCompaction =
    activeMessage !== undefined && isCompactionCommandMessage(activeMessage);
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      // A queued guest message shows the guest's words; the agent still gets the attributed text.
      text: message?.context?.guest?.text ?? message?.text ?? resolve(msg("Queued message")),
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
      ...(message ? { message } : {}),
    };
  });

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canSendNow:
      activeRun === null &&
      projection.thread.archivedAt == null &&
      projection.thread.deletedAt == null,
    canPromoteToSteer:
      promoteSkipsCompaction ||
      ((activeRun?.status === "preparing" || activeRun?.status === "starting") &&
        (capabilities === undefined || canSteer)) ||
      (hasSteerableProviderTurn && canSteer),
    promoteSkipsCompaction,
  };
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  if (input.capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const capabilities = input.capabilities;
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

/**
 * Whether a failure is a refusal because another process was seen holding the session, including
 * one the server continues in a fork or beside the holder; its fork button stays a way out.
 */
export function isHeldSessionFailure(failure: Pick<OrchestrationV2ProviderFailure, "code">) {
  return isHeldRefusalCode(failure.code);
}

/**
 * Whether this client can offer the confirm button: the server serves the confirm request and the
 * connection may operate threads. Without it, sending again is how the user confirms.
 */
export function canConfirmThreadAccount(input: {
  readonly serverConfirms: boolean;
  readonly permitted: boolean;
}) {
  return input.serverConfirms && input.permitted;
}

/**
 * Whether an error row offers to confirm a changed Claude account: only on the thread's own row,
 * since a confirmation applies to this thread.
 */
export function offersThreadAccountConfirm(row: {
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly item: { readonly failure: Pick<OrchestrationV2ProviderFailure, "code"> };
}) {
  return (
    row.visibility === "local" &&
    row.item.failure.code === CLAUDE_THREAD_ACCOUNT_CHANGED_FAILURE_CODE
  );
}

/**
 * The run an error row's held-session fork starts from: the row's own refused run, offered only
 * on a row of the thread itself, never one inherited from a fork source.
 */
export function heldSessionForkRunId(row: {
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly item: {
    readonly runId: RunId | null;
    readonly failure: Pick<OrchestrationV2ProviderFailure, "code">;
  };
}): RunId | undefined {
  return row.visibility === "local" &&
    row.item.runId !== null &&
    isHeldSessionFailure(row.item.failure)
    ? row.item.runId
    : undefined;
}

/**
 * This thread's runs refused because another process was seen holding its session, sorted. A
 * fork offered on one starts from it: a failed run is never forked natively, so the fork carries
 * what T3 Code recorded, the refused message included, and nothing only the other process wrote.
 */
export function heldSessionRefusedRunIds(
  projection: Pick<Projection, "thread" | "turnItems">,
): ReadonlyArray<RunId> {
  const refused = new Set<RunId>();
  for (const item of projection.turnItems) {
    if (
      item.type === "error" &&
      item.threadId === projection.thread.id &&
      item.runId !== null &&
      isHeldSessionFailure(item.failure)
    ) {
      refused.add(item.runId);
    }
  }
  return [...refused].sort();
}

/**
 * The refused run a send choice can resend: the thread's latest run of its own, refused because a
 * holder was seen. The server resends only that run, and only once a choice is named.
 */
export function heldSessionResendRunId(
  projection: Pick<Projection, "runs" | "turnItems">,
): RunId | undefined {
  const run = latestT3ExecutedRun(projection.runs);
  return run !== null &&
    latestRootProviderFailure(run, projection.turnItems)?.code ===
      PROVIDER_THREAD_IN_USE_FAILURE_CODE
    ? run.id
    : undefined;
}

/** Choices a held session's refused message offers besides a fork; each acts on the terminal. */
export const HELD_SESSION_RESEND_CHOICES = [
  "send",
  "takeOver",
] as const satisfies ReadonlyArray<ClaudeHeldSessionSend>;

/** A send whose permission is the one those choices need: `terminal:operate` as well. */
export const HELD_SESSION_TERMINAL_DISPATCH = {
  type: "message.dispatch",
  heldSessionSend: "takeOver",
} as const;

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
