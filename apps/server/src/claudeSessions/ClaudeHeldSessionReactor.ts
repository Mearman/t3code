import {
  type OrchestrationV2Command,
  CommandId,
  isDeliveredProviderTurn,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  isHeldRefusalCode,
  PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE,
  PROVIDER_THREAD_IN_USE_SEND_FAILURE_CODE,
} from "@t3tools/provider-core/client";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { claudeSecondWriterNoticeId } from "@t3tools/shared/claudeSyncNotice";
import { unsentManualContinuationSource } from "@t3tools/shared/orchestrationV2ManualContinuation";
import {
  latestRootProviderFailure,
  runsByOrigin,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { ClaudeBridge, type ClaudeBridgeFailure } from "./ClaudeBridge.ts";
import { ClaudeSecondWriterRuns } from "./ClaudeSecondWriterRuns.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type ForkPlan =
  | {
      readonly type: "fork_and_send";
      readonly sourceRunId: OrchestrationV2Run["id"];
      readonly text: string;
    }
  | { readonly type: "fork_only"; readonly sourceRunId: OrchestrationV2Run["id"] };

/**
 * How a send refused for a holder, whose choice was to fork, continues: fork from the run before it
 * and send its text there. A message with attachments, which only a fresh upload can carry, or one
 * with no run before it is forked from the refused run, whose recorded message the fork carries.
 */
export function planHeldSessionFork(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns" | "turnItems" | "messages"
  >,
  refused: OrchestrationV2Run,
): ForkPlan | undefined {
  if (
    latestRootProviderFailure(refused, projection.turnItems)?.code !==
    PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE
  ) {
    return undefined;
  }
  const source = unsentManualContinuationSource(refused, projection) ?? refused;
  const message = projection.messages.find((candidate) => candidate.id === source.userMessageId);
  // A terminal's turns are the conversation too, so the fork may start after one.
  const before = runsByOrigin(projection.runs, "any")
    .filter((run) => run.status === "completed" && run.ordinal < source.ordinal)
    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
  if (message === undefined || message.attachments.length > 0 || before === undefined) {
    return { type: "fork_only", sourceRunId: refused.id };
  }
  return { type: "fork_and_send", sourceRunId: before.id, text: message.text };
}

/**
 * Whether `run` went beside a holder: it resent a refusal with the `send` choice, the gate saw a
 * holder when it let the run through (`sawHolder`), and its prompt reached Claude, so the holder's
 * next prompt continues from before its reply.
 */
export function wentBesideHolder(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns" | "turnItems"
  >,
  run: OrchestrationV2Run,
  sawHolder: boolean,
): boolean {
  if (!sawHolder || run.heldSessionSend !== "send" || run.manualContinuationOfRunId === undefined) {
    return false;
  }
  const continued = projection.runs.find(
    (candidate) => candidate.id === run.manualContinuationOfRunId,
  );
  if (
    continued === undefined ||
    !isHeldRefusalCode(latestRootProviderFailure(continued, projection.turnItems)?.code)
  ) {
    return false;
  }
  const attempts = new Set(
    projection.attempts.filter((attempt) => attempt.runId === run.id).map((attempt) => attempt.id),
  );
  return projection.providerTurns.some(
    (turn) =>
      turn.runAttemptId !== null &&
      attempts.has(turn.runAttemptId) &&
      isDeliveredProviderTurn(turn),
  );
}

/**
 * The resend of a send refused so its warning shows first. Its ids follow the refused run, so a
 * replayed event repeats a command the engine already has, and it carries the access the person's
 * own send had, since the server, not the person, dispatches it.
 */
export function heldSessionSendResend(run: OrchestrationV2Run) {
  const key = `${run.threadId}:${run.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`server:held-session-send:${key}`),
    threadId: run.threadId,
    messageId: MessageId.make(`message:held-session-send:${key}`),
    manualContinuationOfRunId: run.id,
    heldSessionSend: "send",
    ...(run.heldSessionTerminalAccess === true ? { heldSessionTerminalAccess: true as const } : {}),
    text: "",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  } satisfies OrchestrationV2Command;
}

// The note follows every item a run's reply adds, whose ordinals count up from zero.
const AFTER_THE_REPLY_ORDINAL = 1_000_000_000;

export class ClaudeHeldSessionReactor extends Context.Service<
  ClaudeHeldSessionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/claudeSessions/ClaudeHeldSessionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const secondWriters = yield* ClaudeSecondWriterRuns;
  const bridge = yield* ClaudeBridge;

  // Says, after the reply, that the session now branches, once per run.
  const noteSecondWriter = Effect.fnUntraced(function* (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "turnItems">,
    run: OrchestrationV2Run,
  ) {
    const id = TurnItemId.make(claudeSecondWriterNoticeId(run.id));
    if (projection.turnItems.some((item) => item.id === id)) return;
    const at = run.completedAt ?? run.startedAt ?? run.requestedAt;
    const message =
      "Sent beside another Claude Code process that has this session open. Its next prompt continues from before this reply, so `claude --resume` follows one side of the branch; fork or take over to keep one line.";
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          occurredAt: at,
          payload: {
            id,
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: AFTER_THE_REPLY_ORDINAL,
            status: "completed",
            title: message,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "system_notice",
            message,
            level: "warning",
          },
        },
      ],
    });
  });

  // Tells the thread that a prompt handed to the bridge never reached the terminal's claude.
  const noteBridgeFailure = Effect.fnUntraced(function* (failure: ClaudeBridgeFailure) {
    const threadId = ThreadId.make(failure.threadId);
    const { thread, runs, turnItems } = yield* projections.getThreadRecords(threadId, [
      "runs",
      "turnItems",
    ]);
    const id = TurnItemId.make(`x:bridge-failed:${failure.runId}`);
    if (turnItems.some((item) => item.id === id)) return;
    const run = runs.find((candidate) => candidate.id === failure.runId);
    const at = yield* DateTime.now;
    const message = `The message handed to the terminal's claude did not reach it: ${failure.reason}. Send it again, or fork.`;
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: thread.id }),
          type: "turn-item.updated",
          threadId: thread.id,
          occurredAt: at,
          payload: {
            id,
            threadId: thread.id,
            runId: run?.id ?? null,
            nodeId: run?.rootNodeId ?? null,
            providerThreadId: run?.providerThreadId ?? null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: AFTER_THE_REPLY_ORDINAL,
            status: "failed",
            title: message,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "system_notice",
            message,
            level: "warning",
          },
        },
      ],
    });
  });

  const handle: ClaudeHeldSessionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      const run = event.payload;
      const settled = run.status === "completed" || run.status === "interrupted";
      if (run.status !== "failed" && !(settled && run.heldSessionSend === "send")) return;
      const projection = yield* projections.getThreadRecords(event.threadId, [
        "runs",
        "attempts",
        "providerTurns",
        "turnItems",
        "messages",
      ]);
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
      const sawHolder = run.heldSessionSend === "send" ? yield* secondWriters.take(run.id) : false;
      if (wentBesideHolder(projection, run, sawHolder)) {
        yield* noteSecondWriter(projection, run);
        return;
      }
      // Ids follow the refused run, so a replayed event repeats commands the engine already has.
      const key = `${event.threadId}:${run.id}`;
      if (
        latestRootProviderFailure(run, projection.turnItems)?.code ===
        PROVIDER_THREAD_IN_USE_SEND_FAILURE_CODE
      ) {
        yield* engine.dispatch(heldSessionSendResend(run));
        return;
      }
      const plan = planHeldSessionFork(projection, run);
      if (plan === undefined) return;
      const targetThreadId = ThreadId.make(`thread:held-session-fork:${key}`);
      yield* engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`server:held-session-fork:${key}`),
        createdBy: "user",
        creationSource: "server",
        sourceThreadId: event.threadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: plan.sourceRunId },
      });
      if (plan.type === "fork_only") return;
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:held-session-fork-send:${key}`),
        threadId: targetThreadId,
        messageId: MessageId.make(`message:held-session-fork:${key}`),
        text: plan.text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("continuing a held Claude session's send failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ClaudeHeldSessionReactor["Service"]["start"] = Effect.fn(
    "ClaudeHeldSessionReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("held Claude session event stream failed", { cause }),
        ),
      ),
    );
    yield* forkParked(
      Effect.forever(
        Queue.take(bridge.failures).pipe(
          Effect.flatMap(noteBridgeFailure),
          Effect.catchCause((cause) =>
            Effect.logWarning("noting a Claude bridge delivery failure failed", { cause }),
          ),
        ),
      ),
    );
  });

  return { start, handle } satisfies ClaudeHeldSessionReactor["Service"];
});

export const layer = Layer.effect(ClaudeHeldSessionReactor, make);
