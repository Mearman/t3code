import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
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

it("never starts the run-end reaction for a run read back from a transcript", () => {
  const now = DateTime.makeUnsafe("2026-11-26T12:00:00.000Z");
  const threadId = ThreadId.make("thread:native-origin-filter");
  const ended: OrchestrationV2Run = {
    id: RunId.make("run:native-origin-filter"),
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:native-origin-filter"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const stored = (payload: OrchestrationV2Run): OrchestrationV2StoredEvent => ({
    sequence: 1,
    commandId: null,
    event: {
      id: EventId.make(`event:${payload.id}`),
      type: "run.updated",
      threadId,
      runId: payload.id,
      occurredAt: now,
      payload,
    },
  });
  assert.isTrue(Orchestrator.reactsToRunUpdate(stored(ended)));
  assert.isFalse(
    Orchestrator.reactsToRunUpdate(
      stored({
        ...ended,
        nativeOrigin: { kind: "claude_transcript", nativeSessionId: "s-1", promptUuid: "p-1" },
      }),
    ),
  );
});

it.effect("releases an unattended hold when T3's run ends before a transcript run", () =>
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

    // One batch, so both runs are projected before either reaction reads: the transcript run
    // ended last, and the T3 run's end must still release the hold.
    const written = yield* sink.write({
      events: [
        ...runEvents(run("run:native-origin:t3", 2)),
        ...runEvents({
          ...run("run:native-origin:transcript", 3),
          nativeOrigin: {
            kind: "claude_transcript",
            nativeSessionId: "session-1",
            promptUuid: "prompt-1",
          },
        }),
      ],
    });
    const t3Ended = written[1]!.sequence;

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
    assert.isAbove(released[0]!.sequence, t3Ended);
  }).pipe(Effect.provide(layerTest)),
);
