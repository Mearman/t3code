import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { activeRunQuery } from "../background/KeepAwake.ts";
import { nativeThreadOwnerQuery } from "../orchestration-v2/EventSink.ts";
import * as SqlitePersistence from "./Sqlite.ts";

// Each statement here runs once per write or run event in bulk work, so a scan of a whole table in
// its plan makes that work quadratic.
const planOf = (statement: Statement.Statement<unknown>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN ${statement}`;
    return rows.map((row) => row.detail).join("\n");
  });

describe("query plans of statements run per event", () => {
  it.effect("finds a Claude session's owner through the fork's native id index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* planOf(
        nativeThreadOwnerQuery(sql, {
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          appThreadId: ThreadId.make("claude:session"),
          nativeId: "session",
        }),
      );
      expect(plan).toContain("fork_provider_threads_claude_native_id_idx");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("reads active runs through the recovery index, not a scan of every run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* planOf(activeRunQuery(sql));
      expect(plan).toContain("orchestration_v2_projection_runs_recovery_idx");
      expect(plan).not.toMatch(/SCAN orchestration_v2_projection_runs\b/);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
