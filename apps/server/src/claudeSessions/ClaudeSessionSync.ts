// @effect-diagnostics nodeBuiltinImport:off - node:crypto digests a store key into a thread id suffix.
import * as NodeCrypto from "node:crypto";

import {
  ClaudeSettings,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  isNativeOriginRun,
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
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
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
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeReportedModelSlug,
} from "../provider/ClaudeModelCatalog.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { matchesCwdGlob } from "./claudeCwdGlobs.ts";
import {
  claudeNativeRunIds,
  claudeNativeRunLookups,
  ClaudeNativeRunState,
  claudePromptTextDigest,
  initialClaudeNativeRunState,
  isSettledItemStatus,
  NATIVE_PROVIDER_TURN_PREFIX,
  parseTranscriptTime,
  planClaudeNativeRuns,
  type ClaudeNativeRunTarget,
  type ClaudeOwnTurns,
  type StoredNativeRun,
} from "./ClaudeNativeRuns.ts";
import * as ClaudeSessionProjects from "./ClaudeSessionProjects.ts";
import * as ClaudeLiveSessions from "./ClaudeLiveSessions.ts";
import { resolveClaudeSessionStores } from "./ClaudeSessionStore.ts";
import * as ClaudeSyncCapacity from "./ClaudeSyncCapacity.ts";
import {
  ClaudeTranscriptCursor,
  claudeTranscriptSessionId,
  initialClaudeTranscriptCursor,
  readClaudeTranscript,
} from "./ClaudeTranscriptReader.ts";
import {
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptLine,
} from "./ClaudeTranscriptSegments.ts";

/** Bytes of transcript one read parses and writes while holding the thread's lock. */
const READ_BUDGET_BYTES = 64 * 1024;
/** Events in one database transaction, so a long transcript never holds the writer for long. */
const MAX_EVENTS_PER_WRITE = 200;
/** A session's entry is read from its head in chunks of this size until its first prompt. */
const HEAD_CHUNK_BYTES = 64 * 1024;
/** IN lists are split so a query stays far below SQLite's bound-parameter limit. */
const LOOKUP_CHUNK = 500;
/** A quick sweep lists only project directories that changed; every sixth one stats every file. */
const SWEEP_INTERVAL = "5 minutes";
const FULL_SWEEP_EVERY = 6;
/** Live sessions' transcripts are polled this often; the registry is re-read every fifth poll. */
const LIVE_POLL_INTERVAL = "1 second";
const REGISTRY_EVERY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `urgent` is what a person or a running terminal is waiting on: an opened thread, a live session, one T3 Code drives, a read after a T3 Code run. It never waits on host load. `fill` is background work and runs only when nothing is urgent and the host is idle.
 */
type Lane = "urgent" | "fill";

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
  /** Every instance whose home reaches this store, so a thread any of them drives is this store's. */
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
}

