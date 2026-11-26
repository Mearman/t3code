import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type ServerSettings,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ClaudeSessionSyncState from "../persistence/ClaudeSessionSyncState.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ClaudeSessionProjects from "./ClaudeSessionProjects.ts";
import * as ClaudeSessionSync from "./ClaudeSessionSync.ts";
import * as ClaudeSyncCapacity from "./ClaudeSyncCapacity.ts";

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("claude-session-sync-project");
const claudeThreadId = ThreadId.make(`claude:${SESSION}`);
const CWD = "/work/project";

const line = (record: Record<string, unknown>) =>
  JSON.stringify({ sessionId: SESSION, cwd: CWD, isSidechain: false, ...record });
const prompt = (uuid: string, parentUuid: string | null, promptId: string, at: string) =>
  line({
    type: "user",
    uuid,
    parentUuid,
    promptId,
    timestamp: at,
    origin: { kind: "human" },
    message: { role: "user", content: `Prompt ${uuid}` },
  });
const reply = (uuid: string, parentUuid: string, at: string, text = `Reply ${uuid}`) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: at,
    message: {
      id: `msg-${uuid}`,
      model: "claude-test",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  });

const firstTurn = [
  prompt("p1", null, "prompt-1", "2026-11-26T10:00:00.000Z"),
  reply("a1", "p1", "2026-11-26T10:00:05.000Z"),
];
const secondTurn = [
  prompt("p2", "a1", "prompt-2", "2026-11-26T10:01:00.000Z"),
  reply("a2", "p2", "2026-11-26T10:01:05.000Z"),
];

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const ROOMY = 1024 ** 4;
const capacityFree = Layer.succeed(ClaudeSyncCapacity.ClaudeSyncCapacity, {
  wait: Effect.void,
  freeDiskBytes: Effect.succeed(ROOMY),
});
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ClaudeSessionSyncState.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
  SecureRandom.layerWebCrypto,
  ThreadCommandExecutor.layer,
  Layer.mock(ClaudeSessionProjects.ClaudeSessionProjects)({
    resolve: () => Effect.succeed({ projectId, worktreePath: null }),
  }),
);

const syncLayer = (
  settings: DeepPartial<ServerSettings>,
  capacity: Layer.Layer<ClaudeSyncCapacity.ClaudeSyncCapacity> = capacityFree,
) =>
  ClaudeSessionSync.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(capacity),
    Layer.provideMerge(ServerSettingsModule.layerTest(settings)),
  );

/** Every Claude instance names its home, so no test resolves the default `~/.claude`. */
const settingsFor = (
  homes: ReadonlyArray<string>,
  sync: DeepPartial<ServerSettings["claudeSessionSync"]> = {},
): DeepPartial<ServerSettings> => ({
  providerInstances: Object.fromEntries(
    homes.map((homePath, index) => [
      index === 0 ? INSTANCE : ProviderInstanceId.make(`claude-${index}`),
      { driver: CLAUDE, config: { homePath } },
    ]),
  ),
  claudeSessionSync: sync,
});

const makeHome = Effect.fn(function* (root: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(root, name);
  yield* fileSystem.makeDirectory(path.join(home, "projects", "-work-project"), {
    recursive: true,
  });
  yield* fileSystem.makeDirectory(path.join(home, "sessions"), { recursive: true });
  return home;
});

const transcriptPath = (home: string, directory = "-work-project") =>
  Effect.map(Path.Path, (path) => path.join(home, "projects", directory, `${SESSION}.jsonl`));

const append = Effect.fn(function* (
  home: string,
  lines: ReadonlyArray<string>,
  directory = "-work-project",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* transcriptPath(home, directory);
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  const existing = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  yield* fileSystem.writeFileString(file, `${existing}${lines.join("\n")}\n`);
  return file;
});

/** Registers the session as held by a live process, as Claude Code does in `sessions/<pid>.json`. */
const markLive = Effect.fn(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(
    path.join(home, "sessions", "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: SESSION,
      cwd: CWD,
      procStart: "Thu Nov 26 10:00:00 2026",
    }),
  );
});

