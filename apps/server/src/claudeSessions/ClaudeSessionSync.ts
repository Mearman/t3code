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
  type NodeId,
  type RunId,
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
import { runOriginSql } from "../orchestration-v2/runOriginSql.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import { deriveTitle } from "../project/AgentSessionScanner.ts";
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
  claimClaudeOwnTurnByText,
  claudeNativeItemLineUuid,
  claudeNativeOrdinals,
  claudeNativeResultsNeedWholeTurn,
  claudeNativeRunIds,
  claudeNativeTurnItemIds,
  claudePromptTextKey,
  isClaudeOwnTurn,
  NATIVE_PROVIDER_TURN_PREFIX,
  newClaudeNativeTurnCache,
  parseTranscriptTime,
  planClaudeNativeTurn,
  planClaudeRemovedItems,
  REMOVED_TURN_ID,
  type ClaudeNativeRunTarget,
  type ClaudeNativeTurnCache,
  type ClaudeOwnTurns,
  type StoredNativeItem,
} from "./ClaudeNativeRuns.ts";
import * as ClaudeSessionProjects from "./ClaudeSessionProjects.ts";
import * as ClaudeLiveSessions from "./ClaudeLiveSessions.ts";
import { resolveClaudeSessionStores } from "./ClaudeSessionStore.ts";
import * as ClaudeSyncCapacity from "./ClaudeSyncCapacity.ts";
import { ClaudeSyncQueue, type ClaudeSyncLane } from "./ClaudeSyncQueue.ts";
import { readClaudeTranscriptTurn } from "./ClaudeTranscriptContent.ts";
import { claudeTranscriptSessionId } from "./ClaudeTranscriptIndex.ts";
import { CLAUDE_SYNTHETIC_MODEL, decodeClaudeTranscriptLine } from "./ClaudeTranscriptLine.ts";
import {
  ClaudeTranscriptTurnTracker,
  syncClaudeTranscript,
} from "./ClaudeTranscriptTurnTracker.ts";
import type { ClaudeTranscriptStructure } from "./ClaudeTranscriptTurns.ts";

/** Bytes of transcript lines one step reads and writes while holding the thread's lock. */
const READ_BUDGET_BYTES = 64 * 1024;
/** Tracker memory kept for sessions neither live nor loading; the least recently used go first. */
const INDEX_MEMORY_BUDGET_BYTES = 256 * 1024 ** 2;
/** A turn tracker's measured memory per indexed line, its index included. */
const TRACKER_BYTES_PER_LINE = 207;
/** Events in one database transaction, so a long transcript never holds the writer for long. */
const MAX_EVENTS_PER_WRITE = 200;
/** A session's entry is read from its head in chunks of this size until its first prompt. */
const HEAD_CHUNK_BYTES = 64 * 1024;
/** IN lists are split so a query stays far below SQLite's bound-parameter limit. */
const LOOKUP_CHUNK = 500;
/** A quick sweep lists only project directories that changed; every sixth one stats every file. */
const SWEEP_INTERVAL = "5 minutes";
const FULL_SWEEP_EVERY = 6;
/** Live sessions' transcripts are polled this often; the registry is re-read when its listing changes, and every fifth poll. */
const LIVE_POLL_INTERVAL = "1 second";
const REGISTRY_EVERY = 5;
/** A live session's missing transcript is looked for again after at most this many polls; the sweep also finds it. */
const MISSING_TRANSCRIPT_MAX_POLLS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

