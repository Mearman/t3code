import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  PROVIDER_THREAD_IN_USE_FAILURE_CODE,
  PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE,
} from "@t3tools/provider-core/client";
import * as DateTime from "effect/DateTime";

import { planHeldSessionFork } from "./ClaudeHeldSessionForkReactor.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const at = DateTime.makeUnsafe("2026-11-27T12:00:00.000Z");

const run = (ordinal: number, fields: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make(`run:${ordinal}`),
  threadId: ThreadId.make("thread:held"),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-haiku-4-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${ordinal}`),
  rootNodeId: NodeId.make(`node:${ordinal}`),
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});

const refusalOf = (refused: OrchestrationV2Run, code: string) => ({
  id: `item:${refused.id}`,
  type: "error",
  status: "failed",
  runId: refused.id,
  nodeId: refused.rootNodeId,
  ordinal: 1,
  updatedAt: at,
  failure: { code },
});

const projectionOf = (input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly code: string;
  readonly attachments?: ReadonlyArray<unknown>;
}) => {
  const refused = input.runs.at(-1);
  if (refused === undefined) throw new Error("a projection needs a refused run");
  // The plan reads only these fields of each record.
  return {
    refused,
    projection: {
      runs: input.runs,
      attempts: [],
      providerTurns: [],
      turnItems: [refusalOf(refused, input.code)],
      messages: [
        { id: refused.userMessageId, text: "hello", attachments: input.attachments ?? [] },
      ],
    } as never,
  };
};

it("forks from the run before a refused send that chose to fork, and resends its text", () => {
  const { projection, refused } = projectionOf({
    runs: [run(1), run(2, { status: "failed" }), run(3), run(4, { status: "failed" })],
    code: PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE,
  });

  assert.deepStrictEqual(planHeldSessionFork(projection, refused), {
    type: "fork_and_send",
    sourceRunId: RunId.make("run:3"),
    text: "hello",
  });
});

it("forks from the refused run itself when its message carries attachments or nothing precedes it", () => {
  const attached = projectionOf({
    runs: [run(1), run(2, { status: "failed" })],
    code: PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE,
    attachments: [{ type: "image" }],
  });
  const first = projectionOf({
    runs: [run(1, { status: "failed" })],
    code: PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE,
  });

  assert.deepStrictEqual(planHeldSessionFork(attached.projection, attached.refused), {
    type: "fork_only",
    sourceRunId: RunId.make("run:2"),
  });
  assert.deepStrictEqual(planHeldSessionFork(first.projection, first.refused), {
    type: "fork_only",
    sourceRunId: RunId.make("run:1"),
  });
});

it("leaves a refusal that asked, and any other failure, to the person", () => {
  for (const code of [PROVIDER_THREAD_IN_USE_FAILURE_CODE, "provider_error"]) {
    const { projection, refused } = projectionOf({
      runs: [run(1), run(2, { status: "failed" })],
      code,
    });
    assert.strictEqual(planHeldSessionFork(projection, refused), undefined);
  }
});
