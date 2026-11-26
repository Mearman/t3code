import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import {
  forkMigrationManifest,
  hasPendingForkMigrations,
  runForkMigrations,
  runUpstreamThenForkMigrations,
} from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const latestUpstreamId = Math.max(...migrationManifest.map(([id]) => id));
const forkIndex = "fork_provider_threads_claude_native_id_idx";

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

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("runForkMigrations", () => {
  it.effect("adds the fork schema to a database only upstream migrations have touched", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const upstreamBefore = yield* ledger("effect_sql_migrations");
      assert.isTrue(yield* hasPendingForkMigrations());

      assert.deepStrictEqual(yield* runForkMigrations(), forkMigrationManifest);

      assert.isFalse(yield* hasPendingForkMigrations());
      assert.deepStrictEqual(yield* ledger("fork_migrations"), forkMigrationManifest);
      // Upstream's ledger gains nothing, so its next migration id still runs.
      assert.deepStrictEqual(yield* ledger("effect_sql_migrations"), upstreamBefore);
      assert.strictEqual(Math.max(...upstreamBefore.map(([id]) => id)), latestUpstreamId);
      assert.deepStrictEqual(yield* schemaNames, [
        "fork_claude_session_sync_state",
        "fork_claude_session_sync_state_hydration_idx",
        "fork_migrations",
        forkIndex,
      ]);
      // Upstream still validates its own history with the fork schema present.
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("runs every fork migration over an empty ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // The ledger a run interrupted after creating its table and before recording a migration.
      yield* sql`
        CREATE TABLE fork_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;

      assert.isTrue(yield* hasPendingForkMigrations());
      assert.deepStrictEqual(yield* runForkMigrations(), forkMigrationManifest);
      assert.deepStrictEqual(yield* ledger("fork_migrations"), forkMigrationManifest);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("refuses a fork history this build would skip, and keeps one it does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations();
      const [firstId, firstName] = forkMigrationManifest[0]!;
      yield* sql`UPDATE fork_migrations SET name = 'OtherForkBuild' WHERE migration_id = ${firstId}`;

      const exit = yield* Effect.exit(runForkMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), `${firstId}_${firstName} (recorded: OtherForkBuild)`);

      yield* sql`UPDATE fork_migrations SET name = ${firstName} WHERE migration_id = ${firstId}`;
      const newer = Math.max(...forkMigrationManifest.map(([id]) => id)) + 1;
      yield* sql`INSERT INTO fork_migrations (migration_id, name) VALUES (${newer}, 'FromNewerFork')`;
      assert.deepStrictEqual(yield* runForkMigrations(), []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("recreates its index after an upstream migration rebuilds the table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations();
      // SQLite's table rebuild, as an upstream migration changing a column would run it.
      yield* sql`CREATE TABLE rebuilt AS SELECT * FROM orchestration_v2_projection_provider_threads`;
      yield* sql`DROP TABLE orchestration_v2_projection_provider_threads`;
      yield* sql`ALTER TABLE rebuilt RENAME TO orchestration_v2_projection_provider_threads`;
      assert.notInclude(yield* schemaNames, forkIndex);
      assert.isTrue(yield* hasPendingForkMigrations());

      assert.deepStrictEqual(yield* runForkMigrations(), []);

      assert.include(yield* schemaNames, forkIndex);
      assert.isFalse(yield* hasPendingForkMigrations());
    }).pipe(Effect.provide(memory)),
  );

  it.effect("drops its index on upstream tables before upstream migrations run", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: latestUpstreamId - 1 });
      yield* runForkMigrations();
      assert.include(yield* schemaNames, forkIndex);
      const statements: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });

      yield* runUpstreamThenForkMigrations().pipe(Effect.withTracer(tracer));

      const dropped = statements.findIndex((query) => query.includes(`DROP INDEX IF EXISTS`));
      const upstreamRecorded = statements.findIndex((query) =>
        /INSERT INTO\s+"?effect_sql_migrations/.test(query),
      );
      assert.isAtLeast(dropped, 0, statements.join("\n"));
      assert.isAbove(upstreamRecorded, dropped, statements.join("\n"));
      assert.include(yield* schemaNames, forkIndex);
      assert.strictEqual(
        Math.max(...(yield* ledger("effect_sql_migrations")).map(([id]) => id)),
        latestUpstreamId,
      );
    }).pipe(Effect.provide(memory)),
  );

  it.effect(
    "refuses a fork history it would skip before upstream migrations or the index change",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: latestUpstreamId - 1 });
        yield* runForkMigrations();
        const [firstId] = forkMigrationManifest[0]!;
        yield* sql`UPDATE fork_migrations SET name = 'OtherForkBuild' WHERE migration_id = ${firstId}`;

        const exit = yield* Effect.exit(runUpstreamThenForkMigrations());

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(
          Math.max(...(yield* ledger("effect_sql_migrations")).map(([id]) => id)),
          latestUpstreamId - 1,
        );
        assert.include(yield* schemaNames, forkIndex);
      }).pipe(Effect.provide(memory)),
  );

  it.effect("runs at startup after upstream migrations", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* hasPendingForkMigrations());
      assert.deepStrictEqual(yield* ledger("fork_migrations"), forkMigrationManifest);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});

it.layer(NodeServices.layer)("runForkMigrations on a current database", (it) => {
  it.effect("never takes the write lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-migrations-" }),
        "state.sqlite",
      );
      const current = Effect.gen(function* () {
        yield* runMigrations();
        yield* runForkMigrations();
      });
      yield* current.pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      // Another connection holds the write lock, as a running server mid-write does.
      const writer = new NodeSqlite.DatabaseSync(filename);
      writer.exec("BEGIN IMMEDIATE");
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 0`;
        return yield* Effect.exit(runForkMigrations());
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename })),
        Effect.ensuring(Effect.sync(() => writer.close())),
      );

      assert.isTrue(Exit.isSuccess(result), String(result));
      if (Exit.isSuccess(result)) assert.deepStrictEqual(result.value, []);
    }),
  );
});
