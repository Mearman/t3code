import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as Statement from "effect/sql/Statement";

import { NonNegativeInt, ProviderThreadId, ThreadId } from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

/**
 * How much of a session T3 holds: `pending` has no thread (no conversation yet, excluded, or no project to put it in), `entry` is its settled thread entry without history, `hydrating` is part-way through reading its history, `full` has every run read back from the transcript, `failed` could not be read and is tried again when its file changes, and `deleted` is a thread the user deleted, which is never recreated unless restored.
 */
const ClaudeSessionHydrationState = Schema.Literals([
  "pending",
  "entry",
  "hydrating",
  "full",
  "failed",
  "deleted",
]);
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
  filePath: Schema.String,
  /** The reader's own state at `byteOffset`, as JSON it encodes and decodes itself. */
  parserState: Schema.NullOr(Schema.String),
  /** The transcript's size and mtime when last read, so a sweep skips files that have not changed. */
  fileSize: NonNegativeInt,
  fileMtimeMs: NonNegativeInt,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type ClaudeSessionSyncState = typeof ClaudeSessionSyncState.Type;

const StoreLookup = Schema.Struct({ storeKey: Schema.String });

/** What a sweep compares a transcript against, without the read position it does not need. */
const ClaudeSessionSyncSummary = Schema.Struct({
  sessionId: Schema.String,
  hydrationState: ClaudeSessionHydrationState,
  filePath: Schema.String,
  fileSize: NonNegativeInt,
  fileMtimeMs: NonNegativeInt,
});
export type ClaudeSessionSyncSummary = typeof ClaudeSessionSyncSummary.Type;

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
    /** Every session recorded for one store, as a sweep compares it. */
    readonly listStoreSummaries: (
      storeKey: string,
    ) => Effect.Effect<
      ReadonlyArray<ClaudeSessionSyncSummary>,
      ClaudeSessionSyncStateRepositoryError
    >;
    /** Every session recorded for one store. */
    readonly listStore: (
      storeKey: string,
    ) => Effect.Effect<
      ReadonlyArray<ClaudeSessionSyncState>,
      ClaudeSessionSyncStateRepositoryError
    >;
    readonly findProviderThreadByNativeSessionId: (
      nativeSessionId: string,
    ) => Effect.Effect<
      ClaudeSessionProviderThread | undefined,
      ClaudeSessionSyncStateRepositoryError
    >;
    /** The provider thread of one of these instances that holds the session, as a store's owner lookup. */
    readonly findProviderThreadInInstances: (input: {
      readonly nativeSessionId: string;
      readonly providerInstanceIds: ReadonlyArray<string>;
    }) => Effect.Effect<
      ClaudeSessionProviderThread | undefined,
      ClaudeSessionSyncStateRepositoryError
    >;
    /** The session a thread shows, in any store. */
    readonly findByThreadId: (
      threadId: string,
    ) => Effect.Effect<ClaudeSessionSyncState | undefined, ClaudeSessionSyncStateRepositoryError>;
    /** The most recently changed session in these stores that has only an entry. Reads one index range. */
    readonly nextEntryToHydrate: (
      storeKeys: ReadonlyArray<string>,
    ) => Effect.Effect<ClaudeSessionSyncState | undefined, ClaudeSessionSyncStateRepositoryError>;
  }
