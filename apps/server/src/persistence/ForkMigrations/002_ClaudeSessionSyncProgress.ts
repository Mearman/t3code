import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The parser's open segment resumes a read mid-turn; size and mtime let a sweep skip unchanged files without opening them.
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_path TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN parser_state_json TEXT`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE fork_claude_session_sync_state ADD COLUMN cwd TEXT`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_claude_session_sync_state_thread_idx
    ON fork_claude_session_sync_state (thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS fork_claude_session_sync_state_hydration_idx
    ON fork_claude_session_sync_state (hydration_state, file_mtime_ms)
  `;
});