const count = (table: string, threadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      threadId === undefined
        ? yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`
        : yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM ${sql(table)} WHERE thread_id = ${threadId}
          `;
    return rows[0]?.n;
  });

const nativeRuns = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    return runs
      .filter((run) => run.nativeOrigin !== undefined)
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .map((run) => [run.ordinal, run.status, run.nativeOrigin?.promptUuid ?? null] as const);
  });

const sessionRow = (home: string) =>
  Effect.gen(function* () {
    const state = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
    return (yield* state.listStore(yield* storeKeyOf(home)))[0];
  });

const storeKeyOf = Effect.fn(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* fileSystem.realPath(path.join(home, "projects"));
  const sessions = yield* fileSystem.realPath(path.join(home, "sessions"));
  return `${projects}\0${sessions}`;
});

/** Sweeps, then runs every request the sweep made; both must report no failed session. */
const syncAll = (options?: { readonly full?: boolean }) =>
  Effect.gen(function* () {
    const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
    expect(yield* sync.sweep(options)).toEqual([]);
    expect(yield* sync.drain).toEqual([]);
  });

const openThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
    yield* sync.hydrateThread(threadId);
    expect(yield* sync.drain).toEqual([]);
  });

const deleteThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const thread = yield* projections.getThread(threadId);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.deleted",
          threadId,
          occurredAt: now,
          payload: { ...thread, deletedAt: now },
        },
      ],
    });
  });

const withTempRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* body(yield* fileSystem.makeTempDirectoryScoped());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** A transcript larger than one read: three turns, each with a reply of most of a mebibyte. */
const longTranscript = [
  prompt("p1", null, "prompt-1", "2026-11-26T10:00:00.000Z"),
  reply("a1", "p1", "2026-11-26T10:00:05.000Z", "x".repeat(600_000)),
  prompt("p2", "a1", "prompt-2", "2026-11-26T10:01:00.000Z"),
  reply("a2", "p2", "2026-11-26T10:01:05.000Z", "y".repeat(600_000)),
  prompt("p3", "a2", "prompt-3", "2026-11-26T10:02:00.000Z"),
  reply("a3", "p3", "2026-11-26T10:02:05.000Z", "z".repeat(600_000)),
];

