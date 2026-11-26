// @effect-diagnostics nodeBuiltinImport:off - node:os is the only source of the load average the background fill yields to.
import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  isRuntimeModeAbove,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { CLAUDE_PROVIDER } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import * as ClaudeSessionSyncState from "../persistence/ClaudeSessionSyncState.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  claudeNativeRunIds,
  claudeNativeRunLookups,
  ClaudeNativeRunState,
  initialClaudeNativeRunState,
  isSettledItemStatus,
  NATIVE_PROVIDER_TURN_PREFIX,
  planClaudeNativeRuns,
  type ClaudeNativeRunTarget,
  type StoredNativeRun,
} from "./ClaudeNativeRuns.ts";
import * as ClaudeSessionProjects from "./ClaudeSessionProjects.ts";
import { readClaudeSessionRegistry } from "./ClaudeSessionRegistry.ts";
import { resolveClaudeSessionStores } from "./ClaudeSessionStore.ts";
import {
  ClaudeTranscriptCursor,
  claudeTranscriptSessionId,
  initialClaudeTranscriptCursor,
  readClaudeTranscript,
} from "./ClaudeTranscriptReader.ts";
import {
  ClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
} from "./ClaudeTranscriptSegments.ts";

/** Bytes of transcript one read parses and writes while holding the thread's lock. */
const READ_BUDGET_BYTES = 1024 * 1024;
/** Events in one database transaction, so a long transcript never holds the writer for long. */
const MAX_EVENTS_PER_WRITE = 500;
/** The head of a transcript read for a session's entry: its directory, start time and title. */
const ENTRY_HEAD_BYTES = 64 * 1024;
/** IN lists are split so a query stays far below SQLite's bound-parameter limit. */
const LOOKUP_CHUNK = 500;
const SWEEP_INTERVAL = "5 minutes";
const WATCH_SETTLE = "250 millis";
const FILL_PACE = "1 second";
const FILL_LOAD_BACKOFF = "30 seconds";
const DAY_MS = 24 * 60 * 60 * 1000;

export class ClaudeSessionSyncError extends Schema.TaggedError<ClaudeSessionSyncError>()(
  "ClaudeSessionSyncError",
  { operation: Schema.String, sessionId: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.sessionId === undefined
      ? `Claude session sync failed to ${this.operation}.`
      : `Claude session sync failed to ${this.operation} for session ${this.sessionId}.`;
  }
}

/** One Claude store as the sync reads it, owned by the first configured instance that reaches it. */
interface SyncStore {
  readonly key: string;
  readonly projectsDir: string;
  readonly sessionsDir: string;
  readonly providerInstanceId: ProviderInstanceId;
}

/** The cursor a sync row keeps as JSON: the parser's state and the open run's. */
const SyncCursorState = Schema.Struct({
  parser: ClaudeTranscriptParserState,
  runs: ClaudeNativeRunState,
});
const decodeSyncCursorState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncCursorState));
const encodeSyncCursorState = Schema.encodeSync(Schema.fromJsonString(SyncCursorState));
const decodePromptUuids = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

const mtimeMsOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => Math.floor(mtime.getTime()) });

// A replaced file keeps its path but not its inode; Windows reports no inode, so the path stands in.
const fileIdentityOf = (info: FileSystem.File.Info, filePath: string) =>
  Option.match(info.ino, {
    onNone: () => `${info.dev}:${filePath}`,
    onSome: (ino) => `${info.dev}:${ino}`,
  });

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;

export class ClaudeSessionSync extends Context.Service<
  ClaudeSessionSync,
  {
    /** Runs discovery, live follow, the periodic sweep and the background fill while the setting is on. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * One sweep of every configured store: an entry per session, full history where it is due. A session that fails is skipped and returned, so the rest still sync.
     */
    readonly sweep: Effect.Effect<ReadonlyArray<ClaudeSessionSyncError>, ClaudeSessionSyncError>;
    /** Reads what was appended to one transcript, as a file watch does. */
    readonly followFile: (filePath: string) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Reads the full history of a session T3 Code holds only an entry for. */
    readonly hydrateThread: (threadId: ThreadId) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Hydrates the newest session that has only an entry; false once none is left. */
    readonly fillOne: Effect.Effect<boolean, ClaudeSessionSyncError>;
  }