interface Transcript {
  readonly sessionId: string;
  readonly filePath: string;
  readonly fileIdentity: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface HydrationRequest {
  readonly store: SyncStore;
  readonly sessionId: string;
  readonly filePath: string | undefined;
  readonly lane: Lane;
}

/** A first-in, first-out queue with constant-time take, so a long fill backlog costs nothing per step. */
class Fifo<A> {
  private items: Array<A | undefined> = [];
  private head = 0;
  push(item: A) {
    this.items.push(item);
  }
  shift(): A | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

/** What a sync row keeps as JSON. One that no longer decodes restarts from the top, which writes nothing already written. */
const SyncCursorState = Schema.Struct({
  /** Claude's latest titles, and the one the sync last gave the thread; a rename in T3 Code is kept. */
  titles: Schema.optional(
    Schema.Struct({
      ai: Schema.optional(Schema.String),
      custom: Schema.optional(Schema.NullOr(Schema.String)),
      applied: Schema.optional(Schema.String),
    }),
  ),
  cursor: ClaudeTranscriptCursor,
  runs: ClaudeNativeRunState,
});
type SyncTitles = NonNullable<(typeof SyncCursorState.Type)["titles"]>;
const decodeSyncCursorState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncCursorState));
const encodeSyncCursorState = Schema.encodeSync(Schema.fromJsonString(SyncCursorState));
const decodeStrings = Schema.decodeUnknownOption(
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

const storeDigest = (storeKey: string) =>
  NodeCrypto.createHash("sha256").update(storeKey).digest("hex").slice(0, 8);

// A thread `claude:<sessionId>:<suffix>` shows a session another thread may also show.
const idScopeOf = (threadId: ThreadId, sessionId: string) =>
  threadId.startsWith(`claude:${sessionId}:`) ? threadId.slice("claude:".length) : sessionId;

const NATIVE_RUN_PREFIX = "claude-run:";

const modelSlug = (reported: string) =>
  resolveClaudeReportedModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, reported);

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;
const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export class ClaudeSessionSync extends Context.Service<
  ClaudeSessionSync,
  {
    /** Runs discovery, live follow, hydration and, when switched on, the background fill. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * One sweep of every configured store: an entry for each new session, and a hydration request for each live, followed or interrupted one. `full` stats every transcript and looks again at sessions without a thread; otherwise only changed project directories are listed. A session that fails is skipped and returned, so the rest still sync.
     */
    readonly sweep: (options?: {
      readonly full?: boolean;
    }) => Effect.Effect<ReadonlyArray<ClaudeSessionSyncError>, ClaudeSessionSyncError>;
    /** Requests a read of every live session whose transcript changed since the sync last read it. */
    readonly pollLive: Effect.Effect<void, ClaudeSessionSyncError>;
    /**
     * Runs requests until none is left, one bounded step at a time: urgent ones first, each in turn, then, with the background fill on, the newest sessions that have only an entry. Returns the sessions that failed.
     */
    readonly drain: Effect.Effect<ReadonlyArray<ClaudeSessionSyncError>>;
    /** Requests the full history of the session a thread shows. */
    readonly hydrateThread: (threadId: ThreadId) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Requests a read after a run T3 Code executed settles, so its lines are passed over and later terminal ones shown. */
    readonly runSettled: (threadId: ThreadId) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Restores every deleted session `claudeSessionSync.restoreSessionIds` names as a new thread, then clears the list. */
    readonly applyRestores: Effect.Effect<void, ClaudeSessionSyncError>;
    /** Registers a Claude instance for each additional home no instance reaches; true when it wrote one. */
    readonly registerAdditionalHomes: Effect.Effect<boolean, ClaudeSessionSyncError>;
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
  const random = yield* SecureRandom.SecureRandom;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const placements = yield* ClaudeSessionProjects.ClaudeSessionProjects;
  const capacity = yield* ClaudeSyncCapacity.ClaudeSyncCapacity;
  const liveSessions = yield* ClaudeLiveSessions.ClaudeLiveSessions;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const sessionLocks = yield* KeyedLock.make<string>();
  const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
  const runtimeMode =
    ceiling !== undefined && isRuntimeModeAbove(DEFAULT_RUNTIME_MODE, ceiling)
      ? ceiling
      : DEFAULT_RUNTIME_MODE;
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_PROVIDER] ?? DEFAULT_MODEL;

  // Helpers shared with other modules read the file system as a service; this one supplies its own.
  const withHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const fail = (operation: string, sessionId?: string) => (cause: unknown) =>
    new ClaudeSessionSyncError({
      operation,
      ...(sessionId === undefined ? {} : { sessionId }),
      cause,
    });

  const settingsKey = (settings: ServerSettings) =>
    JSON.stringify([
      settings.claudeSessionSync,
      Object.entries(settings.providerInstances).filter(
        ([, instance]) => instance.driver === CLAUDE_PROVIDER,
      ),
    ]);

  const additionalHomeInstanceId = (home: string) =>
    ProviderInstanceId.make(`claude-home-${storeDigest(home)}`);

  /** Whether a home already in the list reaches the same store as this one. */
  const isReached = Effect.fn("ClaudeSessionSync.isReached")(function* (
    homes: ReadonlyArray<{ readonly home: string }>,
    home: string,
  ) {
    const stores = yield* resolveClaudeSessionStores([...homes.map((known) => known.home), home]);
    return (
      stores.find((store) => store.homes.includes(home))?.homes.some((other) => other !== home) ===
      true
    );
  });

  const resolveStoresUncached = Effect.fn("ClaudeSessionSync.resolveStores")(
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
      // A send resumes in its instance's home with that home's login, so an extra home no
      // instance reaches is served by an instance of its own, which registerAdditionalHomes writes.
      for (const extra of settings.claudeSessionSync.additionalHomes) {
        const home = path.resolve(expandHomePath(extra, homeDirectory));
        if (yield* isReached(homes, home)) continue;
        homes.push({ home, instanceId: additionalHomeInstanceId(home) });
      }
      const stores = yield* resolveClaudeSessionStores(homes.map(({ home }) => home));
      return stores.flatMap((store): Array<SyncStore> => {
        const reaching = homes.filter(({ home }) => store.homes.includes(home));
        const first = reaching[0];
        return first === undefined
          ? []
          : [
              {
                key: `${store.projectsDir}\0${store.sessionsDir}`,
                projectsDir: store.projectsDir,
                sessionsDir: store.sessionsDir,
                providerInstanceId: first.instanceId,
                instanceIds: [...new Set(reaching.map(({ instanceId }) => instanceId))],
              },
            ];
      });
    },
    (effect) => withHost(effect).pipe(Effect.mapError(fail("resolve the Claude stores"))),
  );

  // Stores are resolved once per settings; resolving them takes a realpath per home.
  let storeMemo: { readonly key: string; readonly stores: ReadonlyArray<SyncStore> } | undefined;
  const currentState = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(fail("read settings")),
    );
    const key = settingsKey(settings);
    if (storeMemo?.key !== key) {
      storeMemo = { key, stores: yield* resolveStoresUncached(settings) };
    }
    return { settings, stores: storeMemo.stores };
  });

  const statTranscript = (sessionId: string, filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.option,
      Effect.map((info): Transcript | undefined =>
        Option.isSome(info) && info.value.type === "File"
          ? {
              sessionId,
              filePath,
              fileIdentity: fileIdentityOf(info.value, filePath),
              size: Number(info.value.size),
              mtimeMs: mtimeMsOf(info.value),
            }
          : undefined,
      ),
    );

  // Project directory mtimes at their last listing; a directory whose mtime is unchanged has no new file.
  const listedDirectories = new Map<string, number>();

  /**
   * Main-chain transcripts sit one directory below `projects/`; deeper files are subagents'. A session id found in two directories is the one changed last.
   */
  const listTranscripts = Effect.fn("ClaudeSessionSync.listTranscripts")(function* (
    store: SyncStore,
    full: boolean,
  ) {
    const directories = yield* fileSystem
      .readDirectory(store.projectsDir)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
    const found = new Map<string, Transcript>();
    for (const directory of directories) {
      const directoryPath = path.join(store.projectsDir, directory);
      const info = yield* fileSystem.stat(directoryPath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "Directory") continue;
      const directoryMtime = mtimeMsOf(info.value);
      if (!full && listedDirectories.get(directoryPath) === directoryMtime) continue;
      listedDirectories.set(directoryPath, directoryMtime);
      const names = yield* fileSystem
        .readDirectory(directoryPath)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        const sessionId = claudeTranscriptSessionId(name);
        if (sessionId === undefined) continue;
        const transcript = yield* statTranscript(sessionId, path.join(directoryPath, name));
        if (transcript === undefined) continue;
        const known = found.get(sessionId);
        if (
          known === undefined ||
          transcript.mtimeMs > known.mtimeMs ||
          (transcript.mtimeMs === known.mtimeMs && transcript.filePath < known.filePath)
        ) {
          found.set(sessionId, transcript);
        }
      }
    }
    return [...found.values()].toSorted((left, right) => right.mtimeMs - left.mtimeMs);
  });

  /** Finds a session's transcript by id, for a live session the sync has not seen yet. */
  const findTranscript = Effect.fn("ClaudeSessionSync.findTranscript")(function* (
    store: SyncStore,
    sessionId: string,
  ) {
    const directories = yield* fileSystem
      .readDirectory(store.projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    let best: Transcript | undefined;
    for (const directory of directories) {
      const transcript = yield* statTranscript(
        sessionId,
        path.join(store.projectsDir, directory, `${sessionId}.jsonl`),
      );
      if (transcript !== undefined && (best === undefined || transcript.mtimeMs > best.mtimeMs)) {
        best = transcript;
      }
    }
    return best;
  });

  /**
   * Reads a transcript from the top until its first prompt and the facts its entry needs: working directory, start time, title and model. Stops at the first prompt once those are known, else at the end of the file.
   */
  const scanHead = Effect.fn("ClaudeSessionSync.scanHead")(function* (
    filePath: string,
    sessionId: string,
  ) {
    let cwd: string | undefined;
    let startedAt: DateTime.Utc | undefined;
    let model: string | undefined;
    let promptTitle: string | undefined;
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    let hasConversation = false;
    let state = initialClaudeTranscriptParserState;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(filePath, { flag: "r" });
        const decoder = new TextDecoder();
        // Chunks of a line not yet ended; they are joined once, when its newline arrives.
        let pending: Array<Uint8Array> = [];
        let offset = 0;
        for (;;) {
          const chunk = yield* handle.readAlloc(HEAD_CHUNK_BYTES);
          if (Option.isNone(chunk)) return;
          if (chunk.value.indexOf(0x0a) === -1) {
            pending.push(chunk.value);
            continue;
          }
          const joined =
            pending.length === 0 ? chunk.value : Buffer.concat([...pending, chunk.value]);
          pending = [];
          const lines: Array<ClaudeTranscriptLine> = [];
          let start = 0;
          for (let end = joined.indexOf(0x0a); end !== -1; end = joined.indexOf(0x0a, start)) {
            const text = decoder.decode(joined.subarray(start, end));
            lines.push({ text, offset: offset + start });
            const record = decodeJsonLine(text);
            if (Option.isSome(record)) {
              const lineCwd = field(record.value, "cwd");
              if (cwd === undefined && typeof lineCwd === "string") cwd = lineCwd;
              const timestamp = field(record.value, "timestamp");
              if (startedAt === undefined && typeof timestamp === "string") {
                startedAt = parseTranscriptTime(timestamp);
              }
              const lineModel = field(field(record.value, "message"), "model");
              if (
                model === undefined &&
                field(record.value, "type") === "assistant" &&
                field(record.value, "isSidechain") !== true &&
                typeof lineModel === "string" &&
                lineModel !== "<synthetic>"
              ) {
                model = modelSlug(lineModel);
              }
            }
            start = end + 1;
          }
          offset += start;
          if (start < joined.length) pending = [joined.slice(start)];
          const parsed = parseClaudeTranscriptLines({ sessionId, state, lines, known: new Set() });
          state = parsed.state;
          for (const event of parsed.events) {
            if (event._tag === "SegmentStarted") {
              hasConversation = true;
              promptTitle ??= event.prompt?.title;
            } else if (event._tag === "Title" && event.source === "ai" && event.title !== null) {
              aiTitle = event.title;
            } else if (event._tag === "Title" && event.source === "custom") {
              customTitle = event.title ?? undefined;
            }
          }
          if (hasConversation && cwd !== undefined && model !== undefined) return;
          yield* Effect.yieldNow;
        }
      }),
    );
    return { cwd, startedAt, model, title: customTitle ?? aiTitle ?? promptTitle, hasConversation };
  });

  const isExcluded = (globs: ReadonlyArray<string>, cwd: string | null) =>
    cwd !== null && globs.some((glob) => matchesCwdGlob({ glob, cwd, home: homeDirectory }));

  const markState = (
    row: ClaudeSessionSyncState.ClaudeSessionSyncState,
    hydrationState: ClaudeSessionSyncState.ClaudeSessionHydrationState,
  ) =>
    Effect.flatMap(DateTime.now, (at) =>
      syncState.upsert({ ...row, hydrationState, updatedAt: at }),
    );

  type EntryOutcome =
    | {
        readonly _tag: "Thread";
        readonly threadId: ThreadId;
        readonly providerThreadId: ProviderThreadId;
        readonly cwd: string | null;
      }
    | { readonly _tag: "Deleted"; readonly threadId: ThreadId }
    | { readonly _tag: "Skipped"; readonly cwd: string | null; readonly excluded: boolean };

  /**
   * A new thread holding no history yet: the session's entry. Its id is `claude:<sessionId>`, or, when another store already shows a session with that id, `claude:<sessionId>:<store digest>`. `restoredFrom` gives a restored session a new id, since its deleted thread's content is being purged.
   */
  const createEntry = Effect.fn("ClaudeSessionSync.createEntry")(function* (input: {
    readonly store: SyncStore;
    readonly transcript: Transcript;
    readonly settled: boolean;
    readonly excludedCwdGlobs: ReadonlyArray<string>;
    readonly restoredAt?: number;
  }) {
    const { store, transcript } = input;
    const { sessionId } = transcript;
    const head = yield* scanHead(transcript.filePath, sessionId);
    if (!head.hasConversation)
      return { _tag: "Skipped", cwd: head.cwd ?? null, excluded: false } satisfies EntryOutcome;
    if (isExcluded(input.excludedCwdGlobs, head.cwd ?? null)) {
      return { _tag: "Skipped", cwd: head.cwd ?? null, excluded: true } satisfies EntryOutcome;
    }
    const baseId = ThreadId.make(`claude:${sessionId}`);
    let threadId = baseId;
    if (input.restoredAt !== undefined) {
      threadId = ThreadId.make(`claude:${sessionId}:restored-${input.restoredAt}`);
    } else {
      const existing = yield* projections.findThread(baseId);
      if (existing !== null) {
        if (store.instanceIds.includes(existing.providerInstanceId)) {
          if (existing.deletedAt !== null) {
            return { _tag: "Deleted", threadId: baseId } satisfies EntryOutcome;
          }
          if (existing.activeProviderThreadId !== null) {
            return {
              _tag: "Thread",
              threadId: baseId,
              providerThreadId: existing.activeProviderThreadId,
              cwd: head.cwd ?? null,
            } satisfies EntryOutcome;
          }
        }
        threadId = ThreadId.make(`claude:${sessionId}:${storeDigest(store.key)}`);
      }
    }
    const placement = yield* placements.resolve({ cwd: head.cwd, storeKey: store.key });
    if (placement === undefined)
      return { _tag: "Skipped", cwd: head.cwd ?? null, excluded: false } satisfies EntryOutcome;
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CLAUDE_PROVIDER,
      providerInstanceId: store.providerInstanceId,
      nativeThreadId: threadId === baseId ? sessionId : `${sessionId}@${threadId}`,
    });
    const updatedAt = DateTime.makeUnsafe(transcript.mtimeMs);
    const createdAt = head.startedAt ?? updatedAt;
    // An entry auto-settle would settle at once is created settled, so bringing old sessions in
    // sends no settle commands.
    const { sidebarAutoSettleAfterDays } = yield* settingsService.getSettings.pipe(
      Effect.mapError(fail("read settings")),
    );
    const settled =
      input.settled ||
      (sidebarAutoSettleAfterDays !== null &&
        transcript.mtimeMs <
          DateTime.toEpochMillis(yield* DateTime.now) - sidebarAutoSettleAfterDays * DAY_MS);
    const model = head.model ?? defaultModel;
    const thread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: placement.projectId,
      title: head.title ?? "Untitled thread",
      providerInstanceId: store.providerInstanceId,
      modelSelection: { instanceId: store.providerInstanceId, model },
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
      settledOverride: settled ? "settled" : null,
      settledAt: settled ? updatedAt : null,
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
      providerInstanceId: store.providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      // A send resumes this session, so it stays the one a terminal `claude --resume` continues.
      nativeThreadRef: { driver: CLAUDE_PROVIDER, nativeId: sessionId, strength: "strong" },
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
      // A copy of a session another store shows, or a restore, is a thread of its own.
      ...(threadId === baseId ? { unlessNativeThreadOwned: providerThread } : {}),
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          providerInstanceId: store.providerInstanceId,
          occurredAt: createdAt,
          payload: thread,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId }),
          type: "provider-thread.updated",
          threadId,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: store.providerInstanceId,
          occurredAt: updatedAt,
          payload: providerThread,
        },
      ],
    });
    if (committed.length === 0)
      return { _tag: "Skipped", cwd: head.cwd ?? null, excluded: false } satisfies EntryOutcome;
    yield* runtimes.upsert(
      {
        threadId,
        providerName: CLAUDE_PROVIDER,
        providerInstanceId: store.providerInstanceId,
        adapterKey: CLAUDE_PROVIDER,
        runtimeMode,
        status: "stopped",
        lastSeenAt: DateTime.formatIso(updatedAt),
        resumeCursor: { threadId, resume: sessionId },
        // The session's own directory, where a terminal `claude --resume` finds it.
        runtimePayload: { cwd: head.cwd ?? null },
      },
      { onConflict: "ignore" },
    );
    return {
      _tag: "Thread",
      threadId,
      providerThreadId,
      cwd: head.cwd ?? null,
    } satisfies EntryOutcome;
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

  /**
   * What identifies T3 Code's own turns in this thread: the prompt uuids it recorded, the replies it saw, and the prompt text of runs whose turns recorded no prompt uuid (older builds, or a turn that ended before its first reply).
   */
  // The id prefixes leave native turns and runs out before any payload is parsed.
  const ownTurns = Effect.fn("ClaudeSessionSync.ownTurns")(function* (
    providerThreadId: ProviderThreadId,
  ) {
    const turns = yield* sql<{
      readonly runId: string | null;
      readonly nativeId: string | null;
      readonly promptUuids: string | null;
    }>`
      SELECT attempt.run_id AS "runId",
        json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') AS "nativeId",
        json_extract(turn.payload_json, '$.nativePromptUuids') AS "promptUuids"
      FROM orchestration_v2_projection_provider_turns AS turn
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
      WHERE turn.provider_thread_id = ${providerThreadId}
        AND substr(turn.provider_turn_id, 1, ${NATIVE_PROVIDER_TURN_PREFIX.length}) <> ${NATIVE_PROVIDER_TURN_PREFIX}
    `;
    const promptUuids = new Set<string>();
    const assistantUuids = new Set<string>();
    const recordedRuns = new Set<string>();
    for (const turn of turns) {
      const replied = turn.nativeId !== null && !turn.nativeId.startsWith("turn:");
      if (replied && turn.nativeId !== null) assistantUuids.add(turn.nativeId);
      const uuids = Option.getOrElse(decodeStrings(turn.promptUuids), () => []);
      for (const uuid of uuids) promptUuids.add(uuid);
      // A turn recognised by a uuid needs no text match, which would otherwise catch a later terminal turn.
      if (turn.runId !== null && (uuids.length > 0 || replied)) recordedRuns.add(turn.runId);
    }
    const runs = yield* sql<{ readonly runId: string; readonly text: string | null }>`
      SELECT run.run_id AS "runId", json_extract(message.payload_json, '$.text') AS "text"
      FROM orchestration_v2_projection_runs AS run
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      WHERE run.provider_thread_id = ${providerThreadId}
        AND substr(run.run_id, 1, ${NATIVE_RUN_PREFIX.length}) <> ${NATIVE_RUN_PREFIX}
        AND run.status <> 'rolled_back'
        AND json_extract(run.payload_json, '$.nativeOrigin') IS NULL
    `;
    const promptTexts = new Map<string, number>();
    for (const run of runs) {
      if (recordedRuns.has(run.runId)) continue;
      const text = run.text?.trim() ?? "";
      if (text.length === 0) continue;
      const digest = claudePromptTextDigest(text);
      promptTexts.set(digest, (promptTexts.get(digest) ?? 0) + 1);
    }
    return { promptUuids, assistantUuids, promptTexts } satisfies ClaudeOwnTurns;
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
    // Runs under the thread's lock, so it never waits; the scheduler waits between steps instead.
    const flush = Effect.suspend(() => {
      const events = batch;
      batch = [];
      return eventSink.write({ events });
    });
    for (const group of groups) {
      if (batch.length > 0 && batch.length + group.length > MAX_EVENTS_PER_WRITE) yield* flush;
      for (const event of group) {
        batch.push(event);
        if (batch.length >= MAX_EVENTS_PER_WRITE) yield* flush;
      }
    }
    if (batch.length > 0) yield* flush;
  });

  const isSyncThread = (thread: OrchestrationV2AppThread) =>
    thread.createdBy === "system" && thread.id.startsWith("claude:");

  const updateThreadAfterRead = Effect.fn("ClaudeSessionSync.updateThreadAfterRead")(function* (
    target: ClaudeNativeRunTarget,
    plan: ReturnType<typeof planClaudeNativeRuns>,
    previousTitles: SyncTitles,
  ) {
    const titles: SyncTitles = {
      ...previousTitles,
      ...(plan.aiTitle === undefined ? {} : { ai: plan.aiTitle }),
      ...(plan.customTitle === undefined ? {} : { custom: plan.customTitle }),
    };
    const thread = yield* projections.findThread(target.threadId);
    if (thread === null) return titles;
    // Times come from the transcript, so reading an old session never makes it look just updated.
    const activity = plan.lastActivityAt;
    const later = (current: DateTime.Utc) =>
      activity !== undefined && DateTime.toEpochMillis(activity) > DateTime.toEpochMillis(current)
        ? activity
        : current;
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (plan.lastRunOrdinal !== undefined && plan.firstRunOrdinal !== undefined) {
      const records = yield* projections.getThreadRecords(target.threadId, ["providerThreads"]);
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === target.providerThreadId,
      );
      if (providerThread !== undefined) {
        const firstRunOrdinal = Math.min(
          providerThread.firstRunOrdinal ?? plan.firstRunOrdinal,
          plan.firstRunOrdinal,
        );
        const lastRunOrdinal = Math.max(providerThread.lastRunOrdinal ?? 0, plan.lastRunOrdinal);
        if (
          firstRunOrdinal !== providerThread.firstRunOrdinal ||
          lastRunOrdinal !== providerThread.lastRunOrdinal
        ) {
          const updatedAt = later(providerThread.updatedAt);
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
            type: "provider-thread.updated",
            threadId: target.threadId,
            driver: CLAUDE_PROVIDER,
            providerInstanceId: target.providerInstanceId,
            occurredAt: updatedAt,
            payload: { ...providerThread, firstRunOrdinal, lastRunOrdinal, updatedAt },
          });
        }
      }
    }
    // Only threads the sync made take Claude's titles, and only while nobody renamed it in T3 Code.
    const title = titles.custom ?? titles.ai;
    const untouched = titles.applied === undefined || thread.title === titles.applied;
    if (title !== undefined && isSyncThread(thread) && untouched && thread.title !== title) {
      const updatedAt = later(thread.updatedAt);
      events.push({
        id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
        type: "thread.metadata-updated",
        threadId: target.threadId,
        providerInstanceId: target.providerInstanceId,
        occurredAt: updatedAt,
        payload: { ...thread, title, updatedAt },
      });
    }
    // A session forked from another starts with a note saying which; it is run-less, so it sorts first.
    if (plan.forkedFromSessionId !== undefined && isSyncThread(thread)) {
      const noticeId = TurnItemId.make(`x:${target.idScope}:forked-from`);
      if (
        (yield* projections.getTurnItem({ threadId: target.threadId, itemId: noticeId })) === null
      ) {
        const message = `Forked from Claude session ${plan.forkedFromSessionId}.`;
        events.push({
          id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
          type: "turn-item.updated",
          threadId: target.threadId,
          occurredAt: thread.createdAt,
          payload: {
            id: noticeId,
            threadId: target.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: target.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: message,
            startedAt: thread.createdAt,
            completedAt: thread.createdAt,
            updatedAt: thread.createdAt,
            type: "system_notice",
            message,
          },
        });
      }
    }
    if (events.length > 0) yield* eventSink.write({ events });
    const appliedTitle = isSyncThread(thread) && untouched ? title : undefined;
    return appliedTitle === undefined ? titles : { ...titles, applied: appliedTitle };
  });

  /** The one run-less note a synced thread shows while its history loads, and how loading ended. */
  const historyNotice = Effect.fn("ClaudeSessionSync.historyNotice")(function* (
    thread: OrchestrationV2AppThread,
    target: ClaudeNativeRunTarget,
    state: { readonly status: "running" | "completed" | "failed"; readonly message: string },
  ) {
    const id = TurnItemId.make(`x:${target.idScope}:history`);
    const existing = yield* projections.getTurnItem({ threadId: target.threadId, itemId: id });
    if (
      existing !== null &&
      existing.type === "system_notice" &&
      existing.status === state.status &&
      existing.message === state.message
    ) {
      return;
    }
    const at = thread.createdAt;
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
          type: "turn-item.updated",
          threadId: target.threadId,
          occurredAt: at,
          payload: {
            id,
            threadId: target.threadId,
            runId: null,
            nodeId: null,
            providerThreadId: target.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: state.status,
            title: state.message,
            startedAt: at,
            completedAt: state.status === "running" ? null : at,
            updatedAt: at,
            type: "system_notice",
            message: state.message,
            ...(state.status === "failed" ? { level: "warning" as const } : {}),
          },
        },
      ],
    });
  });

  type IngestStep =
    | {
        readonly _tag: "Read";
        readonly row: ClaudeSessionSyncState.ClaudeSessionSyncState;
        readonly atEnd: boolean;
      }
    | { readonly _tag: "Deferred" }
    | { readonly _tag: "Deleted" };

  /** One bounded read of a transcript into its thread, under the thread's lock. */
  const ingestOnce = Effect.fn("ClaudeSessionSync.ingestOnce")(function* (input: {
    readonly row: ClaudeSessionSyncState.ClaudeSessionSyncState;
    readonly target: ClaudeNativeRunTarget;
    readonly own: ClaudeOwnTurns;
    readonly fallbackAt: DateTime.Utc;
  }) {
    const { row, target } = input;
    // Deletion can land between steps; nothing is written into a deleted thread.
    const thread = yield* projections.findThread(target.threadId);
    if (thread === null || thread.deletedAt !== null) {
      yield* markState(row, "deleted");
      return { _tag: "Deleted" } satisfies IngestStep;
    }
    const active = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
      LIMIT 1
    `;
    // T3 Code's live stream owns a turn it is running; its settling asks for a read again.
    if (active.length > 0) return { _tag: "Deferred" } satisfies IngestStep;
    const saved = Option.flatMap(Option.fromNullishOr(row.parserState), decodeSyncCursorState);
    const cursor = Option.isSome(saved) ? saved.value.cursor : initialClaudeTranscriptCursor;
    // Event ids only need to be unique; one random token per read and a counter make them so.
    const readToken = yield* random.uuidV4();
    let nextEvent = 0;
    const sessionKey = { storeKey: row.storeKey, sessionId: row.sessionId };
    const read = yield* readClaudeTranscript({
      filePath: row.filePath,
      sessionId: target.idScope,
      cursor,
      maxBytes: READ_BUDGET_BYTES,
      knownUuids: (uuids) => syncState.knownUuids(sessionKey, uuids),
    }).pipe(withHost);
    if (read.malformed.length > 0) {
      yield* Effect.logWarning("Skipped Claude transcript lines that could not be read", {
        sessionId: row.sessionId,
        offsets: read.malformed.map((line) => line.offset),
      });
    }
    const runState =
      read.rewritten || Option.isNone(saved) ? initialClaudeNativeRunState : saved.value.runs;
    const lookups = claudeNativeRunLookups({
      sessionId: target.idScope,
      state: runState,
      events: read.events,
    });
    const storedRuns = yield* storedRunsFor(target.idScope, [...lookups.segmentIds]);
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
      own: input.own,
      storedRuns,
      storedItems: new Map(
        storedItemRows.map((item) => [item.id, { settled: isSettledItemStatus(item.status) }]),
      ),
      storedToolItems,
      nextRunOrdinal: nextRun?.next ?? 1,
      nextProviderTurnOrdinal: nextTurn?.next ?? 1,
      eventId: () => EventId.make(`event:claude-sync:${readToken}:${nextEvent++}`),
      modelSlug,
      fallbackAt: input.fallbackAt,
    });
    yield* writeGroups(plan.groups);
    const titles = yield* updateThreadAfterRead(
      target,
      plan,
      Option.isSome(saved) ? (saved.value.titles ?? {}) : {},
    );
    const next: ClaudeSessionSyncState.ClaudeSessionSyncState = {
      ...row,
      byteOffset: read.cursor.offset,
      guardHash: read.cursor.tailHash,
      lastUuid: read.cursor.state.lastUuid,
      parserState: encodeSyncCursorState({ titles, cursor: read.cursor, runs: plan.state }),
      hydrationState: "hydrating",
      updatedAt: yield* DateTime.now,
    };
    // The consumed uuids and the position they belong to are saved together.
    yield* syncState.commitRead({
      state: next,
      consumedUuids: read.consumedUuids,
      fromTop: read.rewritten || cursor.offset === 0,
    });
    return { _tag: "Read", row: next, atEnd: read.atEnd } satisfies IngestStep;
  });

  type StepOutcome =
    | "deleted"
    | "pending"
    | "excluded"
    | "entry"
    | "follow"
    | "more"
    | "full"
    | "deferred"
    | "paused";

  /**
   * One bounded step for one session, under its lock. `entry` creates its thread with no history, and says `follow` when T3 Code already drives the session. `full` reads the next part of its history and says `more` until it is read. A thread the user deleted is never recreated; one in an excluded directory is archived and not followed.
   */
  const syncStep = Effect.fn("ClaudeSessionSync.syncStep")(
    function* (input: {
      readonly store: SyncStore;
      readonly transcript: Transcript;
      readonly mode: "entry" | "full";
      readonly live: boolean;
      readonly options: ServerSettings["claudeSessionSync"];
    }) {
      const { store, transcript, options } = input;
      const key = { storeKey: store.key, sessionId: transcript.sessionId };
      const row = yield* syncState.get(key);
      if (row?.hydrationState === "deleted") return "deleted" satisfies StepOutcome;
      const base: ClaudeSessionSyncState.ClaudeSessionSyncState = {
        ...(row ?? {
          ...key,
          byteOffset: 0,
          guardHash: null,
          lastUuid: null,
          threadId: null,
          providerThreadId: null,
          accountUuids: [],
          hydrationState: "pending",
          cwd: null,
          parserState: null,
          fileSize: 0,
          fileMtimeMs: 0,
        }),
        filePath: transcript.filePath,
        fileIdentity: transcript.fileIdentity,
        updatedAt: yield* DateTime.now,
      };
      const caughtUp = { fileSize: transcript.size, fileMtimeMs: transcript.mtimeMs };
      let threadId = base.threadId;
      let providerThreadId = base.providerThreadId;
      let cwd = base.cwd;
      let owned = false;
      if (threadId === null) {
        const owner = yield* syncState.findProviderThreadInInstances({
          nativeSessionId: transcript.sessionId,
          providerInstanceIds: store.instanceIds,
        });
        if (owner?.threadId != null) {
          threadId = owner.threadId;
          providerThreadId = owner.providerThreadId;
          owned = true;
        }
      }
      if (threadId === null) {
        const created = yield* createEntry({
          store,
          transcript,
          settled: !input.live,
          excludedCwdGlobs: options.excludedCwdGlobs,
        });
        if (created._tag === "Deleted") {
          yield* markState({ ...base, threadId: created.threadId }, "deleted");
          return "deleted" satisfies StepOutcome;
        }
        if (created._tag === "Skipped") {
          const hydrationState = created.excluded ? "excluded" : "pending";
          yield* syncState.upsert({ ...base, ...caughtUp, cwd: created.cwd, hydrationState });
          return hydrationState satisfies StepOutcome;
        }
        threadId = created.threadId;
        providerThreadId = created.providerThreadId;
        cwd = created.cwd;
      }
      const thread = yield* projections.findThread(threadId);
      if (thread === null || thread.deletedAt !== null) {
        yield* markState({ ...base, threadId }, "deleted");
        return "deleted" satisfies StepOutcome;
      }
      const linked = { ...base, threadId, providerThreadId, cwd };
      // A directory excluded after its entry was made has its sync thread archived, and restored when the exclusion goes.
      const excluded = isSyncThread(thread) && isExcluded(options.excludedCwdGlobs, cwd);
      if (excluded || linked.hydrationState === "excluded") {
        const archive = excluded && thread.archivedAt === null;
        const unarchive = !excluded && thread.archivedAt !== null;
        if (archive || unarchive) {
          const at = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: archive ? "thread.archived" : "thread.unarchived",
                threadId,
                providerInstanceId: thread.providerInstanceId,
                occurredAt: at,
                payload: { ...thread, archivedAt: archive ? at : null },
              },
            ],
          });
        }
        if (excluded) {
          yield* syncState.upsert({ ...linked, ...caughtUp, hydrationState: "excluded" });
          return "excluded" satisfies StepOutcome;
        }
        linked.hydrationState = "entry";
      }
      // Old imports hold run-less history; migrating them is separate work, so they are left as they are.
      if (thread.historyOrigin === "v1_import" || providerThreadId === null) {
        yield* syncState.upsert({ ...linked, ...caughtUp, hydrationState: "pending" });
        return "pending" satisfies StepOutcome;
      }
      if (input.mode === "entry") {
        const hydrationState =
          linked.hydrationState === "pending" || linked.hydrationState === "failed"
            ? "entry"
            : linked.hydrationState;
        // A followed or part-read session keeps its old size, so the next request reads what changed.
        yield* syncState.upsert(
          hydrationState === "entry" ? { ...linked, ...caughtUp, hydrationState } : linked,
        );
        return owned || hydrationState !== "entry"
          ? ("follow" satisfies StepOutcome)
          : ("entry" satisfies StepOutcome);
      }
      const target: ClaudeNativeRunTarget = {
        sessionId: transcript.sessionId,
        idScope: idScopeOf(threadId, transcript.sessionId),
        threadId,
        providerThreadId,
        providerInstanceId: thread.providerInstanceId,
        modelSelection: thread.modelSelection,
        skipCopied: thread.forkedFrom !== null || thread.lineage.relationshipToParent === "fork",
      };
      const notice = isSyncThread(thread) && linked.hydrationState !== "full";
      // Checked before every step, so no read writes past the floor.
      const free = yield* capacity.freeDiskBytes;
      if (free !== undefined && free < options.minFreeDiskGiB * 1024 ** 3) {
        if (notice) {
          yield* historyNotice(thread, target, {
            status: "failed",
            message: `History not loaded: the disk holding T3 Code's data is below the ${options.minFreeDiskGiB} GB the Claude session sync keeps free.`,
          });
        }
        yield* syncState.upsert(linked);
        return "paused" satisfies StepOutcome;
      }
      if (notice && linked.hydrationState !== "hydrating") {
        yield* historyNotice(thread, target, {
          status: "running",
          message: "Loading this session's history from Claude Code.",
        });
      }
      const read = yield* threadCommands.withLock(
        threadId,
        ingestOnce({
          row: linked,
          target,
          own: yield* ownTurns(providerThreadId),
          fallbackAt: DateTime.makeUnsafe(transcript.mtimeMs),
        }),
      );
      if (read._tag === "Deleted") return "deleted" satisfies StepOutcome;
      if (read._tag === "Deferred") {
        yield* syncState.upsert(linked);
        return "deferred" satisfies StepOutcome;
      }
      if (!read.atEnd) return "more" satisfies StepOutcome;
      yield* syncState.upsert({ ...read.row, ...caughtUp, hydrationState: "full" });
      if (notice) {
        yield* historyNotice(thread, target, {
          status: "completed",
          message: "History read from Claude Code's transcript.",
        });
      }
      return "full" satisfies StepOutcome;
    },
    (effect, input) =>
      sessionLocks
        .withLock(requestKey(input.store.key, input.transcript.sessionId), effect)
        .pipe(Effect.mapError(fail("sync a session", input.transcript.sessionId))),
  );

  // Scheduler invariants: a session is queued once; a step that has more goes to the back of its
  // lane, so appending sessions advance in turn; urgent work never waits on host load; each step
  // waits for live subscribers outside any lock; a session is asked for again only when its
  // file's size or mtime changed, or a T3 Code run on its thread settled.
  const requestKey = (storeKey: string, sessionId: string) => `${storeKey}\0${sessionId}`;
  const queued = new Map<string, HydrationRequest>();
  const lanes = { urgent: new Fifo<string>(), fill: new Fifo<string>() };
  const wake = yield* Queue.unbounded<void>();
  // The size and mtime each session's file had at its last step that left nothing to read.
  const seen = new Map<string, string>();
  // Sessions paused below the free-disk floor; the sweep asks for them again.
  const paused = new Map<string, HydrationRequest>();
  const signature = (transcript: Transcript) => `${transcript.size}:${transcript.mtimeMs}`;

  const request = Effect.fn("ClaudeSessionSync.request")(function* (next: HydrationRequest) {
    const key = requestKey(next.store.key, next.sessionId);
    const known = queued.get(key);
    if (known !== undefined && (known.lane === "urgent" || next.lane === "fill")) return;
    queued.set(key, { ...next, filePath: next.filePath ?? known?.filePath });
    lanes[next.lane].push(key);
    yield* Queue.offer(wake, undefined);
  });

  const take = (lane: Lane): HydrationRequest | undefined => {
    for (let key = lanes[lane].shift(); key !== undefined; key = lanes[lane].shift()) {
      const next = queued.get(key);
      // A key promoted to the urgent lane is still in the fill lane; it is taken from urgent only.
      if (next !== undefined && next.lane === lane) {
        queued.delete(key);
        return next;
      }
    }
    return undefined;
  };

  /** Runs one step of one request, and queues it again when it has more. */
  const runRequest = Effect.fn("ClaudeSessionSync.runRequest")(function* (next: HydrationRequest) {
    const { settings, stores } = yield* currentState;
    if (!settings.claudeSessionSync.enabled) return;
    const store = stores.find((candidate) => candidate.key === next.store.key);
    if (store === undefined) return;
    const key = requestKey(store.key, next.sessionId);
    const row = yield* syncState
      .get({ storeKey: store.key, sessionId: next.sessionId })
      .pipe(Effect.mapError(fail("read a session", next.sessionId)));
    const filePath = next.filePath ?? row?.filePath;
    if (filePath === undefined) return;
    const transcript = yield* statTranscript(next.sessionId, filePath);
    if (transcript === undefined) {
      if (row !== undefined) {
        yield* markState(row, "failed").pipe(
          Effect.mapError(fail("mark a session", next.sessionId)),
        );
      }
      return;
    }
    yield* capacity.subscribersReady;
    if (next.lane === "fill") yield* capacity.hostIdle;
    const outcome = yield* syncStep({
      store,
      transcript,
      mode: "full",
      live: liveIn(store).has(next.sessionId),
      options: settings.claudeSessionSync,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // A settings change or shutdown interrupts a step; that is not a failure of the session.
          if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
          const latest = yield* syncState
            .get({ storeKey: store.key, sessionId: next.sessionId })
            .pipe(Effect.orElseSucceed(() => undefined));
          if (latest !== undefined) {
            yield* markState(
              { ...latest, fileSize: transcript.size, fileMtimeMs: transcript.mtimeMs },
              "failed",
            ).pipe(Effect.ignore);
          }
          seen.set(key, signature(transcript));
          return yield* fail("hydrate a session", next.sessionId)(Cause.squash(cause));
        }),
      ),
    );
    if (outcome === "more") {
      yield* request({ ...next, filePath: transcript.filePath });
    } else if (outcome === "paused") {
      paused.set(key, { ...next, filePath: transcript.filePath });
    } else {
      seen.set(key, signature(transcript));
    }
  });

  const fillNext = Effect.fn("ClaudeSessionSync.fillNext")(function* () {
    const { settings, stores } = yield* currentState;
    const options = settings.claudeSessionSync;
    if (!options.enabled || !options.backgroundFill) return false;
    const free = yield* capacity.freeDiskBytes;
    if (free !== undefined && free < options.minFreeDiskGiB * 1024 ** 3) return false;
    const row = yield* syncState
      .nextEntryToHydrate(stores.map((store) => store.key))
      .pipe(Effect.mapError(fail("find the next session to fill")));
    const store =
      row === undefined ? undefined : stores.find((candidate) => candidate.key === row.storeKey);
    if (row === undefined || store === undefined) return false;
    yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "fill" });
    return true;
  });

  const drain: ClaudeSessionSync["Service"]["drain"] = Effect.gen(function* () {
    const failures: Array<ClaudeSessionSyncError> = [];
    for (;;) {
      const next = take("urgent") ?? take("fill");
      if (next === undefined) {
        const filled = yield* fillNext().pipe(Effect.orElseSucceed(() => false));
        if (filled) continue;
        return failures;
      }
      yield* runRequest(next).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not hydrate a Claude session", { error }).pipe(
            Effect.andThen(Effect.sync(() => failures.push(error))),
          ),
        ),
      );
    }
  }).pipe(Effect.withSpan("ClaudeSessionSync.drain"));

  // Sessions each store's registry holds with a live process, refreshed every few polls.
  const live = new Map<string, ReadonlySet<string>>();
  const liveIn = (store: SyncStore) => live.get(store.key) ?? new Set<string>();
  // Paths of sessions the sync has seen, so a poll stats one file rather than reading rows.
  const knownPaths = new Map<string, string>();

  const sweepStore = Effect.fn("ClaudeSessionSync.sweepStore")(function* (
    store: SyncStore,
    settings: ServerSettings,
    full: boolean,
    failures: Array<ClaudeSessionSyncError>,
  ) {
    const options = settings.claudeSessionSync;
    const recentSince =
      DateTime.toEpochMillis(yield* DateTime.now) - options.hydrateRecentDays * DAY_MS;
    live.set(store.key, yield* liveSessions.read(store.sessionsDir));
    const rows = new Map(
      (yield* syncState
        .listStoreSummaries(store.key)
        .pipe(Effect.mapError(fail("list sessions")))).map((row) => [row.sessionId, row]),
    );
    const transcripts = yield* listTranscripts(store, full).pipe(
      Effect.mapError(fail("list transcripts")),
    );
    for (const transcript of transcripts) {
      const key = requestKey(store.key, transcript.sessionId);
      const row = rows.get(transcript.sessionId);
      if (row?.hydrationState === "deleted") continue;
      // A copy of the session in another directory is ignored unless it changed later.
      if (
        row !== undefined &&
        row.filePath !== transcript.filePath &&
        transcript.mtimeMs <= row.fileMtimeMs
      ) {
        continue;
      }
      knownPaths.set(key, transcript.filePath);
      const unchanged =
        row !== undefined &&
        row.filePath === transcript.filePath &&
        row.fileSize === transcript.size &&
        row.fileMtimeMs === transcript.mtimeMs;
      // An exclusion added or removed since applies to sessions whose files did not change.
      const exclusionChanged =
        row !== undefined &&
        row.threadId !== null &&
        (row.hydrationState === "excluded") !== isExcluded(options.excludedCwdGlobs, row.cwd);
      const lookAgain = full && row?.hydrationState === "pending";
      if (unchanged && !exclusionChanged && !lookAgain) continue;
      yield* capacity.hostIdle;
      const isLive = liveIn(store).has(transcript.sessionId);
      const outcome = yield* syncStep({
        store,
        transcript,
        mode: "entry",
        live: isLive,
        options,
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not sync a Claude session", { error }).pipe(
            Effect.andThen(Effect.sync(() => failures.push(error))),
            Effect.as(undefined),
          ),
        ),
      );
      const lane: Lane | undefined =
        outcome === "follow" || (outcome === "entry" && isLive)
          ? "urgent"
          : outcome === "entry" && options.backgroundFill && transcript.mtimeMs >= recentSince
            ? "fill"
            : undefined;
      if (lane !== undefined) {
        yield* request({
          store,
          sessionId: transcript.sessionId,
          filePath: transcript.filePath,
          lane,
        });
      }
    }
    // A history whose reading stopped part-way, as at a shutdown, is finished whether or not its file changed.
    for (const row of rows.values()) {
      if (row.hydrationState !== "hydrating") continue;
      yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "urgent" });
    }
  });

  const sweep: ClaudeSessionSync["Service"]["sweep"] = Effect.fn("ClaudeSessionSync.sweep")(
    function* (options) {
      const { settings, stores } = yield* currentState;
      const failures: Array<ClaudeSessionSyncError> = [];
      if (!settings.claudeSessionSync.enabled) return failures;
      for (const store of stores) {
        yield* sweepStore(store, settings, options?.full === true, failures);
      }
      const waiting = [...paused.values()];
      paused.clear();
      for (const next of waiting) yield* request(next);
      return failures;
    },
  );

  let polls = 0;

  const pollLive: ClaudeSessionSync["Service"]["pollLive"] = Effect.gen(function* () {
    const { settings, stores } = yield* currentState;
    if (!settings.claudeSessionSync.enabled) return;
    const refresh = polls++ % REGISTRY_EVERY === 0;
    for (const store of stores) {
      if (refresh) {
        const before = liveIn(store);
        const now = yield* liveSessions.read(store.sessionsDir);
        live.set(store.key, now);
        // A session that just went live and has never been seen is looked for once.
        for (const sessionId of now) {
          const key = requestKey(store.key, sessionId);
          if (before.has(sessionId) || knownPaths.has(key)) continue;
          const found = yield* findTranscript(store, sessionId);
          if (found !== undefined) knownPaths.set(key, found.filePath);
        }
      }
      for (const sessionId of liveIn(store)) {
        const key = requestKey(store.key, sessionId);
        const filePath = knownPaths.get(key);
        if (filePath === undefined) continue;
        const transcript = yield* statTranscript(sessionId, filePath);
        if (transcript === undefined || seen.get(key) === signature(transcript)) continue;
        yield* request({ store, sessionId, filePath, lane: "urgent" });
      }
    }
  }).pipe(Effect.withSpan("ClaudeSessionSync.pollLive"));

  const requestForThread = Effect.fn("ClaudeSessionSync.requestForThread")(function* (
    threadId: ThreadId,
    forget: boolean,
  ) {
    const { settings, stores } = yield* currentState;
    if (!settings.claudeSessionSync.enabled) return;
    const row = yield* syncState
      .findByThreadId(threadId)
      .pipe(Effect.mapError(fail("find a thread's session")));
    if (row === undefined || row.hydrationState === "deleted") return;
    if (row.hydrationState === "full" && !forget) return;
    const store = stores.find((candidate) => candidate.key === row.storeKey);
    if (store === undefined) return;
    const key = requestKey(store.key, row.sessionId);
    if (forget) seen.delete(key);
    knownPaths.set(key, row.filePath);
    yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "urgent" });
  });

  const hydrateThread: ClaudeSessionSync["Service"]["hydrateThread"] = (threadId) =>
    requestForThread(threadId, false);

  const runSettled: ClaudeSessionSync["Service"]["runSettled"] = (threadId) =>
    requestForThread(threadId, true);

  /** Shows a deleted session again as a new thread, since the deleted one's content is being purged. */
  const restoreRow = Effect.fn("ClaudeSessionSync.restoreRow")(function* (
    store: SyncStore,
    row: ClaudeSessionSyncState.ClaudeSessionSyncState,
  ) {
    const transcript = yield* statTranscript(row.sessionId, row.filePath);
    if (transcript === undefined) return;
    const created = yield* createEntry({
      store,
      transcript,
      settled: false,
      excludedCwdGlobs: [],
      restoredAt: DateTime.toEpochMillis(yield* DateTime.now),
    });
    if (created._tag !== "Thread") return;
    yield* syncState.upsert({
      ...row,
      threadId: created.threadId,
      providerThreadId: created.providerThreadId,
      cwd: created.cwd,
      hydrationState: "entry",
      byteOffset: 0,
      guardHash: null,
      lastUuid: null,
      parserState: null,
      fileSize: transcript.size,
      fileMtimeMs: transcript.mtimeMs,
      updatedAt: yield* DateTime.now,
    });
    yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "urgent" });
  });

  const applyRestores: ClaudeSessionSync["Service"]["applyRestores"] = Effect.gen(function* () {
    const { settings, stores } = yield* currentState;
    const ids = settings.claudeSessionSync.restoreSessionIds;
    if (ids.length === 0) return;
    for (const sessionId of ids) {
      for (const store of stores) {
        const row = yield* syncState
          .get({ storeKey: store.key, sessionId })
          .pipe(Effect.mapError(fail("read a session", sessionId)));
        if (row?.hydrationState === "deleted") {
          yield* restoreRow(store, row).pipe(Effect.mapError(fail("restore a session", sessionId)));
        }
      }
    }
    const latest = yield* settingsService.getSettings.pipe(Effect.mapError(fail("read settings")));
    yield* settingsService
      .updateSettings({
        claudeSessionSync: {
          restoreSessionIds: latest.claudeSessionSync.restoreSessionIds.filter(
            (id) => !ids.includes(id),
          ),
        },
      })
      .pipe(Effect.mapError(fail("clear restored sessions")));
  }).pipe(Effect.withSpan("ClaudeSessionSync.applyRestores"));

  const registerAdditionalHomes: ClaudeSessionSync["Service"]["registerAdditionalHomes"] =
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(fail("read settings")),
      );
      let wrote = false;
      for (const store of yield* resolveStoresUncached(settings)) {
        for (const instanceId of store.instanceIds) {
          if (Object.hasOwn(settings.providerInstances, instanceId)) continue;
          if (instanceId === ProviderInstanceId.make(CLAUDE_PROVIDER)) continue;
          const home = settings.claudeSessionSync.additionalHomes
            .map((extra) => path.resolve(expandHomePath(extra, homeDirectory)))
            .find((candidate) => additionalHomeInstanceId(candidate) === instanceId);
          if (home === undefined) continue;
          yield* settingsService
            .updateProviderInstance({
              operation: "upsert",
              instanceId,
              instance: {
                driver: CLAUDE_PROVIDER,
                displayName: `Claude (${path.basename(home) || home})`,
                config: { homePath: home },
              },
            })
            .pipe(Effect.mapError(fail("register an instance for an additional Claude home")));
          wrote = true;
        }
      }
      return wrote;
    }).pipe(Effect.withSpan("ClaudeSessionSync.registerAdditionalHomes"));

  const logged = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.catchCause((cause) => Effect.logWarning(label, { cause })));

  const worker = Effect.gen(function* () {
    for (;;) {
      yield* logged("Claude session hydration failed", drain);
      yield* Queue.take(wake);
      yield* Queue.clear(wake);
    }
  });

  const run = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(worker);
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (let sweepCount = 0; ; sweepCount++) {
            // The first sweep after a start or a settings change is full.
            const failures = yield* logged(
              "Claude session sweep failed",
              sweep({ full: sweepCount % FULL_SWEEP_EVERY === 0 }),
            );
            if (Array.isArray(failures) && failures.length > 0) {
              yield* Effect.logWarning("Some Claude sessions could not be synced", {
                count: failures.length,
              });
            }
            yield* Queue.offer(wake, undefined);
            yield* Effect.sleep(SWEEP_INTERVAL);
          }
        }),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (;;) {
            yield* logged("Claude live session poll failed", pollLive);
            yield* Effect.sleep(LIVE_POLL_INTERVAL);
          }
        }),
      );
      const latest = yield* eventSink.latestSequence();
      yield* eventSink.stream({ afterSequence: latest, eventType: "thread.visit-recorded" }).pipe(
        Stream.runForEach((stored) =>
          logged(
            "Could not request a Claude session's history",
            hydrateThread(stored.event.threadId),
          ),
        ),
        (effect) => logged("Claude session visit stream failed", effect),
        Effect.forkScoped,
      );
      yield* eventSink.stream({ afterSequence: latest, eventType: "run.updated" }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" &&
          SETTLED_RUN_STATUSES.has(stored.event.payload.status) &&
          !isNativeOriginRun(stored.event.payload)
            ? logged("Could not request a read after a run", runSettled(stored.event.threadId))
            : Effect.void,
        ),
        (effect) => logged("Claude session run stream failed", effect),
        Effect.forkScoped,
      );
      return yield* Effect.never;
    }),
  );

  // The restore list is the one setting the sync writes back, so it is left out of what restarts it.
  const runKey = (settings: ServerSettings) =>
    JSON.stringify([
      { ...settings.claudeSessionSync, restoreSessionIds: [] },
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
        if (settings.claudeSessionSync.enabled) {
          // Registering an instance changes the settings; the change applies them again.
          if (
            yield* logged(
              "Could not register additional Claude homes",
              registerAdditionalHomes,
            ).pipe(Effect.map((wrote) => wrote === true))
          ) {
            return;
          }
          yield* logged("Could not restore Claude sessions", applyRestores);
        }
        const key = runKey(settings);
        if (key === appliedKey) return;
        appliedKey = key;
        if (running !== undefined) yield* Fiber.interrupt(running);
        listedDirectories.clear();
        running = settings.claudeSessionSync.enabled
          ? yield* logged("Claude session sync stopped", run).pipe(Effect.forkIn(scope))
          : undefined;
      });
      yield* forkParked(
        Effect.gen(function* () {
          yield* apply(yield* settingsService.getSettings.pipe(Effect.orDie));
          yield* Stream.runForEach(changes, apply);
        }),
      );
    },
  );

  return ClaudeSessionSync.of({
    start,
    sweep,
    pollLive,
    drain,
    hydrateThread,
    runSettled,
    applyRestores,
    registerAdditionalHomes,
  });
});

export const layer = Layer.effect(ClaudeSessionSync, make);
