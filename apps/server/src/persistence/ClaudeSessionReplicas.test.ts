import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeSessionReplicas from "./ClaudeSessionReplicas.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = ClaudeSessionReplicas.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.layer(layer)("ClaudeSessionReplicaRepository", (it) => {
  it.effect("keeps where a session was placed after it stops being a replica", () =>
    Effect.gen(function* () {
      const replicas = yield* ClaudeSessionReplicas.ClaudeSessionReplicaRepository;
      yield* replicas.upsert({
        sessionId: "s-1",
        ownerEnvironmentId: EnvironmentId.make("environment-owner"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        transcriptPath: "/home/me/.claude/projects/-checkouts-repo/s-1.jsonl",
        cwd: "/checkouts/repo",
        syncedBytes: 10,
        syncedSha256: "a".repeat(64),
        syncedAt: DateTime.makeUnsafe("2026-11-27T12:00:00.000Z"),
        status: "current",
        forkedSessionIds: [],
        lastError: null,
        keptSha256: null,
      });
      yield* replicas.markOwnerStale({ ownerEnvironmentId: "environment-owner", error: "gone" });
      assert.strictEqual((yield* replicas.get("s-1"))?.status, "stale");

      yield* replicas.remove("s-1");

      assert.isUndefined(yield* replicas.get("s-1"));
      assert.deepStrictEqual(yield* replicas.placed("s-1"), {
        cwd: "/checkouts/repo",
        transcriptPath: "/home/me/.claude/projects/-checkouts-repo/s-1.jsonl",
      });
      assert.isUndefined(yield* replicas.placed("never-placed"));
    }),
  );
});
