import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ClaudeSessionSyncState.ts";
import ForkMigration0002 from "./ForkMigrations/002_ClaudeSessionSyncProgress.ts";
import ForkMigration0003 from "./ForkMigrations/003_ClaudeSessionReplicas.ts";
import { claudeNativeIdIndex } from "./ForkIndexes.ts";
import { hasPendingMigrations, runMigrations } from "./Migrations.ts";

// Upstream's migrator skips every id at or below the highest it has recorded, so a fork migration in its ledger would suppress the upstream one that later takes that id. Fork schema names start with `fork_` so no upstream CREATE can collide with them.
const FORK_MIGRATIONS_TABLE = "fork_migrations";

const forkMigrationEntries = [
  [1, "ClaudeSessionSyncState", ForkMigration0001],
  [2, "ClaudeSessionSyncProgress", ForkMigration0002],
  [3, "ClaudeSessionReplicas", ForkMigration0003],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

export const FORK_MIGRATION_HEAD = Math.max(...forkMigrationManifest.map(([id]) => id));

/**
 * The fork migrations a recorded fork ledger would skip: the migrator runs only ids above the highest recorded, so an id at or below it that is missing or named differently never runs. Each entry reads `<id>_<name> (recorded: <name or nothing>)`; empty when the history is sound.
 */
export function skippedForkMigrations(
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
): string[] {
  const latestRecordedId = Math.max(0, ...recorded.map(({ id }) => id));
  const recordedNames = new Map(recorded.map(({ id, name }) => [id, name]));
  return forkMigrationManifest.flatMap(([id, name]) => {
    if (id > latestRecordedId) return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
}

// Fork indexes on upstream tables. Upstream migrations run without them, since a table rebuild would drop one and a column drop could fail on one; every start recreates any that is missing.
const forkIndexesOnUpstreamTables = [claudeNativeIdIndex] as const;

const missingForkIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN ${sql.in(forkIndexesOnUpstreamTables.map(({ name }) => name))}
  `;
  const present = new Set(rows.map(({ name }) => name));
  return forkIndexesOnUpstreamTables.filter(({ name }) => !present.has(name));
});

// Undefined when the ledger table does not exist yet.
const readForkLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return undefined;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return rows.map((row) => ({ id: row.migration_id, name: row.name }));
});

// Fails before anything is written, upstream's migrations included, when the fork's recorded history would skip one of its migrations.
const assertForkHistoryCanRun = Effect.gen(function* () {
  const recorded = yield* readForkLedger;
  const skipped = skippedForkMigrations(recorded ?? []);
  if (skipped.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: `This database's fork migration history would skip required schema migrations: ${skipped.join(", ")}. It was probably written by a different build of this fork. Start the build that wrote it.`,
    });
  }
  return recorded;
});

const ledgerBehind = (recorded: ReadonlyArray<{ readonly id: number }> | undefined) =>
  recorded === undefined || Math.max(0, ...recorded.map(({ id }) => id)) < FORK_MIGRATION_HEAD;

/** Whether starting this build would write fork schema: its ledger is missing or behind, or a fork index is missing. Reads only. */
export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  if (ledgerBehind(yield* readForkLedger)) return true;
  return (yield* missingForkIndexes).length > 0;
});

const run = Migrator.make({});

/**
 * Brings the fork schema up to this build: runs the fork's migrations, recorded in their own ledger, then recreates any missing fork index. Reads only when nothing is pending, so it is safe on every start and on a database only an upstream build has opened. Fails with a `BadState` MigrationError when the ledger's history would skip a fork migration. Returns the migrations it ran as `[id, name]`.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* assertForkHistoryCanRun;
  const executed = ledgerBehind(recorded)
    ? yield* run({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
        table: FORK_MIGRATIONS_TABLE,
      })
    : [];
  const missing = yield* missingForkIndexes;
  if (missing.length > 0) {
    yield* sql.withTransaction(
      Effect.forEach(missing, ({ create }) => create(sql), { discard: true }),
    );
  }
  const known = new Set<number>(forkMigrationManifest.map(([id]) => id));
  const unknown = (recorded ?? []).filter(({ id }) => !known.has(id));
  if (unknown.length > 0) {
    yield* Effect.logWarning(
      "Fork migration history records migrations this build does not know; a newer build wrote them.",
    ).pipe(Effect.annotateLogs({ unknown: unknown.map(({ id, name }) => `${id}:${name}`) }));
  }
  return executed;
});

/**
 * Runs upstream's migrations, then the fork's. A fork history that would skip a fork migration
 * fails before anything is written. When upstream has migrations to run, fork indexes on upstream
 * tables are dropped first so they cannot block or be lost by an upstream schema change;
 * `runForkMigrations` recreates them. Returns the fork migrations it ran.
 */
export const runUpstreamThenForkMigrations = Effect.fn("runUpstreamThenForkMigrations")(
  function* () {
    yield* assertForkHistoryCanRun;
    if (yield* hasPendingMigrations()) {
      const sql = yield* SqlClient.SqlClient;
      for (const { name } of forkIndexesOnUpstreamTables) {
        yield* sql`DROP INDEX IF EXISTS ${sql(name)}`;
      }
    }
    yield* runMigrations();
    return yield* runForkMigrations();
  },
);
