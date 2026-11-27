import { ClaudeSessionReplica } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

/** A replica as stored: what clients see, plus the hash its transcript had when it matched. */
export const ClaudeSessionReplicaRow = Schema.Struct({
  ...ClaudeSessionReplica.fields,
  syncedAt: Schema.DateTimeUtcFromString,
  forkedSessionIds: Schema.fromJsonString(Schema.Array(Schema.String)),
  syncedSha256: Schema.String,
  /** The local transcript whose own lines are already kept as a fork, so it may be replaced. */
  keptSha256: Schema.NullOr(Schema.String),
});
export type ClaudeSessionReplicaRow = typeof ClaudeSessionReplicaRow.Type;

type ReplicaRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class ClaudeSessionReplicaRepository extends Context.Service<
  ClaudeSessionReplicaRepository,
  {
    readonly get: (
      sessionId: string,
    ) => Effect.Effect<ClaudeSessionReplicaRow | undefined, ReplicaRepositoryError>;
    readonly list: Effect.Effect<ReadonlyArray<ClaudeSessionReplicaRow>, ReplicaRepositoryError>;
    /** Records the replica and where it was placed here. */
    readonly upsert: (row: ClaudeSessionReplicaRow) => Effect.Effect<void, ReplicaRepositoryError>;
    /** Where a session was placed here, whether still a replica or owned since. */
    readonly placed: (
      sessionId: string,
    ) => Effect.Effect<
      { readonly cwd: string | null; readonly transcriptPath: string } | undefined,
      ReplicaRepositoryError
    >;
    /** Forgets a replica: the session is this environment's own from then on. */
    readonly remove: (sessionId: string) => Effect.Effect<void, ReplicaRepositoryError>;
    /** Marks every replica of an owner stale, keeping each one's last sync point. */
    readonly markOwnerStale: (input: {
      readonly ownerEnvironmentId: string;
      readonly error: string;
    }) => Effect.Effect<void, ReplicaRepositoryError>;
  }
>()("t3/persistence/ClaudeSessionReplicas/ClaudeSessionReplicaRepository") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = sql`
    SELECT
      session_id AS "sessionId",
      owner_environment_id AS "ownerEnvironmentId",
      transcript_path AS "transcriptPath",
      cwd,
      synced_size AS "syncedBytes",
      synced_sha256 AS "syncedSha256",
      synced_at AS "syncedAt",
      status,
      forked_session_ids_json AS "forkedSessionIds",
      last_error AS "lastError",
      kept_sha256 AS "keptSha256"
    FROM fork_claude_session_replicas
  `;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String }),
    Result: ClaudeSessionReplicaRow,
    execute: ({ sessionId }) => sql`${select} WHERE session_id = ${sessionId}`,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ClaudeSessionReplicaRow,
    execute: () => sql`${select} ORDER BY synced_at DESC`,
  });
  const upsertRow = SqlSchema.void({
    Request: ClaudeSessionReplicaRow,
    execute: (row) => sql`
      INSERT INTO fork_claude_session_replicas (
        session_id, owner_environment_id, transcript_path, cwd, synced_size, synced_sha256,
        synced_at, status, forked_session_ids_json, last_error, kept_sha256
      )
      VALUES (
        ${row.sessionId}, ${row.ownerEnvironmentId}, ${row.transcriptPath}, ${row.cwd},
        ${row.syncedBytes}, ${row.syncedSha256}, ${row.syncedAt}, ${row.status},
        ${row.forkedSessionIds}, ${row.lastError}, ${row.keptSha256}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        owner_environment_id = excluded.owner_environment_id,
        transcript_path = excluded.transcript_path,
        cwd = excluded.cwd,
        synced_size = excluded.synced_size,
        synced_sha256 = excluded.synced_sha256,
        synced_at = excluded.synced_at,
        status = excluded.status,
        forked_session_ids_json = excluded.forked_session_ids_json,
        last_error = excluded.last_error,
        kept_sha256 = excluded.kept_sha256
    `,
  });

  return ClaudeSessionReplicaRepository.of({
    get: Effect.fn("ClaudeSessionReplicaRepository.get")(function* (sessionId: string) {
      return Option.getOrUndefined(
        yield* getRow({ sessionId }).pipe(
          Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.get")),
        ),
      );
    }),
    list: listRows(undefined).pipe(
      Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.list")),
    ),
    upsert: Effect.fn("ClaudeSessionReplicaRepository.upsert")(
      function* (row: ClaudeSessionReplicaRow) {
        yield* upsertRow(row);
        yield* sql`
          INSERT INTO fork_claude_session_places (session_id, cwd, transcript_path)
          VALUES (${row.sessionId}, ${row.cwd}, ${row.transcriptPath})
          ON CONFLICT (session_id) DO UPDATE SET
            cwd = excluded.cwd,
            transcript_path = excluded.transcript_path
        `;
      },
      Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.upsert")),
    ),
    placed: Effect.fn("ClaudeSessionReplicaRepository.placed")(function* (sessionId: string) {
      const rows = yield* sql<{ readonly cwd: string | null; readonly transcriptPath: string }>`
        SELECT cwd, transcript_path AS "transcriptPath" FROM fork_claude_session_places
        WHERE session_id = ${sessionId}
      `.pipe(Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.placed")));
      return rows[0];
    }),
    remove: Effect.fn("ClaudeSessionReplicaRepository.remove")(function* (sessionId: string) {
      yield* sql`DELETE FROM fork_claude_session_replicas WHERE session_id = ${sessionId}`.pipe(
        Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.remove")),
      );
    }),
    markOwnerStale: Effect.fn("ClaudeSessionReplicaRepository.markOwnerStale")(function* (input: {
      readonly ownerEnvironmentId: string;
      readonly error: string;
    }) {
      yield* sql`
        UPDATE fork_claude_session_replicas SET status = 'stale', last_error = ${input.error}
        WHERE owner_environment_id = ${input.ownerEnvironmentId}
      `.pipe(Effect.mapError(toRepositoryError("ClaudeSessionReplicaRepository.markOwnerStale")));
    }),
  });
});

export const layer = Layer.effect(ClaudeSessionReplicaRepository, make);
