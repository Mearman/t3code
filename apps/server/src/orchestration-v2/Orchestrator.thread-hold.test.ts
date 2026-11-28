import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to accept a message"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("a message for a held thread is accepted only once the hold ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:hold");
    const otherThreadId = ThreadId.make("thread:other");
    for (const id of [threadId, otherThreadId])
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: id,
        projectId: ProjectId.make("project:thread-hold"),
        title: id,
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    const send = (id: ThreadId) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${id}`),
        messageId: MessageId.make(`message:${id}`),
        threadId: id,
        text: "hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
    const messages = (id: ThreadId) =>
      projections
        .getThreadRecords(id, ["messages"])
        .pipe(Effect.map((records) => records.messages.length));

    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const hold = yield* Effect.forkChild(
      orchestrator.holdThreadMessages(
        threadId,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(held);
    const waiting = yield* Effect.forkChild(send(threadId));
    // Another thread's messages are not held.
    yield* send(otherThreadId);
    assert.strictEqual(yield* messages(otherThreadId), 1);
    yield* Effect.yieldNow;
    assert.strictEqual(yield* messages(threadId), 0);
    assert.isUndefined(waiting.pollUnsafe());

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(hold);
    yield* Fiber.join(waiting);
    assert.strictEqual(yield* messages(threadId), 1);
  }).pipe(Effect.provide(layerTest)),
);
