import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The sync re-indexes a transcript in memory, so no read position is stored; size and mtime let a sweep skip unchanged files.
  yield* sql`ALTER TABLE fork_claude_session_sync_state DROP COLUMN byte_offset`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state DROP COLUMN guard_hash`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state DROP COLUMN last_uuid`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_path TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN cwd TEXT`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN applied_title TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_claude_session_sync_state_thread_idx
    ON fork_claude_session_sync_state (thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_claude_session_sync_state_hydration_idx
    ON fork_claude_session_sync_state (hydration_state, file_mtime_ms)
  `;
  // A turn's digest is written once its run's events are, so an unchanged turn is never written again.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_claude_session_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    ) WITHOUT ROWID
  `;
});