describe("ClaudeSessionSync", () => {
  it.effect("shows every session as an entry, and its history once it is opened", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });

          // The background fill is off by default, so an unopened, unheld session is an entry.
          const thread = yield* projections.findThread(claudeThreadId);
          expect(thread).toMatchObject({
            projectId,
            historyOrigin: "native",
            deletedAt: null,
            modelSelection: { instanceId: INSTANCE, model: "claude-test" },
          });
          expect(yield* nativeRuns(claudeThreadId)).toEqual([]);
          expect((yield* sessionRow(home))?.hydrationState).toBe("entry");

          yield* openThread(claudeThreadId);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([
            [1, "completed", "p1"],
            [2, "completed", "p2"],
          ]);
          const { providerThreads } = yield* projections.getThreadRecords(claudeThreadId, [
            "providerThreads",
          ]);
          expect(providerThreads[0]).toMatchObject({
            nativeThreadRef: { driver: CLAUDE, nativeId: SESSION, strength: "strong" },
            firstRunOrdinal: 1,
            lastRunOrdinal: 2,
          });
          const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const runtime = yield* runtimes.getByThreadId({ threadId: claudeThreadId });
          expect(runtime._tag === "Some" && runtime.value.resumeCursor).toEqual({
            threadId: claudeThreadId,
            resume: SESSION,
          });
          expect((yield* sessionRow(home))?.hydrationState).toBe("full");
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("reads a live session's history at once and follows what its terminal appends", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* markLive(home);
        yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          yield* syncAll({ full: true });
          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);

          yield* append(home, secondTurn);
          yield* sync.pollLive;
          expect(yield* sync.drain).toEqual([]);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([
            [1, "completed", "p1"],
            [2, "completed", "p2"],
          ]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("adds nothing when a transcript is read again from the top", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const state = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);

          // Losing the read position, as a crash before it is saved would, reads every line again.
          const row = yield* sessionRow(home);
          expect(row).toBeDefined();
          if (row === undefined) return;
          yield* state.upsert({ ...row, byteOffset: 0, guardHash: null, parserState: null });
          const events = yield* count("orchestration_v2_events");
          const items = yield* count("orchestration_v2_projection_turn_items", claudeThreadId);
          yield* sync.followFile(file);
          expect(yield* count("orchestration_v2_events")).toBe(events);
          expect(yield* count("orchestration_v2_projection_turn_items", claudeThreadId)).toBe(
            items,
          );
          expect(yield* nativeRuns(claudeThreadId)).toHaveLength(2);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("fills unopened sessions in the background only when switched on", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          expect(yield* sync.sweep({ full: true })).toEqual([]);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([]);
          expect(yield* sync.fillOne).toBe(true);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);
          // Nothing is left with only an entry, so the fill stops rather than picking it again.
          expect(yield* sync.fillOne).toBe(false);
        }).pipe(Effect.provide(syncLayer(settingsFor([home], { backgroundFill: true }))));
      }),
    ),
  );

  it.effect("moves the fill past a session it cannot read", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          expect(yield* sync.sweep({ full: true })).toEqual([]);
          yield* fileSystem.remove(file);

          expect(yield* sync.fillOne).toBe(true);
          expect((yield* sessionRow(home))?.hydrationState).toBe("failed");
          expect(yield* sync.fillOne).toBe(false);
        }).pipe(Effect.provide(syncLayer(settingsFor([home], { backgroundFill: true }))));
      }),
    ),
  );

  it.effect("keeps syncing when a line's timestamp is not a time", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [
          prompt("p1", null, "prompt-1", "yesterday-ish"),
          reply("a1", "p1", "not a time"),
          ...secondTurn,
        ]);
        yield* Effect.gen(function* () {
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([
            [1, "completed", "p1"],
            [2, "completed", "p2"],
          ]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("finds a first prompt that lies beyond the head of the transcript", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const snapshots = Array.from({ length: 10 }, (_, index) =>
          JSON.stringify({
            type: "file-history-snapshot",
            messageId: `m${index}`,
            data: "s".repeat(10_000),
          }),
        );
        yield* append(home, [...snapshots, ...firstTurn]);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          expect(yield* projections.findThread(claudeThreadId)).not.toBeNull();
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("dates a thread from its transcript, not from when it was read", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(root, "home");
        // The title lies past the head the entry is read from, so only reading the history finds it.
        const filler = Array.from({ length: 10 }, (_, index) =>
          JSON.stringify({
            type: "file-history-snapshot",
            messageId: `m${index}`,
            data: "s".repeat(10_000),
          }),
        );
        const file = yield* append(home, [
          ...firstTurn,
          ...filler,
          line({ type: "ai-title", aiTitle: "Testing things" }),
        ]);
        const written = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-26T09:00:00.000Z"));
        yield* fileSystem.utimes(file, written, written);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          const thread = yield* projections.getThread(claudeThreadId);
          expect(thread.title).toBe("Testing things");
          // A transcript time, never the time it was read.
          const updated = DateTime.toEpochMillis(thread.updatedAt);
          expect(updated).toBeGreaterThanOrEqual(Date.parse("2026-11-26T10:00:00.000Z"));
          expect(updated).toBeLessThanOrEqual(Date.parse("2026-11-26T10:00:05.000Z"));
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("gives one thread for a session reached through two homes that share a store", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeHome(root, "home");
        const linked = path.join(root, "linked");
        yield* fileSystem.makeDirectory(linked);
        yield* fileSystem.symlink(path.join(home, "projects"), path.join(linked, "projects"));
        yield* fileSystem.symlink(path.join(home, "sessions"), path.join(linked, "sessions"));
        const file = yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          yield* syncAll({ full: true });
          yield* sync.followFile(
            path.join(linked, "projects", "-work-project", `${SESSION}.jsonl`),
          );
          yield* sync.followFile(file);

          expect(yield* count("orchestration_v2_projection_threads")).toBe(1);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home, linked]))));
      }),
    ),
  );

  it.effect("reads one copy of a session found in two project directories, without flapping", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* makeHome(root, "home");
        const older = yield* append(home, firstTurn, "-work-old");
        const old = DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-20T00:00:00.000Z"));
        yield* fileSystem.utimes(older, old, old);
        const newer = yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          const events = yield* count("orchestration_v2_events");
          yield* syncAll({ full: true });
          yield* syncAll({ full: true });
          expect(yield* count("orchestration_v2_events")).toBe(events);
          expect((yield* sessionRow(home))?.filePath).toBe(yield* fileSystem.realPath(newer));
          expect(yield* nativeRuns(claudeThreadId)).toHaveLength(2);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("follows a session T3 Code drives without duplicating its own turn", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const t3ThreadId = yield* seedT3Thread({ promptUuids: ["prompt-1"] });
          yield* syncAll({ full: true });

          // The session's thread is T3 Code's own; the terminal's turn joins it, its own does not.
          expect(yield* count("orchestration_v2_projection_threads")).toBe(1);
          expect(yield* nativeRuns(t3ThreadId)).toEqual([[1, "completed", "p2"]]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("does not take a session another instance's thread drives as this store's", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const other = yield* seedT3Thread({
            promptUuids: [],
            instance: ProviderInstanceId.make("claude-elsewhere"),
          });
          yield* syncAll({ full: true });
          expect(yield* projections.findThread(claudeThreadId)).not.toBeNull();
          expect(yield* nativeRuns(other)).toEqual([]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("does not copy a T3 Code fork's parent history into the fork", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const copied = { forkedFrom: { sessionId: "parent-session", messageUuid: "a1" } };
        yield* append(home, [
          line({
            type: "user",
            uuid: "p1",
            parentUuid: null,
            promptId: "prompt-1",
            timestamp: "2026-11-26T10:00:00.000Z",
            origin: { kind: "human" },
            message: { role: "user", content: "Prompt p1" },
            ...copied,
          }),
          line({
            type: "assistant",
            uuid: "a1",
            parentUuid: "p1",
            timestamp: "2026-11-26T10:00:05.000Z",
            message: {
              id: "msg-a1",
              model: "claude-test",
              role: "assistant",
              content: [{ type: "text", text: "Reply a1" }],
              stop_reason: "end_turn",
            },
            ...copied,
          }),
          ...secondTurn,
        ]);
        yield* Effect.gen(function* () {
          const fork = yield* seedT3Thread({ promptUuids: [], forkOf: ThreadId.make("parent") });
          yield* syncAll({ full: true });
          expect(yield* nativeRuns(fork)).toEqual([[1, "completed", "p2"]]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("reads again after a T3 Code run settles, and not while it runs", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const t3ThreadId = yield* seedT3Thread({ promptUuids: ["prompt-1"] });
          yield* setT3RunStatus(t3ThreadId, "running");
          yield* syncAll({ full: true });
          expect(yield* nativeRuns(t3ThreadId)).toEqual([]);

          yield* setT3RunStatus(t3ThreadId, "completed");
          yield* sync.runSettled(t3ThreadId);
          expect(yield* sync.drain).toEqual([]);
          expect(yield* nativeRuns(t3ThreadId)).toEqual([[2, "completed", "p2"]]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("never recreates a thread the user deleted, and restores it on request", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          yield* deleteThread(claudeThreadId);

          yield* append(home, secondTurn);
          yield* sync.followFile(file);
          yield* syncAll({ full: true });
          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);
          expect((yield* sessionRow(home))?.hydrationState).toBe("deleted");

          expect(yield* sync.restoreSession(claudeThreadId)).toBe(true);
          expect(yield* sync.drain).toEqual([]);
          const restored = (yield* sessionRow(home))?.threadId;
          expect(restored).toBeDefined();
          expect(restored).not.toBe(claudeThreadId);
          if (restored == null) return;
          expect(yield* nativeRuns(restored)).toEqual([
            [1, "completed", "p1"],
            [2, "completed", "p2"],
          ]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("stops reading a thread deleted between two reads", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, longTranscript);
        // The second read waits for capacity; the thread is deleted then.
        const deleting = Layer.effect(
          ClaudeSyncCapacity.ClaudeSyncCapacity,
          Effect.gen(function* () {
            const context = yield* Effect.context<
              ProjectionStore.ProjectionStoreV2 | EventSink.EventSinkV2 | IdAllocator.IdAllocatorV2
            >();
            return {
              wait: Effect.gen(function* () {
                const projections = yield* ProjectionStore.ProjectionStoreV2;
                const thread = yield* projections.findThread(claudeThreadId);
                if (
                  thread !== null &&
                  thread.deletedAt === null &&
                  (yield* nativeRuns(claudeThreadId)).length > 0
                ) {
                  yield* deleteThread(claudeThreadId);
                }
              }).pipe(Effect.provideContext(context), Effect.orDie),
              freeDiskBytes: Effect.succeed(ROOMY),
            };
          }),
        ).pipe(Layer.provide(persistence), Layer.orDie);
        yield* Effect.gen(function* () {
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          // The first read ends inside the third turn; its reply, in the second read, is never written.
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          expect(
            yield* projections.getTurnItem({
              threadId: claudeThreadId,
              itemId: TurnItemId.make(`x:${SESSION}:a3:0`),
            }),
          ).toBeNull();
          expect((yield* sessionRow(home))?.hydrationState).toBe("deleted");
        }).pipe(Effect.provide(syncLayer(settingsFor([home]), deleting)));
      }),
    ),
  );

  it.effect("finishes a history whose reading was interrupted", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, longTranscript);
        const reached = yield* Deferred.make<void>();
        let hold = false;
        const holding = Layer.succeed(ClaudeSyncCapacity.ClaudeSyncCapacity, {
          wait: Effect.suspend(() =>
            hold
              ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          ),
          freeDiskBytes: Effect.succeed(ROOMY),
        });
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          expect(yield* sync.sweep({ full: true })).toEqual([]);
          hold = true;
          yield* sync.hydrateThread(claudeThreadId);
          const reading = yield* Effect.forkChild(sync.drain);
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(reading);
          expect((yield* sessionRow(home))?.hydrationState).toBe("hydrating");

          hold = false;
          yield* syncAll();
          expect(yield* nativeRuns(claudeThreadId)).toHaveLength(3);
          expect((yield* sessionRow(home))?.hydrationState).toBe("full");
        }).pipe(Effect.provide(syncLayer(settingsFor([home]), holding)));
      }),
    ),
  );

  it.effect("shows sessions of an additional home and hides excluded directories", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const empty = yield* makeHome(root, "home");
        const extra = yield* makeHome(root, "extra");
        yield* append(extra, firstTurn);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          expect(yield* projections.findThread(claudeThreadId)).toMatchObject({
            providerInstanceId: INSTANCE,
          });
        }).pipe(Effect.provide(syncLayer(settingsFor([empty], { additionalHomes: [extra] }))));
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          expect(yield* projections.findThread(claudeThreadId)).toBeNull();
          expect((yield* sessionRow(extra))?.hydrationState).toBe("pending");
        }).pipe(
          Effect.provide(syncLayer(settingsFor([extra], { excludedCwdGlobs: ["/work/**"] }))),
        );
      }),
    ),
  );

  it.effect("adds nothing when a transcript longer than one read is read again from the top", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, longTranscript);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const state = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          expect(yield* nativeRuns(claudeThreadId)).toHaveLength(3);
          const row = yield* sessionRow(home);
          expect(row).toBeDefined();
          if (row === undefined) return;
          yield* state.upsert({ ...row, byteOffset: 0, guardHash: null, parserState: null });
          const events = yield* count("orchestration_v2_events");
          yield* sync.followFile(file);
          expect(yield* count("orchestration_v2_events")).toBe(events);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("shows a thread loading its history, and when it has loaded", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          expect(
            yield* projections.getTurnItem({
              threadId: claudeThreadId,
              itemId: TurnItemId.make(`x:${SESSION}:history`),
            }),
          ).toMatchObject({ type: "system_notice", status: "completed" });
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("reads no history below the free-disk floor, and says why", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, firstTurn);
        const nearlyFull = Layer.succeed(ClaudeSyncCapacity.ClaudeSyncCapacity, {
          wait: Effect.void,
          freeDiskBytes: Effect.succeed(5 * 1024 ** 3),
        });
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          yield* syncAll({ full: true });
          yield* openThread(claudeThreadId);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([]);
          const notice = yield* projections.getTurnItem({
            threadId: claudeThreadId,
            itemId: TurnItemId.make(`x:${SESSION}:history`),
          });
          expect(notice).toMatchObject({ type: "system_notice", status: "failed" });
          expect(notice?.type === "system_notice" ? notice.message : "").toContain("5.0 GB free");
          expect((yield* sessionRow(home))?.hydrationState).toBe("entry");
        }).pipe(Effect.provide(syncLayer(settingsFor([home], { minFreeDiskGiB: 10 }), nearlyFull)));
      }),
    ),
  );
});

