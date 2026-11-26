import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { latestTerminalResultRun } from "./OrchestratorMcpService.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const at = (minute: number) => DateTime.makeUnsafe(`2026-11-26T12:0${minute}:00.000Z`);
const run = (ordinal: number, fields: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId: ThreadId.make("thread:delegated-child"),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at(ordinal),
  startedAt: at(ordinal),
  completedAt: at(ordinal + 1),
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});

it("reports a delegated child's own result, not a turn its session ran outside T3", () => {
  const result = run(1);
  const transcriptTurn = run(3, {
    nativeOrigin: { kind: "claude_transcript", nativeSessionId: "s-1", promptUuid: "p-1" },
  });

  assert.equal(
    latestTerminalResultRun({ messages: [], runs: [result, transcriptTurn] }, result, undefined)
      ?.id,
    result.id,
  );
});
