import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  latestExecutedRun,
  latestT3ExecutedRun,
  orchestrationV2WorktreePending,
  runsByOrigin,
  usageLimitBlockedRun,
  usageLimitRunPresentedAsLatest,
} from "./orchestrationV2ThreadError.ts";

const threadId = ThreadId.make("thread:t3-executed");
const instanceId = ProviderInstanceId.make("claudeAgent");
const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 26, 12, minutes));

const run = (ordinal: number, fields: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${ordinal}`),
  rootNodeId: NodeId.make(`node:${ordinal}`),
  activeAttemptId: null,
  status: "completed",
  requestedAt: at(ordinal * 2),
  startedAt: at(ordinal * 2),
  completedAt: at(ordinal * 2 + 1),
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});
const transcript = (ordinal: number, fields: Partial<OrchestrationV2Run> = {}) =>
  run(ordinal, {
    nativeOrigin: {
      kind: "claude_transcript",
      nativeSessionId: "session-1",
      promptUuid: `prompt:${ordinal}`,
    },
    ...fields,
  });
const limitItem = (limited: OrchestrationV2Run): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`error:${limited.ordinal}`),
  threadId,
  runId: limited.id,
  nodeId: limited.rootNodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "failed",
  title: "Usage limit reached",
  startedAt: limited.completedAt,
  completedAt: limited.completedAt,
  updatedAt: limited.completedAt!,
  type: "error",
  failure: {
    class: "usage_limit",
    message: "Plan limit reached.",
    resetAt: "2099-01-01T00:00:00.000Z",
    code: "usageLimitExceeded",
    retryable: null,
  },
});

describe("latestT3ExecutedRun", () => {
  it("skips runs read back from a transcript, which presentation still shows", () => {
    const runs = [run(1, { status: "interrupted" }), transcript(2)];
    expect(latestExecutedRun(runs)?.ordinal).toBe(2);
    expect(latestT3ExecutedRun(runs)?.ordinal).toBe(1);
    expect(latestT3ExecutedRun([transcript(1)])).toBeNull();
  });

  it("drops a transcript run's object even through a run type without the field", () => {
    const shown: ReadonlyArray<{ readonly id: string }> = [run(1), transcript(2)];
    expect(runsByOrigin(shown, "t3").map((entry) => entry.id)).toEqual([run(1).id]);
    expect(runsByOrigin(shown, "any")).toBe(shown);
  });

  it("never treats a transcript run's limit as blocking T3", () => {
    const limited = transcript(2, { status: "failed" });
    expect(usageLimitBlockedRun([run(1), limited], [limitItem(limited)], null)).toBeNull();
  });

  it("keeps T3's own limit for the queue but stops presenting it once the session went on", () => {
    const limited = run(1, { status: "failed" });
    const items = [limitItem(limited)];
    const queued = run(3, { status: "queued", startedAt: null, completedAt: null });
    expect(usageLimitBlockedRun([limited, transcript(2)], items, null)?.id).toBe(limited.id);
    expect(usageLimitRunPresentedAsLatest([limited, queued], items, null)?.id).toBe(limited.id);
    expect(
      usageLimitRunPresentedAsLatest([limited, transcript(2), queued], items, null),
    ).toBeNull();
  });

  it("keeps a failed worktree setup pending past a transcript run", () => {
    const failedSetup = run(1, {
      status: "failed",
      startedAt: null,
      workspacePreparation: { type: "worktree", baseRef: "main" },
    });
    expect(orchestrationV2WorktreePending(null, [failedSetup, transcript(2)])).toBe(true);
  });
});