>()("t3/persistence/ClaudeSessionSyncState/ClaudeSessionSyncStateRepository") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRows = (where: Statement.Fragment) => sql`
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
        file_path AS "filePath",
        parser_state_json AS "parserState",
        file_size AS "fileSize",
        file_mtime_ms AS "fileMtimeMs",
        updated_at AS "updatedAt"
      FROM fork_claude_session_sync_state
      WHERE ${where}
  `;

  const getRow = SqlSchema.findOneOption({
    Request: ClaudeSessionSyncKey,
    Result: ClaudeSessionSyncState,
    execute: ({ storeKey, sessionId }) =>
      selectRows(sql`store_key = ${storeKey} AND session_id = ${sessionId}`),
  });

  const listRows = SqlSchema.findAll({
    Request: StoreLookup,
    Result: ClaudeSessionSyncState,
    execute: ({ storeKey }) => selectRows(sql`store_key = ${storeKey}`),
  });

  const summaryRows = SqlSchema.findAll({
    Request: StoreLookup,
    Result: ClaudeSessionSyncSummary,
    execute: ({ storeKey }) => sql`
      SELECT session_id AS "sessionId", hydration_state AS "hydrationState",
        file_path AS "filePath", file_size AS "fileSize", file_mtime_ms AS "fileMtimeMs"
      FROM fork_claude_session_sync_state
      WHERE store_key = ${storeKey}
    `,
  });

  const threadRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ClaudeSessionSyncState,
    execute: ({ threadId }) => selectRows(sql`thread_id = ${threadId} LIMIT 1`),
  });

  // Equality on hydration_state and the order by mtime read fork_claude_session_sync_state_hydration_idx.
  const nextEntryRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ storeKeys: Schema.Array(Schema.String) }),
    Result: ClaudeSessionSyncState,
    execute: ({ storeKeys }) =>
      selectRows(
        sql`hydration_state = 'entry' AND store_key IN ${sql.in(storeKeys)} ORDER BY file_mtime_ms DESC LIMIT 1`,
      ),
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
        file_path,
        parser_state_json,
        file_size,
        file_mtime_ms,
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
        ${state.filePath},
        ${state.parserState},
        ${state.fileSize},
        ${state.fileMtimeMs},
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
        file_path = excluded.file_path,
        parser_state_json = excluded.parser_state_json,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        updated_at = excluded.updated_at
    `,
  });

  const providerThreadInInstancesRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      nativeSessionId: Schema.String,
      providerInstanceIds: Schema.Array(Schema.String),
    }),
    Result: ClaudeSessionProviderThread,
    execute: ({ nativeSessionId, providerInstanceIds }) => sql`
      SELECT provider_thread_id AS "providerThreadId", thread_id AS "threadId"
      FROM orchestration_v2_projection_provider_threads
      WHERE json_valid(payload_json)
        AND json_extract(payload_json, '$.nativeThreadRef.driver') = 'claudeAgent'
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${nativeSessionId}
        AND provider_instance_id IN ${sql.in(providerInstanceIds)}
      ORDER BY updated_at DESC
      LIMIT 1
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
    listStoreSummaries: Effect.fn("ClaudeSessionSyncStateRepository.listStoreSummaries")(
      function (storeKey) {
        return summaryRows({ storeKey }).pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(toRepositoryError("listClaudeSessionSyncSummaries")),
        );
      },
    ),
    listStore: Effect.fn("ClaudeSessionSyncStateRepository.listStore")(function (storeKey) {
      return listRows({ storeKey }).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toRepositoryError("listClaudeSessionSyncStates")),
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
    findProviderThreadInInstances: Effect.fn(
      "ClaudeSessionSyncStateRepository.findProviderThreadInInstances",
    )(function* (input) {
      if (input.providerInstanceIds.length === 0) return undefined;
      return yield* providerThreadInInstancesRow(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.getOrUndefined),
        Effect.mapError(toRepositoryError("findClaudeSessionProviderThreadInInstances")),
      );
    }),
    findByThreadId: Effect.fn("ClaudeSessionSyncStateRepository.findByThreadId")(
      function (threadId) {
        return threadRow({ threadId }).pipe(
          NodeSqliteClient.readOnly,
          Effect.map(Option.getOrUndefined),
          Effect.mapError(toRepositoryError("findClaudeSessionSyncStateByThread")),
        );
      },
    ),
    nextEntryToHydrate: Effect.fn("ClaudeSessionSyncStateRepository.nextEntryToHydrate")(
      function* (storeKeys) {
        if (storeKeys.length === 0) return undefined;
        return yield* nextEntryRow({ storeKeys }).pipe(
          NodeSqliteClient.readOnly,
          Effect.map(Option.getOrUndefined),
          Effect.mapError(toRepositoryError("nextClaudeSessionEntryToHydrate")),
        );
      },
    ),
  });
});

export const layer = Layer.effect(ClaudeSessionSyncStateRepository, make);