const t3RunId = RunId.make("t3-run");

/** Writes the status of the T3 Code run `seedT3Thread` made. */
const setT3RunStatus = Effect.fn(function* (threadId: ThreadId, status: "running" | "completed") {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const now = DateTime.makeUnsafe("2026-11-26T09:00:00.000Z");
  yield* sink.write({
    events: [
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "run.updated",
        threadId,
        runId: t3RunId,
        occurredAt: now,
        payload: {
          id: t3RunId,
          threadId,
          ordinal: 1,
          providerInstanceId: INSTANCE,
          modelSelection: { instanceId: INSTANCE, model: "claude-test" },
          providerThreadId: null,
          userMessageId: MessageId.make("t3-message"),
          rootNodeId: NodeId.make("node:t3-own"),
          activeAttemptId: RunAttemptId.make("t3-attempt"),
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
});

/** A thread T3 Code created that drives the session, with one finished turn of its own. */
const seedT3Thread = Effect.fn(function* (input: {
  readonly promptUuids: ReadonlyArray<string>;
  readonly instance?: ProviderInstanceId;
  readonly forkOf?: ThreadId;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const instance = input.instance ?? INSTANCE;
  const threadId = ThreadId.make(`t3-thread:${instance}`);
  const now = DateTime.makeUnsafe("2026-11-26T09:00:00.000Z");
  const providerThreadId = ids.derive.providerThread({
    driver: CLAUDE,
    providerInstanceId: instance,
    nativeThreadId: SESSION,
  });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "T3 thread",
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "claude-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: providerThreadId,
    lineage:
      input.forkOf === undefined
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
        : {
            parentThreadId: input.forkOf,
            relationshipToParent: "fork",
            rootThreadId: input.forkOf,
          },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "thread.created",
        threadId,
        providerInstanceId: instance,
        occurredAt: now,
        payload: thread,
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-thread.updated",
        threadId,
        driver: CLAUDE,
        providerInstanceId: instance,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: CLAUDE,
          providerInstanceId: instance,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: CLAUDE, nativeId: SESSION, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-turn.updated",
        threadId,
        driver: CLAUDE,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:t3-own:${instance}`),
          providerThreadId,
          nodeId: NodeId.make("node:t3-own"),
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
          nativePromptUuids: input.promptUuids,
        },
      },
    ],
  });
  return threadId;
});
