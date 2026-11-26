import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  NodeId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ServerSettings,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
const reply = (uuid: string, parentUuid: string, at: string) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: at,
    message: {
      id: `msg-${uuid}`,
      model: "claude-test",
      role: "assistant",
      content: [{ type: "text", text: `Reply ${uuid}` }],
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

const syncLayer = (settings: DeepPartial<ServerSettings>) =>
  ClaudeSessionSync.layer.pipe(
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerSettingsModule.layerTest(settings)),
  );

/** Every Claude instance names its home, so no test resolves the default `~/.claude`. */
const settingsFor = (homes: ReadonlyArray<string>): DeepPartial<ServerSettings> => ({
  providerInstances: Object.fromEntries(
    homes.map((homePath, index) => [
      index === 0 ? INSTANCE : ProviderInstanceId.make(`claude-${index}`),
      { driver: CLAUDE, config: { homePath } },
    ]),
  ),
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

const transcriptPath = (home: string) =>
  Effect.map(Path.Path, (path) => path.join(home, "projects", "-work-project", `${SESSION}.jsonl`));

const append = Effect.fn(function* (home: string, lines: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* transcriptPath(home);
  const existing = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  yield* fileSystem.writeFileString(file, `${existing}${lines.join("\n")}\n`);
  return file;
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
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .map((run) => [run.ordinal, run.status, run.nativeOrigin?.promptUuid ?? null] as const);
  });

const withTempRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* body(yield* fileSystem.makeTempDirectoryScoped());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ClaudeSessionSync", () => {
  it.effect("shows a session from a configured home as a thread with its history", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          expect(yield* sync.sweep).toEqual([]);

          const thread = yield* projections.findThread(claudeThreadId);
          expect(thread).toMatchObject({ projectId, historyOrigin: "native", deletedAt: null });
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
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("follows lines a terminal appends, and a re-read from the top adds nothing", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const state = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
          expect(yield* sync.sweep).toEqual([]);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);

          yield* append(home, secondTurn);
          yield* sync.followFile(file);
          expect(yield* nativeRuns(claudeThreadId)).toEqual([
            [1, "completed", "p1"],
            [2, "completed", "p2"],
          ]);

          // Losing the read position, as a crash before it is saved would, reads every line again.
          const [row] = yield* state.listStore(yield* storeKeyOf(home));
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
          expect(yield* sync.sweep).toEqual([]);
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

  it.effect("does not duplicate a turn T3 Code ran in the session it drives", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        yield* append(home, [...firstTurn, ...secondTurn]);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const t3ThreadId = yield* seedT3Thread({ promptUuids: ["prompt-1"] });
          expect(yield* sync.sweep).toEqual([]);

          // The session's thread is T3 Code's own; the terminal's turn joins it, its own does not.
          expect(yield* count("orchestration_v2_projection_threads")).toBe(1);
          expect(yield* nativeRuns(t3ThreadId)).toEqual([[1, "completed", "p2"]]);
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );

  it.effect("never recreates a thread the user deleted", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const home = yield* makeHome(root, "home");
        const file = yield* append(home, firstTurn);
        yield* Effect.gen(function* () {
          const sync = yield* ClaudeSessionSync.ClaudeSessionSync;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          expect(yield* sync.sweep).toEqual([]);
          const thread = yield* projections.getThread(claudeThreadId);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId: claudeThreadId }),
                type: "thread.deleted",
                threadId: claudeThreadId,
                occurredAt: now,
                payload: { ...thread, deletedAt: now },
              },
            ],
          });

          yield* append(home, secondTurn);
          yield* sync.followFile(file);
          expect(yield* sync.sweep).toEqual([]);

          expect(yield* nativeRuns(claudeThreadId)).toEqual([[1, "completed", "p1"]]);
          const state = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
          const [row] = yield* state.listStore(yield* storeKeyOf(home));
          expect(row?.hydrationState).toBe("deleted");
        }).pipe(Effect.provide(syncLayer(settingsFor([home]))));
      }),
    ),
  );
});

const storeKeyOf = Effect.fn(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* fileSystem.realPath(path.join(home, "projects"));
  const sessions = yield* fileSystem.realPath(path.join(home, "sessions"));
  return `${projects}\0${sessions}`;
});

/** A thread T3 Code created that drives the session, with one finished turn of its own. */
const seedT3Thread = Effect.fn(function* (input: { readonly promptUuids: ReadonlyArray<string> }) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threadId = ThreadId.make("t3-thread");
  const now = DateTime.makeUnsafe("2026-11-26T09:00:00.000Z");
  const providerThreadId = ids.derive.providerThread({
    driver: CLAUDE,
    providerInstanceId: INSTANCE,
    nativeThreadId: SESSION,
  });
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "T3 thread",
    providerInstanceId: INSTANCE,
    modelSelection: { instanceId: INSTANCE, model: "claude-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
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
        providerInstanceId: INSTANCE,
        occurredAt: now,
        payload: thread,
      },
      {
        id: yield* ids.allocate.event({ threadId }),
        type: "provider-thread.updated",
        threadId,
        driver: CLAUDE,
        providerInstanceId: INSTANCE,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: CLAUDE,
          providerInstanceId: INSTANCE,
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
          id: ProviderTurnId.make("turn:t3-own"),
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
