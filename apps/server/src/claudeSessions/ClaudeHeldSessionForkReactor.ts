import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { PROVIDER_THREAD_IN_USE_FORK_FAILURE_CODE } from "@t3tools/provider-core/client";
import { unsentManualContinuationSource } from "@t3tools/shared/orchestrationV2ManualContinuation";
import {
  latestRootProviderFailure,
  runsByOrigin,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
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
 * How a send refused for a holder, whose choice was to fork, continues: fork from the run before it and send its text there. A message with attachments, which only a fresh upload can carry, or one with no run before it is forked from the refused run, whose recorded message the fork carries.
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

export class ClaudeHeldSessionForkReactor extends Context.Service<
  ClaudeHeldSessionForkReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/claudeSessions/ClaudeHeldSessionForkReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const handle: ClaudeHeldSessionForkReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || event.payload.status !== "failed") return;
      const projection = yield* projections.getThreadRecords(event.threadId, [
        "runs",
        "attempts",
        "providerTurns",
        "turnItems",
        "messages",
      ]);
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
      const plan = planHeldSessionFork(projection, event.payload);
      if (plan === undefined) return;
      // Ids follow the refused run, so a replayed event repeats commands the engine already has.
      const key = `${event.threadId}:${event.payload.id}`;
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
          Effect.logWarning("continuing a held Claude session's send in a fork failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: ClaudeHeldSessionForkReactor["Service"]["start"] = Effect.fn(
    "ClaudeHeldSessionForkReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("held Claude session fork event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies ClaudeHeldSessionForkReactor["Service"];
});

export const layer = Layer.effect(ClaudeHeldSessionForkReactor, make);
