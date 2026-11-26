import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ClaudeSessionSyncState.ts";

// Upstream's migrator skips every id at or below the highest it has recorded, so a fork migration in its ledger would suppress the upstream one that later takes that id. Fork schema names start with `fork_` so no upstream CREATE can collide with them.
const FORK_MIGRATIONS_TABLE = "fork_migrations";

const forkMigrationEntries = [[1, "ClaudeSessionSyncState", ForkMigration0001]] as const;

const latestForkMigrationId = Math.max(...forkMigrationEntries.map(([id]) => id));

const run = Migrator.make({});

/** Whether the fork's own ledger is missing or behind this build. Reads only. */
export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return true;
  const [row] = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return (row?.latestId ?? 0) < latestForkMigrationId;
});

/**
 * Runs the fork's migrations, recorded in their own ledger, after upstream's have run. Writes nothing when the ledger is current, so it is safe on every start and on a database only an upstream build has opened. Returns the migrations it ran as `[id, name]`.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  if (!(yield* hasPendingForkMigrations())) return [];
  return yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: FORK_MIGRATIONS_TABLE,
  });
});
