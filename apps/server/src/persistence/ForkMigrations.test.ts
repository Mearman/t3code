import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingForkMigrations, runForkMigrations } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const latestUpstreamId = Math.max(...migrationManifest.map(([id]) => id));

const ledger = (table: "effect_sql_migrations" | "fork_migrations") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id
    `;
    return rows.map((row) => [row.migration_id, row.name] as const);
  });

const schemaNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE name LIKE 'fork_%' ORDER BY name
  `;
  return rows.map((row) => row.name);
});

describe("runForkMigrations", () => {
  it.effect("adds the fork schema to a database only upstream migrations have touched", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const upstreamBefore = yield* ledger("effect_sql_migrations");
      assert.isTrue(yield* hasPendingForkMigrations());

      assert.deepStrictEqual(yield* runForkMigrations(), [[1, "ClaudeSessionSyncState"]]);

      assert.isFalse(yield* hasPendingForkMigrations());
      assert.deepStrictEqual(yield* ledger("fork_migrations"), [[1, "ClaudeSessionSyncState"]]);
      // Upstream's ledger gains nothing, so its next migration id still runs.
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), upstreamBefore);
      assert.strictEqual(Math.max(...upstreamBefore.map(([id]) => id)), latestUpstreamId);
      assert.deepStrictEqual(yield* schemaNames, [
        "fork_claude_session_sync_state",
        "fork_migrations",
        "fork_provider_threads_claude_native_id_idx",
        "sqlite_autoindex_fork_claude_session_sync_state_1",
      ]);
      // Upstream still validates its own history with the fork schema present.
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs nothing and writes nothing once the fork ledger is current", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations();
      const [before] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;

      assert.deepStrictEqual(yield* runForkMigrations(), []);

      const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
      assert.strictEqual(after?.changes, before?.changes);
      assert.deepStrictEqual(yield* ledger("fork_migrations"), [[1, "ClaudeSessionSyncState"]]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("runs at startup after upstream migrations", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* hasPendingForkMigrations());
      assert.deepStrictEqual(yield* ledger("fork_migrations"), [[1, "ClaudeSessionSyncState"]]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
