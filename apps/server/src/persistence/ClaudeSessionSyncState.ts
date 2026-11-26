import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { NonNegativeInt, ProviderThreadId, ThreadId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

/**
 * How much of a session T3 holds: `pending` is discovered only, `entry` is its settled thread entry without history, and `full` has every run read back from the transcript.
 */
const ClaudeSessionHydrationState = Schema.Literals(["pending", "entry", "full"]);
export type ClaudeSessionHydrationState = typeof ClaudeSessionHydrationState.Type;

/** A transcript within one Claude store: the realpaths of its `projects/` and `sessions/`. */
const ClaudeSessionSyncKey = Schema.Struct({
  storeKey: Schema.String,
  sessionId: Schema.String,
});
export type ClaudeSessionSyncKey = typeof ClaudeSessionSyncKey.Type;

/**
 * Where reading a session's transcript resumes. `guardHash` covers the bytes before `byteOffset`, so a rewritten file is read again from the start; `lastUuid` is the last line ingested.
 */
const ClaudeSessionSyncState = Schema.Struct({
  ...ClaudeSessionSyncKey.fields,
  fileIdentity: Schema.String,
  byteOffset: NonNegativeInt,
  guardHash: Schema.NullOr(Schema.String),
  lastUuid: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  accountUuids: Schema.fromJsonString(Schema.Array(Schema.String)),
  hydrationState: ClaudeSessionHydrationState,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type ClaudeSessionSyncState = typeof ClaudeSessionSyncState.Type;

const NativeSessionLookup = Schema.Struct({ nativeSessionId: Schema.String });

/** The provider thread T3 already holds for a Claude session, found by its native session id. */
const ClaudeSessionProviderThread = Schema.Struct({
  providerThreadId: ProviderThreadId,
  threadId: Schema.NullOr(ThreadId),
});
export type ClaudeSessionProviderThread = typeof ClaudeSessionProviderThread.Type;

type ClaudeSessionSyncStateRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class ClaudeSessionSyncStateRepository extends Context.Service<
  ClaudeSessionSyncStateRepository,
  {
    readonly get: (
      key: ClaudeSessionSyncKey,
    ) => Effect.Effect<ClaudeSessionSyncState | undefined, ClaudeSessionSyncStateRepositoryError>;
    /** Inserts the state, or replaces every field of the row with the same key. */
    readonly upsert: (
      state: ClaudeSessionSyncState,
    ) => Effect.Effect<void, ClaudeSessionSyncStateRepositoryError>;
    readonly findProviderThreadByNativeSessionId: (
      nativeSessionId: string,
    ) => Effect.Effect<
      ClaudeSessionProviderThread | undefined,
      ClaudeSessionSyncStateRepositoryError
    >;
  }
>()("t3/persistence/ClaudeSessionSyncState/ClaudeSessionSyncStateRepository") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: ClaudeSessionSyncKey,
    Result: ClaudeSessionSyncState,
    execute: ({ storeKey, sessionId }) => sql`
      SELECT
        store_key AS "storeKey",
        session_id AS "sessionId",
        file_identity AS "fileIdentity",
        byte_offset AS "byteOffset",
        guard_hash AS "guardHash",
        last_uuid AS "lastUuid",
        thread_id AS "threadId",
        provider_thread_id AS "providerThreadId",
        account_uuids_json AS "accountUuids",
        hydration_state AS "hydrationState",
        updated_at AS "updatedAt"
      FROM fork_claude_session_sync_state
      WHERE store_key = ${storeKey} AND session_id = ${sessionId}
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: ClaudeSessionSyncState,
    execute: (state) => sql`
      INSERT INTO fork_claude_session_sync_state (
        store_key,
        session_id,
        file_identity,
        byte_offset,
        guard_hash,
        last_uuid,
        thread_id,
        provider_thread_id,
        account_uuids_json,
        hydration_state,
        updated_at
      )
      VALUES (
        ${state.storeKey},
        ${state.sessionId},
        ${state.fileIdentity},
        ${state.byteOffset},
        ${state.guardHash},
        ${state.lastUuid},
        ${state.threadId},
        ${state.providerThreadId},
        ${state.accountUuids},
        ${state.hydrationState},
        ${state.updatedAt}
      )
      ON CONFLICT (store_key, session_id) DO UPDATE SET
        file_identity = excluded.file_identity,
        byte_offset = excluded.byte_offset,
        guard_hash = excluded.guard_hash,
        last_uuid = excluded.last_uuid,
        thread_id = excluded.thread_id,
        provider_thread_id = excluded.provider_thread_id,
        account_uuids_json = excluded.account_uuids_json,
        hydration_state = excluded.hydration_state,
        updated_at = excluded.updated_at
    `,
  });

  // Spelled as fork_provider_threads_claude_native_id_idx is, with the driver a literal, so SQLite can use that partial index; its second column serves the ORDER BY.
  const findProviderThreadRow = SqlSchema.findOneOption({
    Request: NativeSessionLookup,
    Result: ClaudeSessionProviderThread,
    execute: ({ nativeSessionId }) => sql`
      SELECT provider_thread_id AS "providerThreadId", thread_id AS "threadId"
      FROM orchestration_v2_projection_provider_threads
      WHERE json_valid(payload_json)
        AND json_extract(payload_json, '$.nativeThreadRef.driver') = 'claudeAgent'
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${nativeSessionId}
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  });

  return ClaudeSessionSyncStateRepository.of({
    get: Effect.fn("ClaudeSessionSyncStateRepository.get")(function (key) {
      return getRow(key).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.getOrUndefined),
        Effect.mapError(toRepositoryError("getClaudeSessionSyncState")),
      );
    }),
    upsert: Effect.fn("ClaudeSessionSyncStateRepository.upsert")(function (state) {
      return upsertRow(state).pipe(
        Effect.mapError(toRepositoryError("upsertClaudeSessionSyncState")),
      );
    }),
    findProviderThreadByNativeSessionId: Effect.fn(
      "ClaudeSessionSyncStateRepository.findProviderThreadByNativeSessionId",
    )(function (nativeSessionId) {
      return findProviderThreadRow({ nativeSessionId }).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.getOrUndefined),
        Effect.mapError(toRepositoryError("findClaudeSessionProviderThread")),
      );
    }),
  });
});

export const layer = Layer.effect(ClaudeSessionSyncStateRepository, make);