>()("t3/claudeSessions/ClaudeSessionSync") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const syncState = yield* ClaudeSessionSyncState.ClaudeSessionSyncStateRepository;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const placements = yield* ClaudeSessionProjects.ClaudeSessionProjects;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const sessionLocks = yield* KeyedLock.make<string>();
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const runtimeMode =
    ceiling !== undefined && isRuntimeModeAbove(DEFAULT_RUNTIME_MODE, ceiling)
      ? ceiling
      : DEFAULT_RUNTIME_MODE;
  const model = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_PROVIDER] ?? DEFAULT_MODEL;

  const fail = (operation: string, sessionId?: string) => (cause: unknown) =>
    new ClaudeSessionSyncError({
      operation,
      ...(sessionId === undefined ? {} : { sessionId }),
      cause,
    });

  const resolveStores = Effect.fn("ClaudeSessionSync.resolveStores")(
    function* (settings: ServerSettings) {
      const instances = Object.entries(settings.providerInstances)
        .filter(([, instance]) => instance.driver === CLAUDE_PROVIDER)
        .map(([id, config]) => ({ id: ProviderInstanceId.make(id), config }));
      if (!Object.hasOwn(settings.providerInstances, CLAUDE_PROVIDER)) {
        instances.unshift({
          id: ProviderInstanceId.make(CLAUDE_PROVIDER),
          config: { driver: CLAUDE_PROVIDER },
        });
      }
      const homes: Array<{ readonly home: string; readonly instanceId: ProviderInstanceId }> = [];
      for (const { id, config } of instances) {
        if (!resolveProviderInstanceEnabled(config)) continue;
        const decoded = decodeClaudeSettings(config.config ?? {});
        if (Option.isNone(decoded)) continue;
        const environment = yield* mergeProviderInstanceEnvironment(
          config.environment,
          hostEnvironment,
        );
        homes.push({
          home: yield* resolveClaudeHomePath(decoded.value, environment),
          instanceId: id,
        });
      }
      const stores = yield* resolveClaudeSessionStores(homes.map(({ home }) => home));
      return stores.flatMap((store): Array<SyncStore> => {
        const owner = homes.find(({ home }) => home === store.homes[0]);
        return owner === undefined
          ? []
          : [
              {
                key: `${store.projectsDir}\0${store.sessionsDir}`,
                projectsDir: store.projectsDir,
                sessionsDir: store.sessionsDir,
                providerInstanceId: owner.instanceId,
              },
            ];
      });
    },
    (effect) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(fail("resolve the Claude stores")),
      ),
  );

  /** Main-chain transcripts sit one directory below `projects/`; deeper files are subagents'. */
  const listTranscripts = Effect.fn("ClaudeSessionSync.listTranscripts")(function* (
    store: SyncStore,
  ) {
    const directories = yield* fileSystem
      .readDirectory(store.projectsDir)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    const found: Array<{
      sessionId: string;
      filePath: string;
      fileIdentity: string;
      size: number;
      mtimeMs: number;
    }> = [];
    for (const directory of directories) {
      const directoryPath = path.join(store.projectsDir, directory);
      const names = yield* fileSystem
        .readDirectory(directoryPath)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        const sessionId = claudeTranscriptSessionId(name);
        if (sessionId === undefined) continue;
        const filePath = path.join(directoryPath, name);
        const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        found.push({
          sessionId,
          filePath,
          fileIdentity: fileIdentityOf(info.value, filePath),
          size: Number(info.value.size),
          mtimeMs: mtimeMsOf(info.value),
        });
      }
    }
    return found.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  });

  const readHead = Effect.fn("ClaudeSessionSync.readHead")(function* (
    filePath: string,
    sessionId: string,
  ) {
    const bytes = yield* Effect.scoped(
      fileSystem
        .open(filePath, { flag: "r" })
        .pipe(Effect.flatMap((handle) => handle.readAlloc(ENTRY_HEAD_BYTES))),
    );
    const text = Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "";
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    let cwd: string | undefined;
    let startedAt: string | undefined;
    let offset = 0;
    const lines = complete.split("\n").map((line) => {
      const entry = { text: line, offset };
      offset += new TextEncoder().encode(line).length + 1;
      return entry;
    });
    for (const line of lines) {
      const parsed = decodeJsonLine(line.text);
      if (Option.isNone(parsed)) continue;
      const lineCwd = field(parsed.value, "cwd");
      const timestamp = field(parsed.value, "timestamp");
      if (cwd === undefined && typeof lineCwd === "string") cwd = lineCwd;
      if (startedAt === undefined && typeof timestamp === "string") startedAt = timestamp;
    }
    const parsed = parseClaudeTranscriptLines({
      sessionId,
      state: { segment: null, lastUuid: null },
      lines,
    });
    let promptTitle: string | undefined;
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    if (Result.isSuccess(parsed)) {
      for (const event of parsed.success.events) {
        if (event._tag === "SegmentStarted") promptTitle ??= event.prompt?.title;
        if (event._tag === "Title" && event.source === "ai" && event.title !== null) {
          aiTitle = event.title;
        }
        if (event._tag === "Title" && event.source === "custom") {
          customTitle = event.title ?? undefined;
        }
      }
    }
    const hasConversation =
      Result.isSuccess(parsed) &&
      parsed.success.events.some((event) => event._tag === "SegmentStarted");
    return { cwd, startedAt, title: customTitle ?? aiTitle ?? promptTitle, hasConversation };
  });

  const markDeleted = (row: ClaudeSessionSyncState.ClaudeSessionSyncState) =>
    syncState.upsert({ ...row, hydrationState: "deleted", updatedAt: DateTime.nowUnsafe() });

  /** A new `claude:<sessionId>` thread holding no history yet: the session's entry. */
  const createEntry = Effect.fn("ClaudeSessionSync.createEntry")(function* (input: {
    readonly store: SyncStore;
    readonly sessionId: string;
    readonly filePath: string;
    readonly mtimeMs: number;
    readonly settled: boolean;
  }) {
    const head = yield* readHead(input.filePath, input.sessionId);
    if (!head.hasConversation) return undefined;
    const threadId = ThreadId.make(`claude:${input.sessionId}`);
    const placement = yield* placements.resolve({ cwd: head.cwd, storeKey: input.store.key });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CLAUDE_PROVIDER,
      providerInstanceId: input.store.providerInstanceId,
      nativeThreadId: input.sessionId,
    });
    const updatedAt = DateTime.makeUnsafe(input.mtimeMs);
    const createdAt =
      head.startedAt === undefined ? updatedAt : DateTime.makeUnsafe(head.startedAt);
    const thread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: placement.projectId,
      title: head.title ?? "Untitled thread",
      providerInstanceId: input.store.providerInstanceId,
      modelSelection: { instanceId: input.store.providerInstanceId, model },
      runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: placement.worktreePath,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThreadId,
      historyOrigin: "native",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: null,
      settledOverride: input.settled ? "settled" : null,
      settledAt: input.settled ? updatedAt : null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver: CLAUDE_PROVIDER,
      providerInstanceId: input.store.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      // A send resumes this session, so it stays the one a terminal `claude --resume` continues.
      nativeThreadRef: { driver: CLAUDE_PROVIDER, nativeId: input.sessionId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt,
      updatedAt,
    };
    const committed = yield* eventSink.write({
      unlessNativeThreadOwned: providerThread,
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          providerInstanceId: input.store.providerInstanceId,
          occurredAt: createdAt,
          payload: thread,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: input.store.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    if (committed.length === 0) return undefined;
    yield* runtimes.upsert(
      {
        threadId,
        providerName: CLAUDE_PROVIDER,
        providerInstanceId: input.store.providerInstanceId,
        adapterKey: CLAUDE_PROVIDER,
        runtimeMode,
        status: "stopped",
        lastSeenAt: DateTime.formatIso(updatedAt),
        resumeCursor: { threadId, resume: input.sessionId },
        runtimePayload: { cwd: head.cwd ?? null },
      },
      { onConflict: "ignore" },
    );
    return { threadId, providerThreadId };
  });

  const inChunks = <A, B, E>(
    values: ReadonlyArray<A>,
    read: (chunk: ReadonlyArray<A>) => Effect.Effect<ReadonlyArray<B>, E>,
  ) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(values.length / LOOKUP_CHUNK) }, (_, index) =>
        values.slice(index * LOOKUP_CHUNK, (index + 1) * LOOKUP_CHUNK),
      ),
      read,
    ).pipe(Effect.map((chunks) => chunks.flat()));

  /** Prompt and reply uuids of T3 Code's own turns, which the transcript also holds. */
  const ownTurns = Effect.fn("ClaudeSessionSync.ownTurns")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      readonly assistantUuid: string | null;
      readonly promptUuids: string | null;
    }>`
      SELECT
        json_extract(payload_json, '$.nativeTurnRef.nativeId') AS "assistantUuid",
        json_extract(payload_json, '$.nativePromptUuids') AS "promptUuids"
      FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ${threadId}
        AND substr(provider_turn_id, 1, ${NATIVE_PROVIDER_TURN_PREFIX.length}) <> ${NATIVE_PROVIDER_TURN_PREFIX}
    `;
    const promptUuids = new Set<string>();
    const assistantUuids = new Set<string>();
    for (const row of rows) {
      if (row.assistantUuid !== null) assistantUuids.add(row.assistantUuid);
      for (const uuid of Option.getOrElse(decodePromptUuids(row.promptUuids), () => [])) {
        promptUuids.add(uuid);
      }
    }
    return { promptUuids, assistantUuids };
  });

  const storedRunsFor = Effect.fn("ClaudeSessionSync.storedRunsFor")(function* (
    sessionId: string,
    segmentIds: ReadonlyArray<string>,
  ) {
    const ids = segmentIds.map((segmentId) => claudeNativeRunIds(sessionId, segmentId));
    const runs = yield* inChunks(
      ids.map((id) => id.runId),
      (chunk) => sql<{
        readonly runId: string;
        readonly ordinal: number;
        readonly status: string;
        readonly requestedAt: string;
        readonly completedAt: string | null;
      }>`
        SELECT run_id AS "runId", ordinal, status, requested_at AS "requestedAt",
          completed_at AS "completedAt"
        FROM orchestration_v2_projection_runs
        WHERE run_id IN ${sql.in(chunk)}
      `,
    );
    const turns = yield* inChunks(
      ids.map((id) => id.providerTurnId),
      (chunk) => sql<{
        readonly providerTurnId: string;
        readonly ordinal: number;
        readonly lastAssistantUuid: string | null;
        readonly model: string | null;
      }>`
        SELECT provider_turn_id AS "providerTurnId", ordinal,
          json_extract(payload_json, '$.nativeTurnRef.nativeId') AS "lastAssistantUuid",
          json_extract(payload_json, '$.model') AS "model"
        FROM orchestration_v2_projection_provider_turns
        WHERE provider_turn_id IN ${sql.in(chunk)}
      `,
    );
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const turnById = new Map(turns.map((turn) => [turn.providerTurnId, turn]));
    const stored = new Map<string, StoredNativeRun>();
    segmentIds.forEach((segmentId, index) => {
      const id = ids[index];
      const run = id === undefined ? undefined : runById.get(id.runId);
      const turn = id === undefined ? undefined : turnById.get(id.providerTurnId);
      // Native runs are always written finished, so a run without completedAt is not one of them.
      if (run === undefined || turn === undefined || run.completedAt === null) return;
      stored.set(segmentId, {
        ordinal: run.ordinal,
        providerTurnOrdinal: turn.ordinal,
        requestedAt: run.requestedAt,
        completedAt: run.completedAt,
        interrupted: run.status === "interrupted",
        ...(turn.lastAssistantUuid === null ? {} : { lastAssistantUuid: turn.lastAssistantUuid }),
        ...(turn.model === null ? {} : { model: turn.model }),
      });
    });
    return stored;
  });

  /** Writes groups in bounded transactions; a group larger than the bound continues in the next. */
  const writeGroups = Effect.fn("ClaudeSessionSync.writeGroups")(function* (
    groups: ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>,
  ) {
    let batch: Array<OrchestrationV2DomainEvent> = [];
    for (const group of groups) {
      if (batch.length > 0 && batch.length + group.length > MAX_EVENTS_PER_WRITE) {
        yield* eventSink.write({ events: batch });
        batch = [];
      }
      for (const event of group) {
        batch.push(event);
        if (batch.length >= MAX_EVENTS_PER_WRITE) {
          yield* eventSink.write({ events: batch });
          batch = [];
        }
      }
    }
    if (batch.length > 0) yield* eventSink.write({ events: batch });
  });

  /** One bounded read of a transcript into its thread, under the thread's lock. */
  const ingestOnce = Effect.fn("ClaudeSessionSync.ingestOnce")(function* (input: {
    readonly row: ClaudeSessionSyncState.ClaudeSessionSyncState;
    readonly target: ClaudeNativeRunTarget;
  }) {
    const { row, target } = input;
    const active = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
      LIMIT 1
    `;
    // T3 Code's live stream owns a turn it is running; its lines are read once the run settles.
    if (active.length > 0) return { row, atEnd: false, deferred: true };
    const saved = Option.flatMap(Option.fromNullishOr(row.parserState), decodeSyncCursorState);
    const cursor: ClaudeTranscriptCursor =
      Option.isSome(saved) && row.guardHash !== null
        ? { offset: row.byteOffset, guardHash: row.guardHash, state: saved.value.parser }
        : initialClaudeTranscriptCursor;
    const read = yield* readClaudeTranscript({
      filePath: row.filePath,
      sessionId: row.sessionId,
      cursor,
      maxBytes: READ_BUDGET_BYTES,
    });
    const runState =
      read.rewritten || Option.isNone(saved) ? initialClaudeNativeRunState : saved.value.runs;
    const lookups = claudeNativeRunLookups({
      sessionId: row.sessionId,
      state: runState,
      events: read.events,
    });
    const storedRuns = yield* storedRunsFor(row.sessionId, [...lookups.segmentIds]);
    const storedItemRows = yield* inChunks(
      [...lookups.itemIds],
      (chunk) => sql<{ readonly id: string; readonly status: string }>`
        SELECT turn_item_id AS "id", status FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(chunk)}
      `,
    );
    const storedToolItems = new Map<string, OrchestrationV2TurnItem>();
    for (const itemId of lookups.pendingToolItemIds) {
      const stored = yield* projections.getTurnItem({
        threadId: target.threadId,
        itemId: TurnItemId.make(itemId),
      });
      if (stored !== null) storedToolItems.set(itemId, stored);
    }
    const [nextRun] = yield* sql<{ readonly next: number }>`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS "next" FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId}
    `;
    const [nextTurn] = yield* sql<{ readonly next: number }>`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS "next" FROM orchestration_v2_projection_provider_turns
      WHERE provider_thread_id = ${target.providerThreadId}
    `;
    const plan = planClaudeNativeRuns({
      target,
      state: runState,
      events: read.events,
      own: yield* ownTurns(target.threadId),
      storedRuns,
      storedItems: new Map(
        storedItemRows.map((item) => [item.id, { settled: isSettledItemStatus(item.status) }]),
      ),
      storedToolItems,
      nextRunOrdinal: nextRun?.next ?? 1,
      nextProviderTurnOrdinal: nextTurn?.next ?? 1,
      eventId: () => EventId.make(`event:claude-sync:${globalThis.crypto.randomUUID()}`),
    });
    yield* writeGroups(plan.groups);
    yield* updateThreadAfterRead({ target, plan });
    const next: ClaudeSessionSyncState.ClaudeSessionSyncState = {
      ...row,
      byteOffset: read.cursor.offset,
      guardHash: read.cursor.guardHash,
      lastUuid: read.cursor.state.lastUuid,
      parserState: encodeSyncCursorState({ parser: read.cursor.state, runs: plan.state }),
      hydrationState: "full",
      updatedAt: DateTime.nowUnsafe(),
    };
    yield* syncState.upsert(next);
    return { row: next, atEnd: read.atEnd, deferred: false };
  });

  const updateThreadAfterRead = Effect.fn("ClaudeSessionSync.updateThreadAfterRead")(function* ({
    target,
    plan,
  }: {
    readonly target: ClaudeNativeRunTarget;
    readonly plan: ReturnType<typeof planClaudeNativeRuns>;
  }) {
    const now = yield* DateTime.now;
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (plan.lastRunOrdinal !== undefined && plan.firstRunOrdinal !== undefined) {
      const records = yield* projections.getThreadRecords(target.threadId, ["providerThreads"]);
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === target.providerThreadId,
      );
      if (providerThread !== undefined) {
        events.push({
          id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
          type: "provider-thread.updated",
          threadId: target.threadId,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: target.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            firstRunOrdinal: Math.min(
              providerThread.firstRunOrdinal ?? plan.firstRunOrdinal,
              plan.firstRunOrdinal,
            ),
            lastRunOrdinal: Math.max(providerThread.lastRunOrdinal ?? 0, plan.lastRunOrdinal),
            updatedAt: now,
          },
        });
      }
    }
    // Only threads the sync made take Claude's titles; T3 Code titles its own threads.
    const title = plan.customTitle ?? plan.aiTitle;
    if (title !== undefined && target.threadId === ThreadId.make(`claude:${target.sessionId}`)) {
      const thread = yield* projections.findThread(target.threadId);
      if (thread !== null && thread.title !== title) {
        events.push({
          id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
          type: "thread.metadata-updated",
          threadId: target.threadId,
          providerInstanceId: target.providerInstanceId,
          occurredAt: now,
          payload: { ...thread, title, updatedAt: now },
        });
      }
    }
    if (events.length > 0) yield* eventSink.write({ events });
  });

  /**
   * Brings one session up to date. `entry` creates its thread with no history; `full` also reads every line not yet read. A thread the user deleted is never recreated.
   */
  const syncSession = Effect.fn("ClaudeSessionSync.syncSession")(
    function* (input: {
      readonly store: SyncStore;
      readonly sessionId: string;
      readonly filePath: string;
      readonly fileIdentity: string;
      readonly size: number;
      readonly mtimeMs: number;
      readonly mode: "entry" | "full";
      readonly settled: boolean;
    }) {
      const key = { storeKey: input.store.key, sessionId: input.sessionId };
      let row = yield* syncState.get(key);
      if (row?.hydrationState === "deleted") return;
      const knownThreadId = row?.threadId ?? null;
      const owner =
        knownThreadId === null
          ? yield* syncState.findProviderThreadByNativeSessionId(input.sessionId)
          : undefined;
      let threadId = knownThreadId ?? owner?.threadId ?? null;
      let providerThreadId: ProviderThreadId | null =
        row?.providerThreadId ?? owner?.providerThreadId ?? null;
      const base: ClaudeSessionSyncState.ClaudeSessionSyncState = row ?? {
        ...key,
        fileIdentity: input.fileIdentity,
        byteOffset: 0,
        guardHash: null,
        lastUuid: null,
        threadId: null,
        providerThreadId: null,
        accountUuids: [],
        hydrationState: "pending",
        filePath: input.filePath,
        parserState: null,
        fileSize: 0,
        fileMtimeMs: 0,
        updatedAt: DateTime.nowUnsafe(),
      };
      if (threadId !== null) {
        const thread = yield* projections.findThread(threadId);
        if (thread === null || thread.deletedAt !== null) {
          yield* markDeleted({ ...base, threadId });
          return;
        }
        // Old imports hold run-less history; migrating them is separate work, so they are left as they are.
        if (thread.historyOrigin === "v1_import") {
          yield* syncState.upsert({
            ...base,
            threadId,
            providerThreadId,
            hydrationState: "entry",
            fileSize: input.size,
            fileMtimeMs: input.mtimeMs,
          });
          return;
        }
      } else {
        const created = yield* createEntry(input);
        if (created === undefined) {
          yield* syncState.upsert({ ...base, fileSize: input.size, fileMtimeMs: input.mtimeMs });
          return;
        }
        threadId = created.threadId;
        providerThreadId = created.providerThreadId;
      }
      row = {
        ...base,
        threadId,
        providerThreadId,
        filePath: input.filePath,
        fileIdentity: input.fileIdentity,
      };
      // A session T3 Code already drives is followed in full, so its terminal turns show at once.
      const full = input.mode === "full" || row.hydrationState === "full" || owner !== undefined;
      if (!full || providerThreadId === null) {
        yield* syncState.upsert({
          ...row,
          hydrationState: row.hydrationState === "pending" ? "entry" : row.hydrationState,
          fileSize: input.size,
          fileMtimeMs: input.mtimeMs,
        });
        return;
      }
      const thread = yield* projections.getThread(threadId);
      const target: ClaudeNativeRunTarget = {
        sessionId: input.sessionId,
        threadId,
        providerThreadId,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
      };
      let current = row;
      for (;;) {
        const step = yield* threadCommands.withLock(threadId, ingestOnce({ row: current, target }));
        current = step.row;
        if (step.deferred) return;
        if (step.atEnd) break;
        yield* Effect.yieldNow;
      }
      yield* syncState.upsert({ ...current, fileSize: input.size, fileMtimeMs: input.mtimeMs });
    },
    (effect, input) =>
      sessionLocks
        .withLock(`${input.store.key}\0${input.sessionId}`, effect)
        .pipe(Effect.mapError(fail("sync a session", input.sessionId))),
  );

  const currentSettings = settingsService.getSettings.pipe(Effect.mapError(fail("read settings")));

  const sweepStore = Effect.fn("ClaudeSessionSync.sweepStore")(function* (
    store: SyncStore,
    settings: ServerSettings,
    failures: Array<ClaudeSessionSyncError>,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const recentSince = now - settings.claudeSessionSync.hydrateRecentDays * DAY_MS;
    const registry = yield* readClaudeSessionRegistry(store.sessionsDir).pipe(
      Effect.mapError(fail("read the session registry")),
    );
    const live = new Set(registry.entries.map((entry) => entry.sessionId));
    const rows = new Map(
      (yield* syncState.listStore(store.key).pipe(Effect.mapError(fail("list sessions")))).map(
        (row) => [row.sessionId, row],
      ),
    );
    const transcripts = yield* listTranscripts(store).pipe(
      Effect.mapError(fail("list transcripts")),
    );
    for (const transcript of transcripts) {
      const row = rows.get(transcript.sessionId);
      if (row?.hydrationState === "deleted") continue;
      if (
        row !== undefined &&
        row.fileSize === transcript.size &&
        row.fileMtimeMs === transcript.mtimeMs
      ) {
        continue;
      }
      const due = live.has(transcript.sessionId) || transcript.mtimeMs >= recentSince;
      yield* syncSession({
        store,
        ...transcript,
        mode: due ? "full" : "entry",
        settled: !due,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not sync a Claude session", { error }).pipe(
            Effect.andThen(Effect.sync(() => failures.push(error))),
          ),
        ),
      );
      yield* Effect.yieldNow;
    }
  });

  const sweep: ClaudeSessionSync["Service"]["sweep"] = Effect.gen(function* () {
    const settings = yield* currentSettings;
    const failures: Array<ClaudeSessionSyncError> = [];
    if (!settings.claudeSessionSync.enabled) return failures;
    const stores = yield* resolveStores(settings);
    for (const store of stores) yield* sweepStore(store, settings, failures);
    return failures;
  }).pipe(Effect.withSpan("ClaudeSessionSync.sweep"));

  const findStoreFor = Effect.fn("ClaudeSessionSync.findStoreFor")(function* (filePath: string) {
    const settings = yield* currentSettings;
    if (!settings.claudeSessionSync.enabled) return undefined;
    const stores = yield* resolveStores(settings);
    const projectsDir = path.dirname(path.dirname(filePath));
    return stores.find((store) => store.projectsDir === projectsDir);
  });

  const followFile: ClaudeSessionSync["Service"]["followFile"] = Effect.fn(
    "ClaudeSessionSync.followFile",
  )(function* (watchedPath) {
    const sessionId = claudeTranscriptSessionId(path.basename(watchedPath));
    if (sessionId === undefined) return;
    // Stores are keyed by real paths, and a home can reach its transcripts through a symlink.
    const real = yield* fileSystem.realPath(watchedPath).pipe(Effect.option);
    if (Option.isNone(real)) return;
    const filePath = real.value;
    const store = yield* findStoreFor(filePath);
    if (store === undefined) return;
    const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return;
    // A file that just changed is recent by definition, so it is followed in full.
    yield* syncSession({
      store,
      sessionId,
      filePath,
      fileIdentity: fileIdentityOf(info.value, filePath),
      size: Number(info.value.size),
      mtimeMs: mtimeMsOf(info.value),
      mode: "full",
      settled: false,
    });
  });

  const hydrateRow = (store: SyncStore, row: ClaudeSessionSyncState.ClaudeSessionSyncState) =>
    fileSystem.stat(row.filePath).pipe(
      Effect.option,
      Effect.flatMap((info) =>
        Option.isNone(info)
          ? Effect.void
          : syncSession({
              store,
              sessionId: row.sessionId,
              filePath: row.filePath,
              fileIdentity: fileIdentityOf(info.value, row.filePath),
              size: Number(info.value.size),
              mtimeMs: mtimeMsOf(info.value),
              mode: "full",
              settled: true,
            }),
      ),
    );

  const hydrateThread: ClaudeSessionSync["Service"]["hydrateThread"] = Effect.fn(
    "ClaudeSessionSync.hydrateThread",
  )(function* (threadId) {
    const prefix = "claude:";
    if (!threadId.startsWith(prefix)) return;
    const sessionId = threadId.slice(prefix.length);
    const settings = yield* currentSettings;
    if (!settings.claudeSessionSync.enabled) return;
    for (const store of yield* resolveStores(settings)) {
      const row = yield* syncState
        .get({ storeKey: store.key, sessionId })
        .pipe(Effect.mapError(fail("read a session", sessionId)));
      if (row?.hydrationState === "entry") yield* hydrateRow(store, row);
    }
  });

  const fillOne: ClaudeSessionSync["Service"]["fillOne"] = Effect.gen(function* () {
    const settings = yield* currentSettings;
    if (!settings.claudeSessionSync.enabled) return false;
    let next: { store: SyncStore; row: ClaudeSessionSyncState.ClaudeSessionSyncState } | undefined;
    for (const store of yield* resolveStores(settings)) {
      const rows = yield* syncState
        .listStore(store.key)
        .pipe(Effect.mapError(fail("list sessions")));
      for (const row of rows) {
        if (row.hydrationState !== "entry" || row.threadId === null) continue;
        if (row.threadId !== ThreadId.make(`claude:${row.sessionId}`)) continue;
        if (next === undefined || row.fileMtimeMs > next.row.fileMtimeMs) next = { store, row };
      }
    }
    if (next === undefined) return false;
    yield* hydrateRow(next.store, next.row);
    return true;
  }).pipe(Effect.withSpan("ClaudeSessionSync.fillOne"));

  // The fill yields to other work: it waits while the one-minute load average exceeds the core count.
  const waitForCapacity = Effect.gen(function* () {
    for (;;) {
      // Windows reports no load average, as zeros, so the fill never waits there.
      const [oneMinute] = NodeOS.loadavg();
      if (oneMinute === undefined || oneMinute < NodeOS.availableParallelism()) return;
      yield* Effect.sleep(FILL_LOAD_BACKOFF);
    }
  });

  const backgroundFill = Effect.gen(function* () {
    for (;;) {
      yield* waitForCapacity;
      const filled = yield* fillOne.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Claude session background fill failed", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      yield* Effect.sleep(filled ? FILL_PACE : SWEEP_INTERVAL);
    }
  });

  const watchStore = Effect.fn("ClaudeSessionSync.watchStore")(function* (store: SyncStore) {
    const changed = yield* Queue.unbounded<string>();
    yield* fileSystem.watch(store.projectsDir, { recursive: true }).pipe(
      Stream.runForEach((event) => {
        const filePath = path.resolve(store.projectsDir, event.path);
        return path.dirname(path.dirname(filePath)) === store.projectsDir &&
          claudeTranscriptSessionId(path.basename(filePath)) !== undefined
          ? Queue.offer(changed, filePath)
          : Effect.void;
      }),
      Effect.catchCause((cause) => Effect.logWarning("Claude transcript watch stopped", { cause })),
      Effect.forkScoped,
    );
    // Claude Code appends a line at a time; changes that land together are read once.
    for (;;) {
      const first = yield* Queue.take(changed);
      yield* Effect.sleep(WATCH_SETTLE);
      const rest = yield* Queue.clear(changed);
      for (const filePath of new Set([first, ...rest])) {
        yield* followFile(filePath).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not follow a Claude transcript", { cause }),
          ),
        );
      }
    }
  });

  const run = (settings: ServerSettings) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stores = yield* resolveStores(settings);
        for (const store of stores) yield* Effect.forkScoped(watchStore(store));
        yield* sweep.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Claude session sweep failed", { cause })),
          Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
          Effect.forkScoped,
        );
        yield* Effect.forkScoped(backgroundFill);
        const latest = yield* eventSink.latestSequence();
        yield* eventSink.stream({ afterSequence: latest, eventType: "thread.visit-recorded" }).pipe(
          Stream.runForEach((stored) =>
            hydrateThread(stored.event.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not hydrate a Claude session thread", { cause }),
              ),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Claude session visit stream failed", { cause }),
          ),
          Effect.forkScoped,
        );
        return yield* Effect.never;
      }),
    );

  const settingsKey = (settings: ServerSettings) =>
    JSON.stringify([
      settings.claudeSessionSync,
      Object.entries(settings.providerInstances).filter(
        ([, instance]) => instance.driver === CLAUDE_PROVIDER,
      ),
    ]);

  const start: ClaudeSessionSync["Service"]["start"] = Effect.fn("ClaudeSessionSync.start")(
    function* () {
      const scope = yield* Effect.scope;
      const changes = yield* settingsService.subscribeChanges;
      let running: Fiber.Fiber<unknown, unknown> | undefined;
      let appliedKey: string | undefined;
      const apply = Effect.fn("ClaudeSessionSync.apply")(function* (settings: ServerSettings) {
        const key = settingsKey(settings);
        if (key === appliedKey) return;
        appliedKey = key;
        if (running !== undefined) yield* Fiber.interrupt(running);
        running = settings.claudeSessionSync.enabled
          ? yield* run(settings).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Claude session sync stopped", { cause }),
              ),
              Effect.forkIn(scope),
            )
          : undefined;
      });
      yield* forkParked(
        Effect.gen(function* () {
          const initial = yield* settingsService.getSettings.pipe(Effect.orDie);
          yield* apply(initial);
          yield* Stream.runForEach(changes, apply);
        }),
      );
    },
  );

  return ClaudeSessionSync.of({ start, sweep, followFile, hydrateThread, fillOne });
});

export const layer = Layer.effect(ClaudeSessionSync, make);
