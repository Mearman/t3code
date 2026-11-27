import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sessions held here as copies of another environment's. Owned sessions have no row, so a
  // session is this environment's to run exactly when it is in a store and not listed here.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_claude_session_replicas (
      session_id TEXT PRIMARY KEY,
      owner_environment_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      cwd TEXT,
      synced_size INTEGER NOT NULL,
      synced_sha256 TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      status TEXT NOT NULL,
      forked_session_ids_json TEXT NOT NULL,
      last_error TEXT,
      kept_sha256 TEXT
    )
  `;
  // Where each session was placed here, kept after ownership moves here: its lines still name
  // the directory it ran in elsewhere, and the sync may not have found its new file yet.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_claude_session_places (
      session_id TEXT PRIMARY KEY,
      cwd TEXT,
      transcript_path TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_claude_session_replicas_owner_idx
    ON fork_claude_session_replicas (owner_environment_id)
  `;
});