type Lane = ClaudeSyncLane;
/** Opened sessions loading in turn at once; more would interleave and leave every one unfinished for longer. */
const LOADS_AT_ONCE = 2;
/** Live steps in a row before an opened one takes its turn: live latency stays one bounded step, and opened loads always progress. */
const LIVE_STEPS_PER_OPEN = 3;
/** How long the worker waits before looking at the host again while only the fill has work. */
const FILL_BACKOFF = "5 seconds";

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
/** The events a native run's lifecycle is written as, with no items or messages. */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.updated",
  "run-attempt.updated",
  "node.updated",
  "provider-turn.updated",
]);

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
     * Runs requests until none is left, one bounded step at a time, in `ClaudeSyncQueue`'s order: live, opened, then, with the background fill on and the host idle, the newest sessions that have only an entry. Returns the sessions that failed.
     */
    readonly drain: Effect.Effect<ReadonlyArray<ClaudeSessionSyncError>>;
    /** Requests the full history of the session a thread shows. */
    readonly hydrateThread: (threadId: ThreadId) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Requests a read after a run T3 Code executed settles, so its lines are passed over and later terminal ones shown. */
    readonly runSettled: (threadId: ThreadId) => Effect.Effect<void, ClaudeSessionSyncError>;
    /** Restores every deleted session `claudeSessionSync.restoreSessionIds` names as a new thread, then clears the list. */
    readonly applyRestores: Effect.Effect<void, ClaudeSessionSyncError>;
    /** Registers a Claude instance for each additional home no instance reaches, and removes one it registered for a home no longer listed; true when it changed any. */
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
                // Stored as text, so it holds no NUL: the SQLite client reads a text value back only up to one.
                key: JSON.stringify([store.projectsDir, store.sessionsDir]),
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
   * Reads a transcript from the top until its first prompt and the facts its entry needs: working directory, start time, title and model. Stops at the first prompt once those are known, else at the end of the file. A line longer than a chunk is held as pieces and joined once, when its newline arrives.
   */
  const scanHead = Effect.fn("ClaudeSessionSync.scanHead")(function* (filePath: string) {
    let cwd: string | undefined;
    let startedAt: DateTime.Utc | undefined;
    let model: string | undefined;
    let promptTitle: string | undefined;
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    // The first text of any other kind, for a session whose prompts give no title: a queued prompt, a command, a reply.
    let fallbackTitle: string | undefined;
    let hasConversation = false;
    const decoder = new TextDecoder();
    const readLine = (bytes: Uint8Array) => {
      const text = decoder.decode(bytes);
      const record = decodeJsonLine(text);
      if (Option.isSome(record)) {
        const lineCwd = field(record.value, "cwd");
        if (cwd === undefined && typeof lineCwd === "string") cwd = lineCwd;
        const timestamp = field(record.value, "timestamp");
        if (startedAt === undefined && typeof timestamp === "string") {
          startedAt = parseTranscriptTime(timestamp);
        }
      }
      const decoded = decodeClaudeTranscriptLine(text);
      if (decoded._tag !== "Record" || decoded.header.isSidechain === true) return;
      const { record: line } = decoded;
      if (line.kind === "title") {
        // A session someone or Claude named is shown, even with nothing else in it yet.
        hasConversation = true;
        if (line.source === "ai") aiTitle = line.title ?? aiTitle;
        else customTitle = line.title;
        return;
      }
      // Any exchange is a conversation, whatever its prompt shows: an image, a queued or meta prompt, shell output, a reply alone.
      if (line.kind === "conversation" || line.kind === "queued") hasConversation = true;
      if (line.kind === "localCommand") hasConversation = true;
      if (line.kind === "queued") fallbackTitle ??= deriveTitle("claudeAgent", line.visible.text);
      if (line.kind === "localCommand" && line.input !== undefined) {
        fallbackTitle ??= deriveTitle("claudeAgent", line.input.text);
      }
      if (line.kind === "conversation" && line.line.type === "assistant") {
        const reported = line.line.message.model;
        if (model === undefined && reported !== undefined && reported !== CLAUDE_SYNTHETIC_MODEL) {
          model = modelSlug(reported);
        }
        if (line.visible.text.length > 0) {
          fallbackTitle ??= deriveTitle("claudeAgent", line.visible.text);
        }
      } else if (
        line.kind === "conversation" &&
        line.line.isMeta !== true &&
        line.line.isCompactSummary !== true &&
        line.visible.text.length > 0
      ) {
        promptTitle ??= deriveTitle("claudeAgent", line.visible.titleText);
      }
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(filePath, { flag: "r" });
        let pending: Array<Uint8Array> = [];
        for (;;) {
          const chunk = yield* handle.readAlloc(HEAD_CHUNK_BYTES);
          if (Option.isNone(chunk)) return;
          const bytes = chunk.value;
          let start = 0;
          for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
            const piece = bytes.subarray(start, end);
            readLine(pending.length === 0 ? piece : Buffer.concat([...pending, piece]));
            pending = [];
            start = end + 1;
          }
          if (start < bytes.length) pending.push(bytes.subarray(start));
          if (hasConversation && cwd !== undefined && model !== undefined) return;
          yield* Effect.yieldNow;
        }
      }),
    );
    return {
      cwd,
      startedAt,
      model,
      customTitle,
      aiTitle,
      promptTitle: promptTitle ?? fallbackTitle,
      hasConversation,
    };
  });

  /**
   * The titles in a transcript's last chunk, where Claude Code writes a rename or a new AI title; the latest of each kind wins. A line cut by the chunk's start is skipped.
   */
  const scanTail = Effect.fn("ClaudeSessionSync.scanTail")(function* (transcript: Transcript) {
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    const start = Math.max(0, transcript.size - HEAD_CHUNK_BYTES);
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(transcript.filePath, { flag: "r" });
        yield* handle.seek(BigInt(start), "start");
        return yield* handle.readAlloc(transcript.size - start);
      }),
    );
    if (Option.isNone(bytes)) return { customTitle, aiTitle };
    const text = new TextDecoder().decode(bytes.value);
    const lines = text.split("\n");
    for (const lineText of start === 0 ? lines : lines.slice(1)) {
      const decoded = decodeClaudeTranscriptLine(lineText);
      if (decoded._tag !== "Record" || decoded.record.kind !== "title") continue;
      if (decoded.record.source === "ai") aiTitle = decoded.record.title ?? aiTitle;
      else customTitle = decoded.record.title;
    }
    return { customTitle, aiTitle };
  });

  /** The title an entry shows: a rename first, then Claude's own title, then the first prompt's. */
  const entryTitle = Effect.fn("ClaudeSessionSync.entryTitle")(function* (
    transcript: Transcript,
    head: {
      readonly customTitle: string | undefined;
      readonly aiTitle: string | undefined;
      readonly promptTitle: string | undefined;
    },
  ) {
    const tail = yield* scanTail(transcript);
    return tail.customTitle ?? head.customTitle ?? tail.aiTitle ?? head.aiTitle ?? head.promptTitle;
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
        /** The title the entry was made with; null for a thread that already existed. */
        readonly title: string | null;
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
    const head = yield* scanHead(transcript.filePath);
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
              title: null,
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
    const title = (yield* entryTitle(transcript, head)) ?? "Untitled thread";
    const thread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: placement.projectId,
      title,
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
      title,
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
    const promptTexts = new Map<number, number>();
    for (const run of runs) {
      if (recordedRuns.has(run.runId)) continue;
      // Compared with what the transcript recorded of the same text, so it is not trimmed.
      if (run.text === null || run.text.trim().length === 0) continue;
      const key = claudePromptTextKey(run.text);
      promptTexts.set(key, (promptTexts.get(key) ?? 0) + 1);
    }
    return { promptUuids, assistantUuids, promptTexts } satisfies ClaudeOwnTurns;
  });

  /** The run the sync wrote for a turn and its ordinals, or undefined when it wrote none. */
  const storedRunFor = Effect.fn("ClaudeSessionSync.storedRunFor")(function* (
    target: ClaudeNativeRunTarget,
    turnId: string,
  ) {
    const ids = claudeNativeRunIds(target.idScope, turnId);
    const run = yield* projections.getRun(target.threadId, ids.runId);
    const [turn] = yield* sql<{
      readonly ordinal: number;
      readonly model: string | null;
      readonly nativeTurnId: string | null;
    }>`
      SELECT
        ordinal,
        json_extract(payload_json, '$.model') AS "model",
        json_extract(payload_json, '$.nativeTurnRef.nativeId') AS "nativeTurnId"
      FROM orchestration_v2_projection_provider_turns
      WHERE provider_turn_id = ${ids.providerTurnId}
    `;
    return run === undefined || turn === undefined
      ? undefined
      : {
          run,
          ordinal: run.ordinal,
          providerTurnOrdinal: turn.ordinal,
          // What the provider turn records, which a run's model selection does not: a turn with no real model has none.
          model: turn.model ?? undefined,
          nativeTurnId: turn.nativeTurnId ?? undefined,
        };
  });

  /** The items a run holds for these lines: `x:<scope>:<line>` and its blocks `x:<scope>:<line>:<n>`. */
  const itemIdsOfLines = Effect.fn("ClaudeSessionSync.itemIdsOfLines")(function* (
    target: ClaudeNativeRunTarget,
    turnId: string,
    lineUuids: ReadonlyArray<string>,
  ) {
    const runId = claudeNativeRunIds(target.idScope, turnId).runId;
    const found: Array<string> = [];
    for (const lineUuid of lineUuids) {
      const base = `x:${target.idScope}:${lineUuid}`;
      // ";" follows ":" in code order, so the range holds exactly the line's block ids.
      const rows = yield* sql<{ readonly id: string }>`
        SELECT turn_item_id AS "id" FROM orchestration_v2_projection_turn_items
        WHERE run_id = ${runId}
          AND (turn_item_id = ${base} OR (turn_item_id > ${`${base}:`} AND turn_item_id < ${`${base};`}))
      `;
      for (const row of rows) found.push(row.id);
    }
    return found;
  });

  const storedItemsById = Effect.fn("ClaudeSessionSync.storedItemsById")(function* (
    itemIds: ReadonlyArray<string>,
  ) {
    const rows = yield* inChunks(
      itemIds,
      (chunk) => sql<{
        readonly id: string;
        readonly runId: string | null;
        readonly ordinal: number;
        readonly status: string;
      }>`
        SELECT turn_item_id AS "id", run_id AS "runId", ordinal, status
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(chunk)}
      `,
    );
    return new Map<string, StoredNativeItem>(rows.map((row) => [row.id, row]));
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

  const isDelegatedChild = (thread: Pick<OrchestrationV2AppThread, "id" | "lineage">) =>
    IdAllocator.isDelegatedTaskThread(thread.id) ||
    thread.lineage.relationshipToParent === "subagent";

  /** Marks a thread the sync follows as reading its history back from the transcript, so T3 Code's next run sorts after every turn before it. */
  const markFollowed = Effect.fn("ClaudeSessionSync.markFollowed")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    if (thread.historyOrigin === "native") return;
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: thread.id }),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: thread.updatedAt,
          payload: { ...thread, historyOrigin: "native" },
        },
      ],
    });
  });

  /**
   * Marks every T3 Code thread driving a Claude session in these stores before the sweep reaches its session, so a send made first still sorts after the terminal turns the sweep then reads. One indexed query; old imports and delegated children are passed over.
   */
  const markFollowedThreads = Effect.fn("ClaudeSessionSync.markFollowedThreads")(function* (
    stores: ReadonlyArray<SyncStore>,
  ) {
    const instanceIds = [...new Set(stores.flatMap((store) => store.instanceIds))];
    if (instanceIds.length === 0) return;
    const rows = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT DISTINCT thread.thread_id AS "threadId"
      FROM orchestration_v2_projection_provider_threads AS provider
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = provider.thread_id
      WHERE provider.driver = ${CLAUDE_PROVIDER}
        AND provider.provider_instance_id IN ${sql.in(instanceIds)}
        AND json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
        AND json_extract(thread.payload_json, '$.historyOrigin') IS NULL
    `;
    for (const { threadId } of rows) {
      const thread = yield* projections.findThread(threadId);
      if (thread === null || thread.deletedAt !== null || isDelegatedChild(thread)) continue;
      yield* markFollowed(thread);
    }
  });

  const updateThreadAfterRead = Effect.fn("ClaudeSessionSync.updateThreadAfterRead")(function* (
    target: ClaudeNativeRunTarget,
    structure: Omit<ClaudeTranscriptStructure, "turns">,
    written: {
      readonly firstRunOrdinal: number | undefined;
      readonly lastRunOrdinal: number | undefined;
      readonly lastActivityAt: DateTime.Utc | undefined;
    },
    appliedTitle: string | null,
  ) {
    const thread = yield* projections.findThread(target.threadId);
    if (thread === null) return appliedTitle;
    // Times come from the transcript, so reading an old session never makes it look just updated.
    const activity = written.lastActivityAt;
    const later = (current: DateTime.Utc) =>
      activity !== undefined && DateTime.toEpochMillis(activity) > DateTime.toEpochMillis(current)
        ? activity
        : current;
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (written.lastRunOrdinal !== undefined && written.firstRunOrdinal !== undefined) {
      const records = yield* projections.getThreadRecords(target.threadId, ["providerThreads"]);
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === target.providerThreadId,
      );
      if (providerThread !== undefined) {
        const firstRunOrdinal = Math.min(
          providerThread.firstRunOrdinal ?? written.firstRunOrdinal,
          written.firstRunOrdinal,
        );
        // `lastRunOrdinal` names the T3 Code run that owns the provider thread, and its late writes are
        // refused once another run claims it, so the sync moves it only past its own native runs.
        const current = providerThread.lastRunOrdinal;
        const heldByT3 =
          current !== null &&
          (yield* sql<{ readonly id: string }>`
            SELECT run_id AS "id" FROM orchestration_v2_projection_runs
            WHERE thread_id = ${target.threadId} AND ordinal = ${current}
              AND run_id NOT LIKE ${`${NATIVE_RUN_PREFIX}%`}
            LIMIT 1
          `).length > 0;
        const lastRunOrdinal =
          current !== null && heldByT3 ? current : Math.max(current ?? 0, written.lastRunOrdinal);
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
    const title = structure.customTitle ?? structure.aiTitle;
    const untouched = appliedTitle === null || thread.title === appliedTitle;
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
    const forkedFrom =
      structure.forkedFromSessionId ??
      structure.derivedFrom.find((session) => session.via === "fork")?.sessionId;
    if (forkedFrom !== undefined && isSyncThread(thread)) {
      const noticeId = TurnItemId.make(`x:${target.idScope}:forked-from`);
      if (
        (yield* projections.getTurnItem({ threadId: target.threadId, itemId: noticeId })) === null
      ) {
        const message = `Forked from Claude session ${forkedFrom}.`;
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
    return isSyncThread(thread) && untouched && title !== undefined ? title : appliedTitle;
  });

  /**
   * A run-less note on a thread: `history` while a synced thread's history loads and how loading ended; `disk` when following a loaded or T3 Code thread stopped at the free-disk floor, and when it went on again.
   */
  const threadNotice = Effect.fn("ClaudeSessionSync.threadNotice")(function* (
    thread: OrchestrationV2AppThread,
    target: ClaudeNativeRunTarget,
    kind: "history",
    state: { readonly status: "running" | "completed" | "failed"; readonly message: string },
  ) {
    const id = TurnItemId.make(`x:${target.idScope}:${kind}`);
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

  /**
   * The run ordinals of a thread as the sync sees them: each shown native turn's stored ordinal, the values other runs and provider turns hold, and the ordinals `claudeNativeOrdinals` gives the shown turns, worked out again when the tracker or `taken` changes. A shown turn whose stored ordinal differs is in `moved`.
   */
  interface OrdinalState {
    readonly stored: Map<string, number>;
    readonly taken: Set<number>;
    desired: { readonly version: number; readonly byTurn: ReadonlyMap<string, number> } | undefined;
    readonly moved: Set<string>;
  }

  /** Which turns are T3 Code's own, and the text matches still to claim; see `isClaudeOwnTurn`. */
  interface OwnState {
    readonly turns: Set<string>;
    readonly unclaimed: Map<number, number>;
  }

  /**
   * A session held in memory between steps, so a live or opened session reads only what its file gains: its turn tracker, the turns still to write, newest first, and the turns gone since they were written. A cache is kept only for a turn that has not ended. Sessions neither live nor being loaded are let go, least recently used first, once all held sessions exceed `INDEX_MEMORY_BUDGET_BYTES`; letting one go only costs reading its file again.
   */
  interface HeldSession {
    readonly storeKey: string;
    readonly sessionId: string;
    readonly tracker: ClaudeTranscriptTurnTracker;
    filePath: string;
    thread:
      | {
          readonly threadId: ThreadId;
          readonly digests: Map<string, string>;
          own: OwnState | undefined;
          ordinals: OrdinalState | undefined;
          // Written turns the file no longer has are rolled back once a restart's first pass ends.
          reconciled: boolean;
        }
      | undefined;
    readonly pending: Set<string>;
    order: Array<string> | undefined;
    readonly removed: Set<string>;
    readonly caches: Map<string, ClaudeNativeTurnCache>;
    bytes: number;
  }
  const heldSessions = new Map<string, HeldSession>();

  const holdSession = (storeKey: string, transcript: Transcript): HeldSession => {
    const key = requestKey(storeKey, transcript.sessionId);
    const known = heldSessions.get(key);
    // Re-inserted, so the map's order is least recently used first.
    heldSessions.delete(key);
    const held: HeldSession =
      known !== undefined && known.filePath === transcript.filePath
        ? known
        : {
            storeKey,
            sessionId: transcript.sessionId,
            tracker: new ClaudeTranscriptTurnTracker(),
            filePath: transcript.filePath,
            thread: undefined,
            pending: new Set(),
            order: undefined,
            removed: new Set(),
            caches: new Map(),
            bytes: 0,
          };
    heldSessions.set(key, held);
    return held;
  };

  /** Reads what the file gained into the tracker, and notes which turns now need writing or rolling back. */
  const syncHeld = Effect.fn("ClaudeSessionSync.syncHeld")(function* (held: HeldSession) {
    const result = yield* syncClaudeTranscript({
      filePath: held.filePath,
      tracker: held.tracker,
    }).pipe(withHost);
    if (result.malformedOffsets.length > 0) {
      yield* Effect.logWarning("Skipped Claude transcript lines that could not be read", {
        sessionId: held.sessionId,
        offsets: result.malformedOffsets,
      });
    }
    for (const turnId of result.removedTurnIds) {
      held.pending.delete(turnId);
      held.caches.delete(turnId);
      held.removed.add(turnId);
    }
    const fresh = result.changedTurnIds.filter((turnId) => !held.pending.has(turnId));
    for (const turnId of result.changedTurnIds) {
      held.pending.add(turnId);
      held.removed.delete(turnId);
    }
    // One new turn is written next; more, as on a first read, are put in turn order once.
    if (held.order !== undefined && fresh.length === 1) held.order.push(...fresh);
    else if (fresh.length > 0) held.order = undefined;
    held.bytes = held.tracker.index.entryCount * TRACKER_BYTES_PER_LINE;
    return result;
  });

  /**
   * The turns still to write, taken from the end: first the stored runs that move to a lower ordinal, lowest first, then the rest newest first. In that order no run's new ordinal is still held by a run not yet written, so the thread's unique ordinal index is never crossed.
   */
  const pendingInOrder = (held: HeldSession, ordinals: OrdinalState): Array<string> => {
    if (held.order !== undefined) return held.order;
    const desired = ordinals.desired?.byTurn;
    const lower = (turnId: string) => {
      const stored = ordinals.stored.get(turnId);
      const next = desired?.get(turnId);
      return stored !== undefined && next !== undefined && next < stored;
    };
    const pending = held.tracker.turnIds().filter((turnId) => held.pending.has(turnId));
    const down = pending
      .filter(lower)
      .toSorted((left, right) => (desired?.get(right) ?? 0) - (desired?.get(left) ?? 0));
    held.order = [...pending.filter((turnId) => !lower(turnId)), ...down];
    return held.order;
  };

  const releaseSessions = () => {
    let total = 0;
    for (const held of heldSessions.values()) total += held.bytes;
    for (const [key, held] of heldSessions) {
      if (total <= INDEX_MEMORY_BUDGET_BYTES) return;
      if (
        queue.isLoading(key) ||
        queue.get(key)?.lane === "live" ||
        live.get(held.storeKey)?.has(held.sessionId) === true
      ) {
        continue;
      }
      heldSessions.delete(key);
      total -= held.bytes;
    }
  };

  /** Reads the thread's run and provider turn ordinals; native runs are told apart by their ids. */
  const loadOrdinals = Effect.fn("ClaudeSessionSync.loadOrdinals")(function* (
    target: ClaudeNativeRunTarget,
  ) {
    const runPrefix = claudeNativeRunIds(target.idScope, "").runId;
    const turnPrefix = claudeNativeRunIds(target.idScope, "").providerTurnId;
    const runs = yield* sql<{
      readonly id: string;
      readonly ordinal: number;
      readonly status: string;
    }>`
      SELECT run_id AS "id", ordinal, status FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId}
    `;
    const turns = yield* sql<{ readonly id: string; readonly ordinal: number }>`
      SELECT provider_turn_id AS "id", ordinal FROM orchestration_v2_projection_provider_turns
      WHERE provider_thread_id = ${target.providerThreadId}
    `;
    const state: OrdinalState = {
      stored: new Map(),
      taken: new Set(),
      desired: undefined,
      moved: new Set(),
    };
    for (const run of runs) {
      const turnId = run.id.startsWith(runPrefix) ? run.id.slice(runPrefix.length) : undefined;
      if (turnId === undefined || turnId === REMOVED_TURN_ID || run.status === "rolled_back") {
        state.taken.add(run.ordinal);
      } else {
        state.stored.set(turnId, run.ordinal);
      }
    }
    for (const turn of turns) if (!turn.id.startsWith(turnPrefix)) state.taken.add(turn.ordinal);
    return state;
  });

  /**
   * The ordinals the shown turns take now, worked out again only when the tracker or what is taken changed, with the turns whose stored ordinal must move. A shown turn is one not T3 Code's own; a stored run of a turn not shown keeps its value taken until it is rolled back.
   */
  const desiredOrdinals = (
    held: HeldSession,
    ordinals: OrdinalState,
    own: ReadonlySet<string>,
  ): ReadonlyMap<string, number> => {
    const { tracker } = held;
    const { index } = tracker;
    if (ordinals.desired?.version === index.version) return ordinals.desired.byTurn;
    const shown = tracker.turnIds().filter((turnId) => !own.has(turnId));
    const shownSet = new Set(shown);
    const taken = new Set(ordinals.taken);
    for (const [turnId, ordinal] of ordinals.stored) if (!shownSet.has(turnId)) taken.add(ordinal);
    const byTurn = claudeNativeOrdinals(
      shown.map((id) => {
        const entry = index.entryOf(id);
        return { id, startMs: entry === undefined ? Number.NaN : index.timestamp(entry) };
      }),
      taken,
    );
    ordinals.desired = { version: index.version, byTurn };
    ordinals.moved.clear();
    for (const [turnId, ordinal] of byTurn) {
      const stored = ordinals.stored.get(turnId);
      if (stored === undefined || stored === ordinal) continue;
      ordinals.moved.add(turnId);
      held.pending.add(turnId);
    }
    held.order = undefined;
    return byTurn;
  };

  const rollBack = Effect.fn("ClaudeSessionSync.rollBack")(function* (
    target: ClaudeNativeRunTarget,
    turnId: string,
    eventId: () => EventId,
  ) {
    const run = yield* projections.getRun(
      target.threadId,
      claudeNativeRunIds(target.idScope, turnId).runId,
    );
    if (run === undefined || run.status === "rolled_back") return;
    yield* eventSink.write({
      events: [
        {
          id: eventId(),
          type: "run.updated",
          threadId: target.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          occurredAt: run.completedAt ?? run.requestedAt,
          payload: { ...run, status: "rolled_back" },
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
    | { readonly _tag: "Changed" }
    | { readonly _tag: "Deferred" }
    | { readonly _tag: "Deleted" };

  /**
   * One bounded pass under the thread's lock: the session's turns still to write are read and written newest first until the read budget is spent, reading only the lines of a turn the cache does not hold. A turn that is gone, or turns out to be T3 Code's own, has its run rolled back.
   */
  const ingestOnce = Effect.fn("ClaudeSessionSync.ingestOnce")(function* (input: {
    readonly row: ClaudeSessionSyncState.ClaudeSessionSyncState;
    readonly target: ClaudeNativeRunTarget;
    readonly held: HeldSession;
    /** Notes to move into the hidden run with this pass's other removed items. */
    readonly hide: ReadonlyArray<TurnItemId>;
    readonly fallbackAt: DateTime.Utc;
  }) {
    const { row, target, held } = input;
    const { tracker } = held;
    const { index } = tracker;
    // Deletion can land between steps; nothing is written into a deleted thread.
    const thread = yield* projections.findThread(target.threadId);
    if (thread === null || thread.deletedAt !== null) {
      yield* markState(row, "deleted");
      yield* syncState.deleteTurnDigests({ threadId: target.threadId });
      return { _tag: "Deleted" } satisfies IngestStep;
    }
    const active = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
      LIMIT 1
    `;
    // T3 Code's live stream owns a turn it is running; its settling asks for a read again.
    if (active.length > 0) return { _tag: "Deferred" } satisfies IngestStep;

    if (held.thread?.threadId !== target.threadId) {
      held.thread = {
        threadId: target.threadId,
        digests: new Map(yield* syncState.turnDigests(target.threadId)),
        own: undefined,
        ordinals: undefined,
        reconciled: false,
      };
    }
    const state = held.thread;
    const { digests } = state;
    const ownTurnsNow = yield* Effect.cached(ownTurns(target.providerThreadId));
    if (state.own === undefined) {
      // Every turn is checked again, as on a first read or after a T3 Code run settled.
      const own = yield* ownTurnsNow;
      const next: OwnState = { turns: new Set(), unclaimed: new Map(own.promptTexts) };
      for (const turnId of tracker.turnIds()) {
        const turn = tracker.turn(turnId);
        if (turn === undefined) continue;
        if (
          isClaudeOwnTurn({ turn, index, own, skipCopied: target.skipCopied }) ||
          claimClaudeOwnTurnByText({
            turnId,
            index,
            unclaimed: next.unclaimed,
            written: digests.has(turnId),
          })
        ) {
          next.turns.add(turnId);
          if (digests.has(turnId)) held.removed.add(turnId);
        }
      }
      state.own = next;
    }
    const ownState = state.own;
    state.ordinals ??= yield* loadOrdinals(target);
    const ordinals = state.ordinals;
    desiredOrdinals(held, ordinals, ownState.turns);

    // Event ids only need to be unique; one random token per pass and a counter make them so.
    const readToken = yield* random.uuidV4();
    let nextEvent = 0;
    const eventId = () => EventId.make(`event:claude-sync:${readToken}:${nextEvent++}`);

    let firstRunOrdinal: number | undefined;
    let lastRunOrdinal: number | undefined;
    let lastActivityAt: DateTime.Utc | undefined;
    let bytes = 0;
    const gone: Array<OrchestrationV2TurnItem> = [];
    const takeGone = Effect.fn("ClaudeSessionSync.takeGone")(function* (itemIds: Iterable<string>) {
      for (const id of itemIds) {
        // A line still in the file belongs to another turn, whose write moves its items.
        const lineUuid = claudeNativeItemLineUuid(target.idScope, id);
        if (lineUuid !== undefined && index.entryOf(lineUuid) !== undefined) continue;
        const item = yield* projections.getTurnItem({
          threadId: target.threadId,
          itemId: TurnItemId.make(id),
        });
        if (item !== null) gone.push(item);
      }
    });

    const order = pendingInOrder(held, ordinals);
    // Newest first, each taken off the end once written or found to need nothing.
    for (let turnId = order.at(-1); turnId !== undefined; turnId = order.at(-1)) {
      if (!held.pending.has(turnId)) {
        order.pop();
        continue;
      }
      const turn = tracker.turn(turnId);
      if (turn === undefined) {
        held.pending.delete(turnId);
        order.pop();
        continue;
      }
      const written = digests.has(turnId);
      if (
        ownState.turns.has(turnId) ||
        isClaudeOwnTurn({
          turn,
          index,
          own: yield* ownTurnsNow,
          skipCopied: target.skipCopied,
        }) ||
        claimClaudeOwnTurnByText({ turnId, index, unclaimed: ownState.unclaimed, written })
      ) {
        ownState.turns.add(turnId);
        held.pending.delete(turnId);
        held.caches.delete(turnId);
        if (written) held.removed.add(turnId);
        // The turns after it may now take other ordinals.
        ordinals.desired = undefined;
        order.pop();
        continue;
      }
      const ordinal = desiredOrdinals(held, ordinals, ownState.turns).get(turnId);
      if (held.order !== order) break;
      if (ordinal === undefined) {
        held.pending.delete(turnId);
        order.pop();
        continue;
      }
      const moved = ordinals.moved.has(turnId);
      if (!moved && digests.get(turnId) === turn.digest) {
        held.pending.delete(turnId);
        order.pop();
        continue;
      }
      if (bytes >= READ_BUDGET_BYTES) break;
      const stored = yield* storedRunFor(target, turnId);
      const read = Effect.fn("ClaudeSessionSync.readTurn")(function* (
        cache: ClaudeNativeTurnCache,
      ) {
        return yield* readClaudeTranscriptTurn({
          filePath: held.filePath,
          index,
          idScope: target.idScope,
          turn,
          known: cache.known,
        }).pipe(
          withHost,
          Effect.asSome,
          Effect.catchTags({ ClaudeTranscriptChangedError: () => Effect.succeedNone }),
        );
      });
      // A moved run is written whole, so its items follow it into its new ordinal's range.
      let cache = moved ? undefined : held.caches.get(turnId);
      // Taken out until the writes land, so a write that fails or is interrupted leaves no lines marked held.
      held.caches.delete(turnId);
      const inMemory = cache !== undefined;
      // Without a cache in memory the run's stored line hashes say what need not be read again.
      let seeded = false;
      if (cache === undefined && !moved) {
        cache = newClaudeNativeTurnCache();
        if (stored !== undefined) {
          for (const [lineUuid, hash] of yield* syncState.lineHashes({
            threadId: target.threadId,
            turnId,
          })) {
            cache.known.set(lineUuid, hash);
          }
          seeded = cache.known.size > 0;
          cache.model = stored.model;
          // An open turn's time is its latest line's; lines held as hashes are not read to find it.
          cache.latest = stored.run.completedAt ?? undefined;
          cache.prompt = {
            text: "",
            createdBy: "system",
            originKind: stored.run.nativeOrigin?.turnOrigin,
          };
        }
      }
      cache ??= newClaudeNativeTurnCache();
      let content = yield* read(cache);
      // A result for a tool on a line held only as a hash finishes that tool, so its turn is read whole.
      if (
        seeded &&
        Option.isSome(content) &&
        claudeNativeResultsNeedWholeTurn(content.value, cache)
      ) {
        cache = newClaudeNativeTurnCache();
        seeded = false;
        content = yield* read(cache);
      }
      if (Option.isNone(content)) {
        // The next sync reads the file again from the top and finds every turn anew.
        index.reset();
        held.caches.clear();
        held.pending.clear();
        held.order = undefined;
        return { _tag: "Changed" } satisfies IngestStep;
      }
      const unreadable = content.value.lines.flatMap((line) =>
        line.items.flatMap((item) => (item._tag === "Unreadable" ? [item.offset] : [])),
      );
      if (unreadable.length > 0) {
        yield* Effect.logWarning("Skipped Claude transcript lines that could not be read", {
          sessionId: row.sessionId,
          offsets: unreadable,
        });
      }
      if (moved) {
        // Forgotten first, so a move a restart cuts short is read whole and written again.
        yield* syncState.deleteTurnDigests({ threadId: target.threadId, turnIds: [turnId] });
        digests.delete(turnId);
      }
      const plan = planClaudeNativeTurn({
        target,
        content: content.value,
        cache,
        ordinal,
        providerTurnOrdinal: ordinal,
        stored: stored !== undefined,
        storedItems: yield* storedItemsById(claudeNativeTurnItemIds(target, content.value)),
        eventId,
        modelSlug,
        fallbackAt: input.fallbackAt,
      });
      // A turn read again with nothing new, as after its digest was lost, is written only if its run differs.
      const unchangedRun =
        stored !== undefined &&
        !moved &&
        plan.events.every((event) => LIFECYCLE_EVENT_TYPES.has(event.type)) &&
        plan.events.every((event) =>
          event.type === "run.updated"
            ? event.payload.status === stored.run.status &&
              event.payload.ordinal === stored.run.ordinal &&
              DateTime.toEpochMillis(event.payload.completedAt ?? event.payload.requestedAt) ===
                DateTime.toEpochMillis(stored.run.completedAt ?? stored.run.requestedAt)
            : event.type === "provider-turn.updated"
              ? event.payload.model === stored.model &&
                (event.payload.nativeTurnRef?.nativeId ?? undefined) === stored.nativeTurnId
              : true,
        );
      if (!unchangedRun) yield* writeGroups([plan.events]);
      yield* takeGone(plan.leftItemIds);
      if (plan.leftLineUuids.length > 0) {
        yield* takeGone(yield* itemIdsOfLines(target, turnId, plan.leftLineUuids));
      }
      if (!inMemory && !seeded && stored !== undefined) {
        // A turn read whole for a run already stored: its run may hold items of lines since gone.
        const planned = new Set([
          claudeNativeRunIds(target.idScope, turnId).promptItemId,
          ...[...cache.itemIds.values()].flat(),
        ]);
        const runItems = yield* sql<{ readonly id: string }>`
          SELECT turn_item_id AS "id" FROM orchestration_v2_projection_turn_items
          WHERE run_id = ${claudeNativeRunIds(target.idScope, turnId).runId}
        `;
        yield* takeGone(runItems.flatMap(({ id }) => (planned.has(id) ? [] : [id])));
      }
      yield* syncState.setLineHashes({
        threadId: target.threadId,
        turnId,
        hashes: content.value.lines.map((line) => [line.lineUuid, line.hash] as const),
        removed: content.value.removedLineUuids,
      });
      // Recorded only once the run's events are written, so an interrupted write is written again.
      yield* syncState.setTurnDigest({
        threadId: target.threadId,
        turnId,
        digest: turn.digest,
      });
      digests.set(turnId, turn.digest);
      ordinals.stored.set(turnId, ordinal);
      ordinals.moved.delete(turnId);
      held.pending.delete(turnId);
      order.pop();
      if (turn.end === undefined) held.caches.set(turnId, cache);
      firstRunOrdinal = Math.min(firstRunOrdinal ?? ordinal, ordinal);
      lastRunOrdinal = Math.max(lastRunOrdinal ?? 0, ordinal);
      if (
        lastActivityAt === undefined ||
        DateTime.toEpochMillis(plan.lastActivityAt) > DateTime.toEpochMillis(lastActivityAt)
      ) {
        lastActivityAt = plan.lastActivityAt;
      }
      for (const line of content.value.lines) {
        const entry = index.entryOf(line.lineUuid);
        if (entry !== undefined) bytes += index.location(entry).length + 1;
      }
    }
    const atEnd = held.pending.size === 0;

    for (const itemId of input.hide) {
      const item = yield* projections.getTurnItem({ threadId: target.threadId, itemId });
      if (item !== null) gone.push(item);
    }
    if (gone.length > 0) {
      const removedRun = yield* storedRunFor(target, REMOVED_TURN_ID);
      // The hidden run takes the lowest value no run holds or is about to be written at, so the shown turns' ordinals stand.
      let free = 1;
      const used = new Set([
        ...ordinals.taken,
        ...ordinals.stored.values(),
        ...(ordinals.desired?.byTurn.values() ?? []),
      ]);
      while (used.has(free)) free += 1;
      const placed = removedRun ?? { ordinal: free, providerTurnOrdinal: free };
      if (removedRun === undefined) ordinals.taken.add(free);
      yield* writeGroups([
        planClaudeRemovedItems({
          target,
          items: gone,
          created: removedRun !== undefined,
          ...placed,
          at: thread.createdAt,
          eventId,
        }),
      ]);
    }
    if (atEnd && !state.reconciled) {
      for (const turnId of digests.keys()) if (!tracker.hasTurn(turnId)) held.removed.add(turnId);
      state.reconciled = true;
    }
    const stale = [...held.removed].filter(
      (turnId) => !tracker.hasTurn(turnId) || ownState.turns.has(turnId),
    );
    for (const turnId of stale) {
      yield* rollBack(target, turnId, eventId);
      // A rolled-back run keeps its ordinal, so no other run may take it.
      const ordinal = ordinals.stored.get(turnId);
      if (ordinal !== undefined) ordinals.taken.add(ordinal);
      ordinals.stored.delete(turnId);
      ordinals.desired = undefined;
    }
    held.removed.clear();
    if (stale.length > 0) {
      yield* syncState.deleteTurnDigests({ threadId: target.threadId, turnIds: stale });
      for (const turnId of stale) digests.delete(turnId);
    }
    const appliedTitle = yield* updateThreadAfterRead(
      target,
      tracker.facts(),
      { firstRunOrdinal, lastRunOrdinal, lastActivityAt },
      row.appliedTitle,
    );
    const updated: ClaudeSessionSyncState.ClaudeSessionSyncState = {
      ...row,
      appliedTitle,
      hydrationState: "hydrating",
      updatedAt: yield* DateTime.now,
    };
    if (updated.appliedTitle !== row.appliedTitle || row.hydrationState !== "hydrating") {
      yield* syncState.upsert(updated);
    }
    return { _tag: "Read", row: updated, atEnd } satisfies IngestStep;
  });

  /**
   * The note a thread a terminal is running shows while the free-disk floor holds its turns back. It is placed after the thread's latest run, where its newest turns would be, and dated when the pause began; the pass that follows again moves it into the hidden run.
   */
  const diskNotice = Effect.fn("ClaudeSessionSync.diskNotice")(function* (
    thread: OrchestrationV2AppThread,
    target: ClaudeNativeRunTarget,
    id: TurnItemId,
    minFreeDiskGiB: number,
  ) {
    const message = `Not following this Claude Code session: the disk holding T3 Code's data is below the ${minFreeDiskGiB} GB the Claude session sync keeps free.`;
    const existing = yield* projections.getTurnItem({ threadId: target.threadId, itemId: id });
    const hidden = claudeNativeRunIds(target.idScope, REMOVED_TURN_ID).runId;
    if (
      existing?.type === "system_notice" &&
      existing.runId !== hidden &&
      existing.message === message
    ) {
      return;
    }
    const [latest] = yield* sql<{ readonly runId: RunId; readonly rootNodeId: NodeId | null }>`
      SELECT run_id AS "runId", json_extract(payload_json, '$.rootNodeId') AS "rootNodeId"
      FROM orchestration_v2_projection_runs
      WHERE thread_id = ${target.threadId} AND status <> 'rolled_back'
        ${runOriginSql(sql, null, "any")}
      ORDER BY ordinal DESC LIMIT 1
    `;
    const at = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: yield* idAllocator.allocate.event({ threadId: target.threadId }),
          type: "turn-item.updated",
          threadId: target.threadId,
          ...(latest === undefined
            ? {}
            : {
                runId: latest.runId,
                ...(latest.rootNodeId === null ? {} : { nodeId: latest.rootNodeId }),
              }),
          occurredAt: at,
          payload: {
            id,
            threadId: target.threadId,
            runId: latest?.runId ?? null,
            nodeId: latest?.rootNodeId ?? null,
            providerThreadId: target.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "failed",
            title: message,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "system_notice",
            message,
            level: "warning",
          },
        },
      ],
    });
  });

  // Threads showing the free-disk note, so the step that goes on again hides it.
  const diskNoticeShown = new Set<ThreadId>();
  const diskNoticeChecked = new Set<ThreadId>();

  /** Brings an entry's title and update time up to its changed file; returns the title the sync applied. */
  const refreshEntry = Effect.fn("ClaudeSessionSync.refreshEntry")(function* (
    thread: OrchestrationV2AppThread,
    transcript: Transcript,
    appliedTitle: string | null,
  ) {
    const tail = yield* scanTail(transcript);
    const title = tail.customTitle ?? tail.aiTitle;
    // A title the user gave the thread in T3 Code is kept.
    const untouched = appliedTitle === null || thread.title === appliedTitle;
    const nextTitle = title !== undefined && untouched ? title : thread.title;
    const activity = DateTime.makeUnsafe(transcript.mtimeMs);
    const updatedAt =
      DateTime.toEpochMillis(activity) > DateTime.toEpochMillis(thread.updatedAt)
        ? activity
        : thread.updatedAt;
    if (nextTitle !== thread.title || updatedAt !== thread.updatedAt) {
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: thread.id }),
            type: "thread.metadata-updated",
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: updatedAt,
            payload: { ...thread, title: nextTitle, updatedAt },
          },
        ],
      });
    }
    return untouched && title !== undefined ? title : appliedTitle;
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
          threadId: null,
          providerThreadId: null,
          accountUuids: [],
          hydrationState: "pending",
          cwd: null,
          appliedTitle: null,
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
      let appliedTitle = base.appliedTitle;
      const isNewEntry = threadId === null;
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
        appliedTitle = created.title ?? appliedTitle;
      }
      const thread = yield* projections.findThread(threadId);
      if (thread === null || thread.deletedAt !== null) {
        yield* markState({ ...base, threadId }, "deleted");
        return "deleted" satisfies StepOutcome;
      }
      let linked: ClaudeSessionSyncState.ClaudeSessionSyncState = {
        ...base,
        threadId,
        providerThreadId,
        cwd,
        appliedTitle,
      };
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
        linked = { ...linked, hydrationState: "entry" };
      }
      // Old imports hold run-less history; migrating them is separate work, so they are left as they are. A delegated child's session is its task's, not one a person continues in a terminal, so it is not followed.
      if (
        thread.historyOrigin === "v1_import" ||
        isDelegatedChild(thread) ||
        providerThreadId === null
      ) {
        yield* syncState.upsert({ ...linked, ...caughtUp, hydrationState: "pending" });
        return "pending" satisfies StepOutcome;
      }
      yield* markFollowed(thread);
      if (input.mode === "entry") {
        // An entry whose file changed shows the session's latest title and activity.
        const changed =
          row !== undefined &&
          (row.fileSize !== transcript.size || row.fileMtimeMs !== transcript.mtimeMs);
        if (!isNewEntry && changed && linked.hydrationState === "entry" && isSyncThread(thread)) {
          linked = {
            ...linked,
            appliedTitle: yield* refreshEntry(thread, transcript, linked.appliedTitle),
          };
        }
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
      // A run in flight owns the thread's turns until it settles, which asks for a read again.
      const active = yield* sql<{ readonly found: number }>`
        SELECT 1 AS found FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
        LIMIT 1
      `;
      if (active.length > 0) {
        yield* syncState.upsert(linked);
        return "deferred" satisfies StepOutcome;
      }
      const diskNoticeId = TurnItemId.make(`x:${target.idScope}:disk`);
      // Checked before every step, so no read writes past the floor.
      const free = yield* capacity.freeDiskBytes;
      if (free !== undefined && free < options.minFreeDiskGiB * 1024 ** 3) {
        if (notice) {
          yield* threadNotice(thread, target, "history", {
            status: "failed",
            message: `History not loaded: the disk holding T3 Code's data is below the ${options.minFreeDiskGiB} GB the Claude session sync keeps free.`,
          });
        } else if (input.live) {
          // Only a session a terminal is running has turns the pause holds back.
          yield* diskNotice(thread, target, diskNoticeId, options.minFreeDiskGiB);
          diskNoticeShown.add(threadId);
        }
        yield* syncState.upsert(linked);
        return "paused" satisfies StepOutcome;
      }
      if (!diskNoticeChecked.has(threadId)) {
        // A note left by an earlier server is found once, so going on again hides it.
        diskNoticeChecked.add(threadId);
        const left = yield* projections.getTurnItem({ threadId, itemId: diskNoticeId });
        if (
          left !== null &&
          left.runId !== claudeNativeRunIds(target.idScope, REMOVED_TURN_ID).runId
        ) {
          diskNoticeShown.add(threadId);
        }
      }
      // Following goes on, so the note leaves the thread with the next pass that writes.
      const hide = diskNoticeShown.has(threadId) ? [diskNoticeId] : [];
      if (linked.hydrationState !== "hydrating" && linked.hydrationState !== "full") {
        if (notice) {
          yield* threadNotice(thread, target, "history", {
            status: "running",
            message: "Loading this session's history from Claude Code.",
          });
        }
        // Recorded before anything is written, so a load stopped inside its first step resumes.
        linked = { ...linked, hydrationState: "hydrating" };
        yield* syncState.upsert(linked);
      }
      // The file is read into its tracker outside the thread's lock, which only writes wait on.
      const held = holdSession(store.key, transcript);
      yield* syncHeld(held);
      const read = yield* threadCommands.withLock(
        threadId,
        ingestOnce({
          row: linked,
          target,
          held,
          hide,
          fallbackAt: DateTime.makeUnsafe(transcript.mtimeMs),
        }),
      );
      // Forgotten only once a pass has written the hiding; a failed or interrupted one never gets here.
      if (read._tag === "Read" && hide.length > 0) diskNoticeShown.delete(threadId);
      if (read._tag === "Deleted") return "deleted" satisfies StepOutcome;
      if (read._tag === "Changed") return "more" satisfies StepOutcome;
      if (read._tag === "Deferred") {
        yield* syncState.upsert(linked);
        return "deferred" satisfies StepOutcome;
      }
      if (!read.atEnd) return "more" satisfies StepOutcome;
      yield* syncState.upsert({ ...read.row, ...caughtUp, hydrationState: "full" });
      if (notice) {
        yield* threadNotice(thread, target, "history", {
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

  // A session is asked for again only when its file's size or mtime changed, or a T3 Code run on its thread settled; see `ClaudeSyncQueue` for the order steps run in.
  const requestKey = (storeKey: string, sessionId: string) => `${storeKey}\0${sessionId}`;
  const queue = new ClaudeSyncQueue<HydrationRequest>(LOADS_AT_ONCE, LIVE_STEPS_PER_OPEN);
  const wake = yield* Queue.unbounded<void>();
  // The size and mtime each session's file had at its last step that left nothing to read.
  const seen = new Map<string, string>();
  // Sessions paused below the free-disk floor; the sweep asks for them again.
  const paused = new Map<string, HydrationRequest>();
  const signature = (transcript: Pick<Transcript, "size" | "mtimeMs">) =>
    `${transcript.size}:${transcript.mtimeMs}`;

  const request = Effect.fn("ClaudeSessionSync.request")(function* (next: HydrationRequest) {
    const key = requestKey(next.store.key, next.sessionId);
    const known = queue.get(key);
    if (!queue.add(key, { ...next, filePath: next.filePath ?? known?.filePath })) return;
    yield* Queue.offer(wake, undefined);
  });

  /** Runs one step of one request, and queues it again when it has more. */
  const runRequest = Effect.fn("ClaudeSessionSync.runRequest")(function* (next: HydrationRequest) {
    const key = requestKey(next.store.key, next.sessionId);
    // An interrupted step, as at a settings change, gives its turn back and is asked for again.
    const outcome = yield* stepRequest(next).pipe(
      Effect.onInterrupt(() => Effect.sync(() => queue.interrupted(key, next))),
    );
    if (outcome !== "more") queue.finish(key);
    if (outcome === "deleted") heldSessions.delete(key);
    releaseSessions();
  });

  const stepRequest = Effect.fn("ClaudeSessionSync.stepRequest")(function* (
    next: HydrationRequest,
  ) {
    const { settings, stores } = yield* currentState;
    if (!settings.claudeSessionSync.enabled) return undefined;
    const store = stores.find((candidate) => candidate.key === next.store.key);
    if (store === undefined) return undefined;
    const key = requestKey(store.key, next.sessionId);
    const row = yield* syncState
      .get({ storeKey: store.key, sessionId: next.sessionId })
      .pipe(Effect.mapError(fail("read a session", next.sessionId)));
    const filePath = next.filePath ?? row?.filePath;
    if (filePath === undefined) return undefined;
    const transcript = yield* statTranscript(next.sessionId, filePath);
    if (transcript === undefined) {
      if (row !== undefined) {
        yield* markState(row, "failed").pipe(
          Effect.mapError(fail("mark a session", next.sessionId)),
        );
      }
      return undefined;
    }
    yield* capacity.subscribersReady;
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
    } else {
      // A paused session is asked for again by the sweep, not by every poll that sees it unchanged.
      if (outcome === "paused") paused.set(key, { ...next, filePath: transcript.filePath });
      seen.set(key, signature(transcript));
    }
    return outcome;
  });

  // Called only once the host was found idle, so the fill never holds the worker.
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

  // Set when the last drain stopped with only the fill left and the host busy.
  let fillHeldForHost = false;

  const drain: ClaudeSessionSync["Service"]["drain"] = Effect.gen(function* () {
    const failures: Array<ClaudeSessionSyncError> = [];
    for (;;) {
      // Host load is checked, never waited on, so live and opened requests are never held behind it.
      let next = queue.take(false);
      if (next === undefined) {
        const fillOn =
          queue.hasFill ||
          (yield* settingsService.getSettings.pipe(
            Effect.map((settings) => settings.claudeSessionSync.backgroundFill),
            // Settings that cannot be read leave the fill to the next drain.
            Effect.orElseSucceed(() => false),
          ));
        fillHeldForHost = fillOn && !(yield* capacity.hostIdle);
        if (!fillOn || fillHeldForHost) return failures;
        next = queue.take(true);
      }
      if (next === undefined) {
        if (yield* fillNext().pipe(Effect.orElseSucceed(() => false))) continue;
        return failures;
      }
      yield* runRequest(next).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not hydrate a Claude session", { error }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                queue.finish(requestKey(next.store.key, next.sessionId));
                failures.push(error);
              }),
            ),
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
  // Each store's registry listing at the last poll.
  const registryListings = new Map<string, string>();
  // Live sessions with no transcript yet: the poll to look again at, and the wait before the one after.
  const missingTranscripts = new Map<string, { readonly next: number; readonly wait: number }>();

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
      // Entries are cheap and bounded, so they never wait on host load; only the fill does.
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
        (outcome === "follow" || outcome === "entry") && isLive
          ? "live"
          : outcome === "follow"
            ? "open"
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
      yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "open" });
    }
  });

  const sweep: ClaudeSessionSync["Service"]["sweep"] = Effect.fn("ClaudeSessionSync.sweep")(
    function* (options) {
      const { settings, stores } = yield* currentState;
      const failures: Array<ClaudeSessionSyncError> = [];
      if (!settings.claudeSessionSync.enabled) return failures;
      if (options?.full === true) {
        yield* markFollowedThreads(stores).pipe(Effect.mapError(fail("mark followed threads")));
      }
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
    const poll = polls++;
    for (const store of stores) {
      // A changed listing is read at once, so a terminal that resumes a session is followed from its next poll.
      const listing = (yield* fileSystem
        .readDirectory(store.sessionsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .toSorted()
        .join("\n");
      const listingChanged = registryListings.get(store.key) !== listing;
      registryListings.set(store.key, listing);
      // Every few polls it is read regardless, as a crashed process leaves its entry behind.
      if (listingChanged || poll % REGISTRY_EVERY === 0) {
        const before = liveIn(store);
        const now = yield* liveSessions.read(store.sessionsDir);
        live.set(store.key, now);
        for (const sessionId of now) {
          // A session registered before its transcript is written is looked for until it is, less often the longer it is missing.
          const key = requestKey(store.key, sessionId);
          if (knownPaths.has(key)) continue;
          const miss = missingTranscripts.get(key) ?? { next: poll, wait: 1 };
          if (poll < miss.next) continue;
          const found = yield* findTranscript(store, sessionId);
          if (found === undefined) {
            const wait = Math.min(miss.wait * 2, MISSING_TRANSCRIPT_MAX_POLLS);
            missingTranscripts.set(key, { next: poll + wait, wait });
            continue;
          }
          missingTranscripts.delete(key);
          knownPaths.set(key, found.filePath);
        }
        // A session whose process ended may have written its last lines since the previous poll.
        for (const sessionId of before) {
          if (now.has(sessionId)) continue;
          const filePath = knownPaths.get(requestKey(store.key, sessionId));
          if (filePath !== undefined) yield* requestIfChanged(store, sessionId, filePath, "live");
        }
      }
      for (const sessionId of liveIn(store)) {
        const filePath = knownPaths.get(requestKey(store.key, sessionId));
        if (filePath !== undefined) yield* requestIfChanged(store, sessionId, filePath, "live");
      }
    }
  }).pipe(Effect.withSpan("ClaudeSessionSync.pollLive"));

  /** Asks for a read when the file's size or mtime differs from the last step that read it all. */
  const requestIfChanged = Effect.fn("ClaudeSessionSync.requestIfChanged")(function* (
    store: SyncStore,
    sessionId: string,
    filePath: string,
    lane: Lane,
    readTo?: Pick<Transcript, "size" | "mtimeMs">,
  ) {
    const key = requestKey(store.key, sessionId);
    const transcript = yield* statTranscript(sessionId, filePath);
    if (transcript === undefined) return;
    const last = seen.get(key) ?? (readTo === undefined ? undefined : signature(readTo));
    if (last === signature(transcript)) return;
    yield* request({ store, sessionId, filePath, lane });
  });

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
    const store = stores.find((candidate) => candidate.key === row.storeKey);
    if (store === undefined) return;
    const key = requestKey(store.key, row.sessionId);
    knownPaths.set(key, row.filePath);
    const lane: Lane = liveIn(store).has(row.sessionId) ? "live" : "open";
    if (forget) {
      seen.delete(key);
      // A settled T3 Code run can change which turns are its own and which ordinals are taken.
      const held = heldSessions.get(key);
      if (held?.thread !== undefined) {
        held.thread.own = undefined;
        // Its run took an ordinal and maybe a provider turn the native runs must pass over.
        held.thread.ordinals = undefined;
      }
    } else if (row.hydrationState === "full") {
      // A loaded session is read again only when its file grew, as when a terminal continued it.
      return yield* requestIfChanged(store, row.sessionId, row.filePath, lane, {
        size: row.fileSize,
        mtimeMs: row.fileMtimeMs,
      });
    }
    yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane });
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
      appliedTitle: null,
      fileSize: transcript.size,
      fileMtimeMs: transcript.mtimeMs,
      updatedAt: yield* DateTime.now,
    });
    yield* request({ store, sessionId: row.sessionId, filePath: row.filePath, lane: "open" });
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
      // An instance this registered for a home no longer listed goes, so removing a home undoes adding it.
      const listed = new Set(
        settings.claudeSessionSync.additionalHomes.map((extra) =>
          additionalHomeInstanceId(path.resolve(expandHomePath(extra, homeDirectory))),
        ),
      );
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        const config = decodeClaudeSettings(instance.config ?? {});
        if (
          instance.driver !== CLAUDE_PROVIDER ||
          Option.isNone(config) ||
          listed.has(ProviderInstanceId.make(instanceId)) ||
          additionalHomeInstanceId(
            path.resolve(expandHomePath(config.value.homePath, homeDirectory)),
          ) !== instanceId
        ) {
          continue;
        }
        yield* settingsService
          .updateProviderInstance({
            operation: "remove",
            instanceId: ProviderInstanceId.make(instanceId),
          })
          .pipe(Effect.mapError(fail("remove the instance of a Claude home no longer listed")));
        wrote = true;
      }
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
      // Fill work held back by a busy host is looked at again later; any request wakes it sooner.
      yield* fillHeldForHost
        ? Queue.take(wake).pipe(
            Effect.timeoutOrElse({ duration: FILL_BACKOFF, orElse: () => Effect.void }),
          )
        : Queue.take(wake);
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
