import { assert, describe, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ClaudeSessionSyncState from "./ClaudeSessionSyncState.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = ClaudeSessionSyncState.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const key = { storeKey: "/home/me/.claude/projects:/home/me/.claude/sessions", sessionId: "s-1" };
const state: ClaudeSessionSyncState.ClaudeSessionSyncState = {
  ...key,
  fileIdentity: "16777220:4242",
  byteOffset: 0,
  guardHash: null,
  lastUuid: null,
  threadId: null,
  providerThreadId: null,
  accountUuids: [],
  hydrationState: "pending",
  updatedAt: DateTime.makeUnsafe("2026-11-26T12:00:00.000Z"),
};

// Compare the instant, not the DateTime object's internal fields.
const comparable = (value: ClaudeSessionSyncState.ClaudeSessionSyncState | undefined) =>
  value === undefined ? undefined : { ...value, updatedAt: DateTime.formatIso(value.updatedAt) };

const insertProviderThread = (input: {
  readonly id: string;
  readonly threadId: string;
  readonly driver: string;
  readonly nativeId: string;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      nativeThreadRef: { driver: input.driver, nativeId: input.nativeId, strength: "strong" },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES (${input.id}, ${input.threadId}, 'claudeAgent', 'idle', ${input.updatedAt}, ${payload})
    `;
  });

describe("ClaudeSessionSyncStateRepository", () => {
  it.effect("stores a session's read position and replaces it on the next write", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
      assert.isUndefined(yield* repository.get(key));

      yield* repository.upsert(state);
      assert.deepStrictEqual(comparable(yield* repository.get(key)), comparable(state));

      const advanced: ClaudeSessionSyncState.ClaudeSessionSyncState = {
        ...state,
        byteOffset: 8192,
        guardHash: "sha256:abc",
        lastUuid: "line-9",
        threadId: ThreadId.make("claude:s-1"),
        providerThreadId: ProviderThreadId.make("provider-thread:s-1"),
        accountUuids: ["account-1", "account-2"],
        hydrationState: "full",
        updatedAt: DateTime.makeUnsafe("2026-11-26T12:05:00.000Z"),
      };
      yield* repository.upsert(advanced);
      assert.deepStrictEqual(comparable(yield* repository.get(key)), comparable(advanced));
      assert.isUndefined(yield* repository.get({ ...key, sessionId: "s-2" }));
      assert.isUndefined(yield* repository.get({ ...key, storeKey: "/other:/other" }));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds the Claude provider thread for a native session id through its index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
      yield* insertProviderThread({
        id: "provider-thread:old",
        threadId: "thread:old",
        driver: "claudeAgent",
        nativeId: "s-1",
        updatedAt: "2026-11-26T11:00:00.000Z",
      });
      yield* insertProviderThread({
        id: "provider-thread:new",
        threadId: "thread:new",
        driver: "claudeAgent",
        nativeId: "s-1",
        updatedAt: "2026-11-26T12:00:00.000Z",
      });
      // Another driver's native id can coincide with a Claude session id.
      yield* insertProviderThread({
        id: "provider-thread:codex",
        threadId: "thread:codex",
        driver: "codex",
        nativeId: "s-2",
        updatedAt: "2026-11-26T12:00:00.000Z",
      });

      assert.deepStrictEqual(yield* repository.findProviderThreadByNativeSessionId("s-1"), {
        providerThreadId: ProviderThreadId.make("provider-thread:new"),
        threadId: ThreadId.make("thread:new"),
      });
      assert.isUndefined(yield* repository.findProviderThreadByNativeSessionId("s-2"));

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
        WHERE json_extract(payload_json, '$.nativeThreadRef.driver') = 'claudeAgent'
          AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${"s-1"}
      `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("fork_provider_threads_claude_native_id_idx")),
        JSON.stringify(plan),
      );
    }).pipe(Effect.provide(layer)),
  );
});
