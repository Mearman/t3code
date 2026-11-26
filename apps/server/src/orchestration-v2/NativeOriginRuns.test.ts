import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process is needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "native-origin-runs" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("releases an unattended hold only when a run T3 executed ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:native-origin-hold");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-native-origin-hold"),
      threadId,
      projectId: ProjectId.make("project:native-origin"),
      title: "Held behind a transcript run",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const at = (minutes: number) => DateTime.add(now, { minutes });
    const run = (id: string, ordinal: number): OrchestrationV2Run => ({
      id: RunId.make(id),
      threadId,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: at(ordinal * 2),
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    const runEvents = (payload: OrchestrationV2Run): Array<OrchestrationV2DomainEvent> => {
      const base = { threadId, runId: payload.id, providerInstanceId: instanceId, occurredAt: now };
      return [
        {
          ...base,
          id: EventId.make(`event:${payload.id}:created`),
          type: "run.created",
          payload: { ...payload, status: "running", completedAt: null },
        },
        {
          ...base,
          id: EventId.make(`event:${payload.id}:completed`),
          type: "run.updated",
          payload: { ...payload, status: "completed", completedAt: at(payload.ordinal * 2 + 1) },
        },
      ];
    };
    const held: OrchestrationV2Run = {
      ...run("run:native-origin:held", 1),
      status: "queued",
      queueHeld: true,
      startedAt: null,
    };
    const [heldWritten] = yield* sink.write({
      events: [
        {
          id: EventId.make("event:native-origin:held-message"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: held.userMessageId,
            threadId,
            runId: held.id,
            nodeId: null,
            role: "user",
            text: "Report back when the build finishes",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "agent",
            creationSource: "mcp",
          },
        },
        {
          id: EventId.make("event:native-origin:held"),
          type: "run.created",
          threadId,
          runId: held.id,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: held,
        },
      ],
    });

    yield* sink.write({
      events: runEvents({
        ...run("run:native-origin:transcript", 2),
        nativeOrigin: {
          kind: "claude_transcript",
          nativeSessionId: "session-1",
          promptUuid: "prompt-1",
        },
      }),
    });
    const t3Written = yield* sink.write({ events: runEvents(run("run:native-origin:t3", 3)) });
    const t3Ended = t3Written.at(-1)!.sequence;

    const released = yield* sink
      .stream({ afterSequence: heldWritten!.sequence, eventType: "run.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === held.id &&
            stored.event.payload.queueHeld === false,
        ),
        Stream.take(1),
        Stream.runCollect,
      );
    // Released by the T3 run's end, never by the transcript run's before it.
    assert.isAbove(released[0]!.sequence, t3Ended);
  }).pipe(Effect.provide(layerTest)),
);
