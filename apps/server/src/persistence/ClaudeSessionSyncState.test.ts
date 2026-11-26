import { assert, describe, it } from "@effect/vitest";
import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as ClaudeSessionSyncState from "./ClaudeSessionSyncState.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = ClaudeSessionSyncState.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const key = { storeKey: "/home/me/.claude/projects:/home/me/.claude/sessions", sessionId: "s-1" };
const state: ClaudeSessionSyncState.ClaudeSessionSyncState = {
  ...key,
  fileIdentity: "16777220:4242",
  threadId: null,
  providerThreadId: null,
  accountUuids: [],
  hydrationState: "pending",
  filePath: "/home/me/.claude/projects/-work/s-1.jsonl",
  cwd: "/work",
  appliedTitle: null,
  fileSize: 0,
  fileMtimeMs: 0,
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
  it.effect("stores a session's state and replaces it on the next write", () =>
    Effect.gen(function* () {
      const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
      assert.isUndefined(yield* repository.get(key));

      yield* repository.upsert(state);
      assert.deepStrictEqual(comparable(yield* repository.get(key)), comparable(state));

      const advanced: ClaudeSessionSyncState.ClaudeSessionSyncState = {
        ...state,
        // A replaced file keeps the path but not the inode.
        fileIdentity: "16777220:4343",
        threadId: ThreadId.make("claude:s-1"),
        providerThreadId: ProviderThreadId.make("provider-thread:s-1"),
        accountUuids: ["account-1", "account-2"],
        hydrationState: "full",
        appliedTitle: "From Claude",
        fileSize: 8192,
        fileMtimeMs: 1_795_000_000_000,
        updatedAt: DateTime.makeUnsafe("2026-11-26T12:05:00.000Z"),
      };
      yield* repository.upsert(advanced);
      assert.deepStrictEqual(comparable(yield* repository.get(key)), comparable(advanced));
      yield* repository.upsert({ ...state, sessionId: "s-2", storeKey: "/other:/other" });
      assert.deepStrictEqual(yield* repository.listStoreSummaries(key.storeKey), [
        {
          sessionId: advanced.sessionId,
          threadId: advanced.threadId,
          cwd: advanced.cwd,
          hydrationState: advanced.hydrationState,
          filePath: advanced.filePath,
          fileSize: advanced.fileSize,
          fileMtimeMs: advanced.fileMtimeMs,
        },
      ]);
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

      // Plan the statement the repository runs, so a change to its spelling is what is checked.
      const statements: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      yield* repository.findProviderThreadByNativeSessionId("s-1").pipe(Effect.withTracer(tracer));
      const lookup = statements.find((query) => query.includes("nativeThreadRef"));
      assert.isDefined(lookup, statements.join("\n"));
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${lookup!.replaceAll("?", "'s-1'")}`,
      );
      const details = plan.map((row) => row.detail);
      assert.isTrue(
        details.some((detail) => detail.includes("fork_provider_threads_claude_native_id_idx")),
        details.join("\n"),
      );
      assert.isFalse(
        details.some((detail) => detail.includes("TEMP B-TREE")),
        details.join("\n"),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a store's owner only among the instances that reach the store", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
      const payload = JSON.stringify({
        nativeThreadRef: { driver: "claudeAgent", nativeId: "s-1", strength: "strong" },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, provider, provider_instance_id, status, updated_at, payload_json)
        VALUES ('provider-thread:elsewhere', 'thread:elsewhere', 'claudeAgent', 'claude-elsewhere', 'idle', '2026-11-26T12:00:00.000Z', ${payload})
      `;

      assert.isUndefined(
        yield* repository.findProviderThreadInInstances({
          nativeSessionId: "s-1",
          providerInstanceIds: ["claudeAgent"],
        }),
      );
      assert.deepStrictEqual(
        yield* repository.findProviderThreadInInstances({
          nativeSessionId: "s-1",
          providerInstanceIds: ["claudeAgent", "claude-elsewhere"],
        }),
        {
          providerThreadId: ProviderThreadId.make("provider-thread:elsewhere"),
          threadId: ThreadId.make("thread:elsewhere"),
        },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds a thread's session, and the newest entry to fill through its index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
      const row = (
        sessionId: string,
        hydrationState: ClaudeSessionSyncState.ClaudeSessionHydrationState,
        fileMtimeMs: number,
        storeKey = key.storeKey,
      ) =>
        repository.upsert({
          ...state,
          storeKey,
          sessionId,
          threadId: ThreadId.make(`claude:${sessionId}`),
          hydrationState,
          fileMtimeMs,
        });
      yield* row("old-entry", "entry", 1);
      yield* row("new-entry", "entry", 3);
      yield* row("full", "full", 9);
      yield* row("failed", "failed", 8);
      yield* row("other-store", "entry", 7, "/other:/other");

      assert.strictEqual(
        (yield* repository.nextEntryToHydrate([key.storeKey]))?.sessionId,
        "new-entry",
      );
      assert.isUndefined(yield* repository.nextEntryToHydrate([]));
      assert.strictEqual(
        (yield* repository.findByThreadId(ThreadId.make("claude:failed")))?.hydrationState,
        "failed",
      );

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT session_id FROM fork_claude_session_sync_state
        WHERE hydration_state = 'entry' AND store_key IN (${key.storeKey})
        ORDER BY file_mtime_ms DESC LIMIT 1
      `;
      assert.isTrue(
        plan.some((detail) =>
          detail.detail.includes("fork_claude_session_sync_state_hydration_idx"),
        ),
        plan.map((detail) => detail.detail).join("\n"),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps each written turn's digest per thread, and forgets the turns it is told to",
    () =>
      Effect.gen(function* () {
        const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
        const thread = "claude:s-1";
        yield* repository.setTurnDigest({ threadId: thread, turnId: "p1", digest: "d1" });
        yield* repository.setTurnDigest({ threadId: thread, turnId: "p2", digest: "d2" });
        yield* repository.setTurnDigest({ threadId: thread, turnId: "p1", digest: "d1b" });
        yield* repository.setTurnDigest({ threadId: "claude:s-2", turnId: "p1", digest: "other" });
        assert.deepStrictEqual([...(yield* repository.turnDigests(thread))].toSorted(), [
          ["p1", "d1b"],
          ["p2", "d2"],
        ]);

        yield* repository.deleteTurnDigests({ threadId: thread, turnIds: ["p2"] });
        assert.deepStrictEqual([...(yield* repository.turnDigests(thread))], [["p1", "d1b"]]);
        yield* repository.deleteTurnDigests({ threadId: thread });
        assert.strictEqual((yield* repository.turnDigests(thread)).size, 0);
        assert.deepStrictEqual(
          [...(yield* repository.turnDigests("claude:s-2"))],
          [["p1", "other"]],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps each run's line hashes, replaces and forgets them, and drops them with their turn",
    () =>
      Effect.gen(function* () {
        const repository = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
        const at = { threadId: "claude:s-1", turnId: "p1" };
        yield* repository.setLineHashes({
          ...at,
          hashes: [
            ["p1", 1],
            ["a1", 2],
          ],
          removed: [],
        });
        yield* repository.setLineHashes({ ...at, hashes: [["a1", 3]], removed: ["p1"] });
        assert.deepStrictEqual([...(yield* repository.lineHashes(at))], [["a1", 3]]);

        yield* repository.setTurnDigest({ ...at, digest: "d1" });
        yield* repository.deleteTurnDigests({ threadId: at.threadId, turnIds: ["p1"] });
        assert.strictEqual((yield* repository.lineHashes(at)).size, 0);
      }).pipe(Effect.provide(layer)),
  );
});
