import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The line uuids each transcript read has consumed, so a line Claude Code writes again is skipped.
  // The session is keyed by a digest of its store and id, so each row holds two short strings.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_claude_session_consumed_uuids (
      session_key TEXT NOT NULL,
      uuid TEXT NOT NULL,
      PRIMARY KEY (session_key, uuid)
    ) WITHOUT ROWID
  `;
});
