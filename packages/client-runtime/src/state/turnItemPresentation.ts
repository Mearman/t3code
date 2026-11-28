import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import type { ThreadStructureTurnItem } from "./models.ts";

const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

export function turnItemIsWorkspacePreparation(item: OrchestrationV2TurnItem): boolean {
  return (
    (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
    (item.type === "error" &&
      item.status === "cancelled" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE)
  );
}

type RetryableRun = Pick<
  OrchestrationV2Run,
  "id" | "status" | "workspacePreparation" | "providerInstanceId"
>;

/**
 * Whether a run's failed workspace setup can be retried: the server refuses once the thread uses
 * another provider instance than the run recorded, since the run would start on the old one.
 */
export function canRetryWorkspacePreparation(
  run: Omit<RetryableRun, "id">,
  threadInstanceId: OrchestrationV2Run["providerInstanceId"],
): boolean {
  return (
    run.status === "failed" &&
    run.workspacePreparation !== undefined &&
    run.providerInstanceId === threadInstanceId
  );
}

export function workspacePreparationRetryRunIds(
  runs: ReadonlyArray<RetryableRun>,
  items: ReadonlyArray<ThreadStructureTurnItem>,
  threadInstanceId: OrchestrationV2Run["providerInstanceId"],
): ReadonlySet<OrchestrationV2Run["id"]> {
  const failedRuns = new Set(
    runs.flatMap((run) => (canRetryWorkspacePreparation(run, threadInstanceId) ? [run.id] : [])),
  );
  const retryable = new Set<OrchestrationV2Run["id"]>();
  if (failedRuns.size === 0) return retryable;
  for (const item of items) {
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE &&
      item.runId !== null &&
      failedRuns.has(item.runId)
    )
      retryable.add(item.runId);
  }
  return retryable;
}
