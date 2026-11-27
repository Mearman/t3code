import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeSessionReplicas from "../persistence/ClaudeSessionReplicas.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ClaudeSessionOwnershipGate, layer as gateLayer } from "./ClaudeSessionOwnershipGate.ts";

const OWNER = EnvironmentId.make("environment-owner");

// Each test gets its own database and gate, so no claimer leaks between them.
const freshGate = () =>
  Layer.mergeAll(gateLayer, ClaudeSessionReplicas.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const recordReplica = (sessionId: string) =>
  Effect.gen(function* () {
    const replicas = yield* ClaudeSessionReplicas.ClaudeSessionReplicaRepository;
    yield* replicas.upsert({
      sessionId,
      ownerEnvironmentId: OWNER,
      transcriptPath: `/home/me/.claude/projects/-work/${sessionId}.jsonl`,
      cwd: "/work",
      syncedBytes: 10,
      syncedSha256: "a".repeat(64),
      syncedAt: DateTime.makeUnsafe("2026-11-27T12:00:00.000Z"),
      status: "current",
      forkedSessionIds: [],
      lastError: null,
      keptSha256: null,
    });
  });

it.effect("lets a session with no replica record through without asking a claimer", () =>
  Effect.gen(function* () {
    const gate = yield* ClaudeSessionOwnershipGate;
    let claims = 0;
    yield* gate.install(() => Effect.sync(() => void claims++));
    assert.isUndefined(yield* gate.check("own-session"));
    assert.strictEqual(claims, 0);
  }).pipe(Effect.provide(freshGate())),
);

it.effect("refuses a copy while no claimer can move it here", () =>
  Effect.gen(function* () {
    const gate = yield* ClaudeSessionOwnershipGate;
    yield* recordReplica("copied-session");
    const refusal = yield* gate.check("copied-session");
    assert.strictEqual(refusal?._tag, "replica");
    assert.strictEqual(refusal?.ownerEnvironmentId, OWNER);
  }).pipe(Effect.provide(freshGate())),
);

it.effect("asks the claimer for a copy and passes on its answer", () =>
  Effect.gen(function* () {
    const gate = yield* ClaudeSessionOwnershipGate;
    yield* recordReplica("copied-session");
    const asked: Array<string> = [];
    yield* gate.install(({ sessionId, ownerEnvironmentId }) =>
      Effect.sync(() => {
        asked.push(`${sessionId}@${ownerEnvironmentId}`);
        return undefined;
      }),
    );
    assert.isUndefined(yield* gate.check("copied-session"));
    assert.deepStrictEqual(asked, [`copied-session@${OWNER}`]);

    yield* gate.install(({ ownerEnvironmentId }) =>
      Effect.succeed({ _tag: "replica" as const, ownerEnvironmentId, message: "kept there" }),
    );
    assert.strictEqual((yield* gate.check("copied-session"))?.message, "kept there");
  }).pipe(Effect.provide(freshGate())),
);
