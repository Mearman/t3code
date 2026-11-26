import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/** Only error items are read, so callers may pass items stripped of other fields. */
type FailureScanTurnItem =
  | ErrorTurnItem
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "error"> };

export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): OrchestrationV2ProviderFailure | null {
  return latestRootProviderFailureItem(run, turnItems)?.failure ?? null;
}

export function latestRootProviderFailureItem(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): ErrorTurnItem | null {
  if (run?.status !== "failed") return null;
  let latest: ErrorTurnItem | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest;
}

export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass: currentFailure?.class ?? null,
    lastErrorCode: currentFailure?.code ?? null,
  };
}

/**
 * Which runs a selection reads. `"t3"` is the runs T3 executed, for every decision T3 acts on
 * (queue holds and starts, usage limits, resume, Stop, restart continuations, results). `"any"`
 * adds the runs read back from a provider transcript (`nativeOrigin`), for what a thread shows.
 */
export type RunOrigin = "t3" | "any";

/**
 * The runs `origin` reads, in their original order. The `t3code/explicit-run-origin` lint rule
 * requires every run collection that is ordered or searched for a latest run to pass through here.
 */
export function runsByOrigin<Run extends { readonly nativeOrigin?: unknown }>(
  runs: ReadonlyArray<Run>,
  origin: RunOrigin,
): ReadonlyArray<Run> {
  return origin === "any" ? runs : runs.filter((run) => run.nativeOrigin === undefined);
}

/**
 * The run T3 last executed: the latest executed run, ignoring runs read back from a provider
 * transcript. Every decision T3 acts on reads this; presentation reads `latestExecutedRun`.
 */
export function latestT3ExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  return latestExecutedRun(runsByOrigin(runs, "t3"));
}

/**
 * Whether a run read back from a provider transcript stands after run ordinal `appRunOrdinal`. T3
 * has no snapshot of what such a turn changed, so a rewind past it can rewind only the conversation.
 */
export function hasTranscriptRunAfter(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "nativeOrigin" | "ordinal" | "status">>,
  appRunOrdinal: number,
): boolean {
  return runs.some(
    (run) =>
      run.ordinal > appRunOrdinal && run.status !== "rolled_back" && run.nativeOrigin !== undefined,
  );
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Work started now would run in the project checkout, not the worktree the thread asked for. A
 * failed or interrupted setup leaves the request standing until a worktree exists or later work
 * has run past it.
 */
export function orchestrationV2WorktreePending(
  worktreePath: string | null,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  const latest = latestT3ExecutedRun(runs);
  return (
    worktreePath === null &&
    (latest?.status === "preparing" ||
      latest?.status === "failed" ||
      latest?.status === "interrupted") &&
    latest.startedAt === null &&
    latest.workspacePreparation?.type === "worktree"
  );
}

/** Held queues can execute out of ordinal order; unfinished runs count as latest. */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestT3ExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * Retains a limited run's outcome when higher-ordinal runs never started. A transcript run after
 * it shows the session went on outside T3, so the limit is no longer the thread's latest news.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  if (blocked === null) return null;
  const later = runs.filter((run) => run.ordinal > blocked.ordinal);
  return later.length > 0 && later.every((run) => run.nativeOrigin === undefined) ? blocked : null;
}

export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (outlivedBeforeStart(run, runs)) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

// Steering a queued message cancels its run before it starts and hands the message to the
// earlier run, which outlives the cancellation; that earlier run then presents as latest.
function outlivedBeforeStart(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  if (run.status !== "cancelled" || run.startedAt !== null || !run.completedAt) return false;
  const cancelledAt = DateTime.toEpochMillis(run.completedAt);
  return runs.some(
    (earlier) =>
      earlier.ordinal < run.ordinal &&
      earlier.status !== "queued" &&
      (!earlier.completedAt || DateTime.toEpochMillis(earlier.completedAt) >= cancelledAt),
  );
}
