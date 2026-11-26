import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The partial index the fork keeps on upstream's provider threads, for finding a Claude session's provider thread by its native id. A query uses it only when its WHERE clause repeats `predicate` term for term, as SQLite matches a partial index's condition, so the two are written once, here.
 */
export const claudeNativeIdIndex = {
  name: "fork_provider_threads_claude_native_id_idx",
  driver: "claudeAgent",
  predicate: (sql: SqlClient.SqlClient) =>
    sql`json_valid(payload_json) AND json_extract(payload_json, '$.nativeThreadRef.driver') = 'claudeAgent'`,
  create: (sql: SqlClient.SqlClient) => sql`
    CREATE INDEX IF NOT EXISTS fork_provider_threads_claude_native_id_idx
    ON orchestration_v2_projection_provider_threads (
      json_extract(payload_json, '$.nativeThreadRef.nativeId'),
      updated_at
    )
    WHERE ${claudeNativeIdIndex.predicate(sql)}
  `,
} as const;
