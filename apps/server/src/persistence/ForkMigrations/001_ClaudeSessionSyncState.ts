import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // How far each Claude transcript has been read. The guard hash covers the bytes before the offset, so a rewritten or replaced file is read again instead of resumed mid-line.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_claude_session_sync_state (
      store_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      file_identity TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      guard_hash TEXT,
      last_uuid TEXT,
      thread_id TEXT,
      provider_thread_id TEXT,
      account_uuids_json TEXT NOT NULL,
      hydration_state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (store_key, session_id)
    )
  `;
});
