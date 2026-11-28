// @effect-diagnostics nodeBuiltinImport:off - node:fs reports the free space a replica must leave.
import * as NodeFSP from "node:fs/promises";

import {
  CLAUDE_SESSION_FILE_CHUNK_BYTES,
  ClaudeSettings,
  type ClaudeRemoteSession,
  type ClaudeRemoteSessionList,
  type ClaudeReplicationReport,
  type ClaudeReplicationSkip,
  type ClaudeReplicationSource,
  type ClaudeSessionClaimInput,
  type ClaudeSessionManifest,
  type ClaudeSessionReplicationRules,
  CLAUDE_REMOTE_SESSION_PAGE_LIMIT,
  ClaudeSessionReplicationError,
  type EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PeerClaudeSessions from "../peer/PeerClaudeSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ClaudeSessionReplicas from "../persistence/ClaudeSessionReplicas.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { ClaudeLiveSessions } from "./ClaudeLiveSessions.ts";
import { CLAUDE_SYNC_RECORDING_LAG_MS } from "./ClaudeSessionSync.ts";
import { copyClaudeSessionFiles, planClaudeReplica } from "./ClaudeReplicaTransfer.ts";
import {
  claudeProjectSlug,
  claudeReplicaBytesNeeded,
  claudeReplicaFitsReserve,
  likeContaining,
  resolveServedClaudeSessionFile,
  claudeSessionFileAbsolutePath,
  type ClaudeSessionLayout,
  isClaudeSessionId,
  listClaudeSessionFiles,
  sha256OfFile,
} from "./ClaudeSessionFiles.ts";
import {
  type ClaudeReplicaClaimer,
  ClaudeSessionOwnershipGate,
} from "./ClaudeSessionOwnershipGate.ts";

/** How often every linked environment's sessions are checked against the rules. */
const PASS_INTERVAL = "5 minutes";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A pass asks each owner only for what changed since its last listing, reaching back over the
 * owner's recording lag plus a minute for clocks, and lists everything every `FULL_LIST_EVERY`
 * passes since a pin may not change what a session's change time reads.
 */
const LIST_OVERLAP_MS = CLAUDE_SYNC_RECORDING_LAG_MS + 60_000;
const FULL_LIST_EVERY = 12;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** A session this environment owns, as its sync recorded it. */
interface OwnedSession {
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly filePath: string;
  readonly fileSize: number;
  readonly fileMtimeMs: number;
  readonly changeMs: number;
  readonly pinned: number;
}

/** Where a listing page starts: just after this change time and session id. */
interface ListCursor {
  readonly changeMs: number;
  readonly sessionId: string;
}

const encodeCursor = (cursor: ListCursor) => `${cursor.changeMs}:${cursor.sessionId}`;

/** A cursor `listOwned` wrote, or undefined for anything else. */
export const decodeListCursor = (text: string): ListCursor | undefined => {
  const match = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(text);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { changeMs: Number(match[1]), sessionId: match[2] };
};

/** A session's files as served: its layout and its transcript's path. */
interface LocatedSession {
  readonly layout: ClaudeSessionLayout;
  readonly transcriptPath: string;
  readonly cwd: string | null;
}

/** Bytes a file request returns, with the file's size when read. */
export interface ClaudeSessionChunk {
  readonly bytes: Uint8Array;
  readonly fileSize: number;
}

export class ClaudeSessionReplication extends Context.Service<
  ClaudeSessionReplication,
  {
    /**
     * One page of the sessions this environment owns, most recently changed first: `query`
     * matches title or folder, `changedSinceMs` keeps those changed since, `cursor` continues.
     */
    readonly listOwned: (input: {
      readonly limit?: number;
      readonly query?: string;
      readonly changedSinceMs?: number;
      readonly cursor?: string;
    }) => Effect.Effect<ClaudeRemoteSessionList, ClaudeSessionReplicationError>;
    /** Every file of an owned session; with `prefixBytes`, the transcript's prefix hash too. */
    readonly manifest: (input: {
      readonly sessionId: string;
      readonly prefixBytes?: number;
    }) => Effect.Effect<ClaudeSessionManifest, ClaudeSessionReplicationError>;
    /** Up to `CLAUDE_SESSION_FILE_CHUNK_BYTES` of one file of an owned session. */
    readonly readFile: (input: {
      readonly sessionId: string;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    }) => Effect.Effect<ClaudeSessionChunk, ClaudeSessionReplicationError>;
    /**
     * Hands an owned session to a linked environment whose copy holds this one's transcript
     * exactly, plus any lines appended there. Refused while a `claude` here holds it or once this
     * copy has moved on; accepted, this copy becomes a replica of the claimant's.
     */
    readonly claim: (
      input: ClaudeSessionClaimInput,
    ) => Effect.Effect<void, ClaudeSessionReplicationError>;
    /** Whether this environment sent the claim an owner asks about: its session and nonce. */
    readonly confirmClaim: (input: {
      readonly sessionId: string;
      readonly nonce: string;
    }) => Effect.Effect<boolean>;
    /** A linked environment's own sessions, for a client to list and open there. */
    readonly listRemote: (input: {
      readonly environmentId: EnvironmentId;
      readonly query?: string;
    }) => Effect.Effect<ClaudeRemoteSessionList, ClaudeSessionReplicationError>;
    /** Runs one pass over every full-access link now, then reports it. */
    readonly replicateNow: Effect.Effect<ClaudeReplicationReport, ClaudeSessionReplicationError>;
    readonly report: Effect.Effect<ClaudeReplicationReport, ClaudeSessionReplicationError>;
    /** Installs the send gate's claimer and runs a pass every `PASS_INTERVAL`. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/claudeSessions/ClaudeSessionReplication") {}

const storage = (message: string) => (cause: unknown) =>
  new ClaudeSessionReplicationError({ reason: "storage", message, cause });

const notFound = (sessionId: string) =>
  new ClaudeSessionReplicationError({
    reason: "not_found",
    message: `Session ${sessionId} is not one this environment owns.`,
  });

/** Whether any enabled rule asks for a session a linked environment lists. */
export const claudeReplicationRuleMatches = (
  rules: ClaudeSessionReplicationRules,
  session: Pick<ClaudeRemoteSession, "pinned" | "updatedAt">,
  nowMs: number,
) =>
  rules.everything ||
  (rules.pinned && session.pinned) ||
  (rules.activeWithinDays > 0 &&
    nowMs - DateTime.toEpochMillis(session.updatedAt) <= rules.activeWithinDays * DAY_MS);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerClaudeSessions.PeerClaudeSessions;
  const replicas = yield* ClaudeSessionReplicas.ClaudeSessionReplicaRepository;
  const gate = yield* ClaudeSessionOwnershipGate;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const queryRunner = yield* ClaudeAgentSdkQueryRunner;
  const liveSessions = yield* ClaudeLiveSessions;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const hostEnvironment = yield* HostProcess.Environment;
  const random = yield* SecureRandom.SecureRandom;
  const passLock = yield* Semaphore.make(1);
  // One step at a time per session: a send's claim waits only for that session, never a pass.
  const sessionLocks = yield* KeyedLock.make<string>();
  const pendingClaims = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const listStates = yield* Ref.make<
    ReadonlyMap<string, { readonly sinceMs: number; readonly rulesKey: string }>
  >(new Map());
  const passCount = yield* Ref.make(0);
  const lastPass = yield* Ref.make<{
    readonly lastRunAt: DateTime.Utc | null;
    readonly sources: ReadonlyArray<ClaudeReplicationSource>;
    readonly skipped: ReadonlyArray<ClaudeReplicationSkip>;
  }>({ lastRunAt: null, sources: [], skipped: [] });

  const withHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  // A store's home is the directory its real `projects/` sits in, so its `file-history/` and
  // `tasks/` are the ones beside the transcripts, whichever configured home links to them.
  const layoutOf = (transcriptPath: string): ClaudeSessionLayout => {
    const projectsDir = path.dirname(path.dirname(transcriptPath));
    return { projectsDir, home: path.dirname(projectsDir) };
  };

  const msOf = (column: string) =>
    sql.literal(`COALESCE(CAST((julianday(${column}) - 2440587.5) * 86400000 AS INTEGER), 0)`);

  const ownedRows = (filter: {
    readonly sessionId?: string;
    readonly query?: string;
    readonly changedSinceMs?: number;
    readonly cursor?: ListCursor;
    readonly limit?: number;
  }) =>
    sql<OwnedSession>`
    WITH owned AS (
      SELECT
        s.session_id,
        s.thread_id,
        t.title,
        s.cwd,
        s.file_path,
        s.file_size,
        s.file_mtime_ms,
        MAX(s.file_mtime_ms, ${msOf("t.updated_at")}, ${msOf("p.updated_at")}) AS change_ms,
        CASE WHEN json_extract(t.payload_json, '$.pinnedAt') IS NOT NULL
          OR p.pinned_at IS NOT NULL THEN 1 ELSE 0 END AS pinned,
        -- A session in two stores is the one changed last, as the sync shows it.
        ROW_NUMBER() OVER (PARTITION BY s.session_id ORDER BY s.file_mtime_ms DESC) AS rank
      FROM fork_claude_session_sync_state s
      LEFT JOIN orchestration_v2_projection_threads t
        ON t.thread_id = s.thread_id AND t.deleted_at IS NULL
      LEFT JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      WHERE s.hydration_state NOT IN ('pending', 'deleted', 'excluded') AND s.file_path <> ''
        AND s.session_id NOT IN (SELECT session_id FROM fork_claude_session_replicas)
        ${filter.sessionId === undefined ? sql`` : sql`AND s.session_id = ${filter.sessionId}`}
        ${
          filter.query === undefined
            ? sql``
            : sql`AND (t.title LIKE ${likeContaining(filter.query)} ESCAPE '!'
                OR s.cwd LIKE ${likeContaining(filter.query)} ESCAPE '!')`
        }
    )
    SELECT
      session_id AS "sessionId",
      thread_id AS "threadId",
      title,
      cwd,
      file_path AS "filePath",
      file_size AS "fileSize",
      file_mtime_ms AS "fileMtimeMs",
      change_ms AS "changeMs",
      pinned
    FROM owned
    WHERE rank = 1
      ${filter.changedSinceMs === undefined ? sql`` : sql`AND change_ms >= ${filter.changedSinceMs}`}
      ${
        filter.cursor === undefined
          ? sql``
          : sql`AND (change_ms < ${filter.cursor.changeMs}
              OR (change_ms = ${filter.cursor.changeMs} AND session_id < ${filter.cursor.sessionId}))`
      }
    ORDER BY change_ms DESC, session_id DESC
    ${filter.limit === undefined ? sql`` : sql`LIMIT ${filter.limit}`}
  `.pipe(Effect.mapError(storage("Could not read this environment's Claude sessions.")));

  const locate = Effect.fn("ClaudeSessionReplication.locate")(function* (sessionId: string) {
    if (!isClaudeSessionId(sessionId)) return yield* notFound(sessionId);
    const held = yield* replicas
      .get(sessionId)
      .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
    if (held !== undefined) return yield* notFound(sessionId);
    // A session taken in or claimed here is served from where it was placed, which the sync may
    // not have found yet; its lines still name the directory it ran in elsewhere.
    const placed = yield* replicas
      .placed(sessionId)
      .pipe(Effect.mapError(storage("Could not read where the session was placed here.")));
    if (
      placed !== undefined &&
      (yield* fileSystem.exists(placed.transcriptPath).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return {
        layout: layoutOf(placed.transcriptPath),
        transcriptPath: placed.transcriptPath,
        cwd: placed.cwd,
      } satisfies LocatedSession;
    }
    const row = (yield* ownedRows({ sessionId }))[0];
    if (row === undefined) return yield* notFound(sessionId);
    return {
      layout: layoutOf(row.filePath),
      transcriptPath: row.filePath,
      cwd: row.cwd,
    } satisfies LocatedSession;
  });

  const listOwned: ClaudeSessionReplication["Service"]["listOwned"] = Effect.fn(
    "ClaudeSessionReplication.listOwned",
  )(function* (input) {
    const listedAt = yield* DateTime.now;
    const limit = Math.min(
      Math.max(input.limit ?? CLAUDE_REMOTE_SESSION_PAGE_LIMIT, 1),
      CLAUDE_REMOTE_SESSION_PAGE_LIMIT,
    );
    const cursor = input.cursor === undefined ? undefined : decodeListCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      return yield* new ClaudeSessionReplicationError({
        reason: "refused",
        message: "That listing cursor is not one this environment wrote.",
      });
    }
    const rows = yield* ownedRows({
      ...(input.query === undefined || input.query === "" ? {} : { query: input.query }),
      ...(input.changedSinceMs === undefined ? {} : { changedSinceMs: input.changedSinceMs }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      sessions: page.map((row) => ({
        sessionId: row.sessionId,
        threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
        title: row.title,
        cwd: row.cwd,
        updatedAt: DateTime.makeUnsafe(row.changeMs),
        pinned: row.pinned === 1,
        transcriptBytes: row.fileSize,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ changeMs: last.changeMs, sessionId: last.sessionId })
          : null,
      listedAt,
    };
  });

  const repositoryPlace = Effect.fn("ClaudeSessionReplication.repositoryPlace")(function* (
    cwd: string | null,
  ) {
    if (cwd === null) return null;
    const identity = yield* identities.resolve(cwd);
    if (identity === null || identity.rootPath === undefined) return null;
    const relative = path.relative(identity.rootPath, cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return {
      canonicalKey: repositoryGroupingKeyOf(identity),
      relativeCwd: relative.split(path.sep).join("/"),
    };
  });

  const manifest: ClaudeSessionReplication["Service"]["manifest"] = Effect.fn(
    "ClaudeSessionReplication.manifest",
  )(function* ({ sessionId, prefixBytes }) {
    const located = yield* locate(sessionId);
    const files = yield* listClaudeSessionFiles({
      layout: located.layout,
      sessionId,
      transcriptPath: located.transcriptPath,
    }).pipe(withHost, Effect.mapError(storage(`Could not read session ${sessionId}'s files.`)));
    const transcriptPrefix =
      prefixBytes === undefined || prefixBytes > files.transcript.size
        ? null
        : {
            size: prefixBytes,
            sha256: yield* sha256OfFile(located.transcriptPath, prefixBytes).pipe(
              withHost,
              Effect.mapError(storage(`Could not read session ${sessionId}'s transcript.`)),
            ),
          };
    return {
      sessionId,
      cwd: located.cwd,
      repository: yield* repositoryPlace(located.cwd),
      transcript: files.transcript,
      transcriptPrefix,
      sidecars: files.sidecars,
    };
  });

  const readFile: ClaudeSessionReplication["Service"]["readFile"] = Effect.fn(
    "ClaudeSessionReplication.readFile",
  )(function* (input) {
    const located = yield* locate(input.sessionId);
    const refused = new ClaudeSessionReplicationError({
      reason: "refused",
      message: "That path is not one of the session's files.",
    });
    if (input.offset < 0 || input.length < 0 || input.length > CLAUDE_SESSION_FILE_CHUNK_BYTES) {
      return yield* refused;
    }
    // A sidecar that is a symlink out of the session's directories is never served.
    const realFile = yield* resolveServedClaudeSessionFile({
      layout: located.layout,
      sessionId: input.sessionId,
      transcriptPath: located.transcriptPath,
      relativePath: input.path,
    }).pipe(withHost);
    if (realFile === undefined) return yield* refused;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(realFile, { flag: "r" });
        const fileSize = Number((yield* handle.stat).size);
        yield* handle.seek(BigInt(input.offset), "start");
        const read = input.length === 0 ? Option.none() : yield* handle.readAlloc(input.length);
        return {
          bytes: Option.getOrElse(read, () => new Uint8Array()),
          fileSize,
        } satisfies ClaudeSessionChunk;
      }),
    ).pipe(Effect.mapError(storage(`Could not read ${input.path}.`)));
  });

  /** Every enabled Claude instance and its home, the default instance first. */
  const claudeInstances = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(storage("Could not read settings.")),
    );
    const defaultId = ProviderInstanceId.make(CLAUDE_PROVIDER);
    const configured = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === CLAUDE_PROVIDER)
      .map(([id, instance]) => ({ id: ProviderInstanceId.make(id), instance }));
    const ordered = [
      ...(Object.hasOwn(settings.providerInstances, defaultId)
        ? []
        : [{ id: defaultId, instance: undefined }]),
      ...configured.toSorted((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0)),
    ];
    const homes: Array<{ readonly instanceId: ProviderInstanceId; readonly home: string }> = [];
    for (const { id, instance } of ordered) {
      const decoded = decodeClaudeSettings(instance?.config ?? {});
      if (Option.isNone(decoded)) continue;
      const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
        instance?.environment,
        hostEnvironment,
      );
      homes.push({
        instanceId: id,
        home: yield* resolveClaudeHomePath(decoded.value, instanceEnvironment).pipe(withHost),
      });
    }
    return homes;
  });

  /** The instance whose home's `projects/` is this layout's, so a send there finds the session. */
  const instanceFor = Effect.fn("ClaudeSessionReplication.instanceFor")(function* (
    layout: ClaudeSessionLayout,
  ) {
    for (const { instanceId, home } of yield* claudeInstances) {
      const projects = yield* fileSystem
        .realPath(path.join(home, "projects"))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (projects === layout.projectsDir) return instanceId;
    }
    return yield* new ClaudeSessionReplicationError({
      reason: "storage",
      message: `No Claude instance here uses ${layout.projectsDir}, so the session has no home to run in.`,
    });
  });

  /**
   * The sessions a claude holds in `home`. An unreadable process table refuses, since a holder
   * it hides would keep writing a file this environment is about to replace or hand over.
   */
  const liveOrRefuse = (home: string, outcome: string) =>
    liveSessions.readOrFail(path.join(home, "sessions")).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeSessionReplicationError({
            reason: "refused",
            message: `This machine could not read which claude processes are running, so ${outcome}.`,
            cause,
          }),
      ),
    );

  const claim: ClaudeSessionReplication["Service"]["claim"] = Effect.fn(
    "ClaudeSessionReplication.claim",
  )(function* (input) {
    if (!isClaudeSessionId(input.sessionId)) return yield* notFound(input.sessionId);
    const keep = (message: string) =>
      new ClaudeSessionReplicationError({ reason: "refused", message });
    const held = yield* replicas
      .get(input.sessionId)
      .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
    // A claim accepted before is accepted again, so a claimant that lost the answer recovers.
    if (
      held !== undefined &&
      held.ownerEnvironmentId === input.claimantEnvironmentId &&
      held.syncedBytes === input.size &&
      held.syncedSha256 === input.sha256
    ) {
      return;
    }
    const located = yield* locate(input.sessionId);
    const link = yield* links
      .get(input.claimantEnvironmentId)
      .pipe(Effect.mapError(storage("Could not read this environment's links.")));
    // Without a link back the owner could never read the lines appended at the claimant.
    if (Option.isNone(link)) {
      return yield* keep(
        "The owner has no link back to the environment asking for this session, so it kept it. Link them both ways.",
      );
    }
    // The body names the claimant, so the claimant itself is asked over the owner's own link.
    const confirmed = yield* peers
      .confirmClaim({
        environmentId: input.claimantEnvironmentId,
        sessionId: input.sessionId,
        nonce: input.nonce,
      })
      .pipe(Effect.orElseSucceed(() => false));
    if (!confirmed) {
      return yield* keep(
        "The environment named in the claim did not confirm asking for this session, so the owner kept it.",
      );
    }
    const live = yield* liveOrRefuse(located.layout.home, "the owner kept the session");
    if (live.has(input.sessionId)) {
      return yield* keep(
        "A claude on the owner has this session open, so it kept the session. Close it there and try again.",
      );
    }
    const info = yield* fileSystem
      .stat(located.transcriptPath)
      .pipe(Effect.mapError(storage("Could not read the session's transcript.")));
    const size = Number(info.size);
    const sha256 =
      size === input.size
        ? yield* sha256OfFile(located.transcriptPath).pipe(
            withHost,
            Effect.mapError(storage("Could not read the session's transcript.")),
          )
        : undefined;
    if (sha256 !== input.sha256) {
      return yield* keep(
        "The owner has lines the copy asking for it lacks, so it kept the session. Sync again first.",
      );
    }
    yield* replicas
      .upsert({
        sessionId: input.sessionId,
        ownerEnvironmentId: input.claimantEnvironmentId,
        providerInstanceId: yield* instanceFor(located.layout),
        transcriptPath: located.transcriptPath,
        cwd: located.cwd,
        syncedBytes: size,
        syncedSha256: input.sha256,
        syncedAt: yield* DateTime.now,
        status: "current",
        forkedSessionIds: [],
        lastError: null,
        keptSha256: null,
      })
      .pipe(Effect.mapError(storage("Could not record the session's new owner.")));
  });

  const confirmClaim: ClaudeSessionReplication["Service"]["confirmClaim"] = Effect.fn(
    "ClaudeSessionReplication.confirmClaim",
  )(function* (input) {
    return (yield* Ref.get(pendingClaims)).get(input.sessionId) === input.nonce;
  });

  /**
   * Asks a replica's owner to hand the session over, then forgets the replica. The nonce is held
   * only while the claim is in flight, so an owner asking later is told no.
   */
  const claimFrom = Effect.fn("ClaudeSessionReplication.claimFrom")(function* (
    row: ClaudeSessionReplicas.ClaudeSessionReplicaRow,
  ) {
    const nonce = Buffer.from(yield* random.randomBytes(16)).toString("hex");
    yield* Ref.update(pendingClaims, (current) => new Map(current).set(row.sessionId, nonce));
    yield* peers
      .claim({
        environmentId: row.ownerEnvironmentId,
        claim: {
          sessionId: row.sessionId,
          claimantEnvironmentId: yield* environment.getEnvironmentId,
          size: row.syncedBytes,
          sha256: row.syncedSha256,
          nonce,
        },
      })
      .pipe(
        Effect.ensuring(
          Ref.update(pendingClaims, (current) => {
            const next = new Map(current);
            next.delete(row.sessionId);
            return next;
          }),
        ),
      );
    yield* replicas
      .remove(row.sessionId)
      .pipe(Effect.mapError(storage("Could not record that this environment owns the session.")));
  });

  /** Where new replicas go: the default Claude instance's home, with its `projects/` created. */
  const targetLayout = Effect.gen(function* () {
    const target = (yield* claudeInstances)[0];
    if (target === undefined) {
      return yield* new ClaudeSessionReplicationError({
        reason: "storage",
        message: "The Claude settings here could not be read, so no copy has a home to go to.",
      });
    }
    const projects = path.join(target.home, "projects");
    yield* fileSystem
      .makeDirectory(projects, { recursive: true })
      .pipe(Effect.mapError(storage(`Could not create ${projects}.`)));
    const projectsDir = yield* fileSystem
      .realPath(projects)
      .pipe(Effect.mapError(storage(`Could not read ${projects}.`)));
    return {
      layout: { projectsDir, home: path.dirname(projectsDir) } satisfies ClaudeSessionLayout,
      instanceId: target.instanceId,
    };
  });

  /** A checkout here of the repository a session ran in, found by its remote. */
  const localCheckoutOf = Effect.fn("ClaudeSessionReplication.localCheckoutOf")(function* (
    canonicalKey: string,
  ) {
    const roots = yield* sql<{ readonly root: string }>`
      SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL
    `.pipe(Effect.mapError(storage("Could not read this environment's projects.")));
    for (const { root } of roots) {
      const identity = yield* identities.resolve(root);
      if (identity !== null && repositoryGroupingKeyOf(identity) === canonicalKey) {
        return identity.rootPath ?? root;
      }
    }
    return undefined;
  });

  /**
   * Where a session's copy goes below this home: under the slug of the directory it maps to, so
   * `claude --resume` run there finds it. A repository is matched by remote; otherwise the owner's
   * own directory and slug are kept.
   */
  const placement = Effect.fn("ClaudeSessionReplication.placement")(function* (
    remote: ClaudeSessionManifest,
  ) {
    const ownerSlug = remote.transcript.path.split("/")[1] ?? "";
    const checkout =
      remote.repository === null
        ? undefined
        : yield* localCheckoutOf(remote.repository.canonicalKey);
    const cwd =
      checkout === undefined || remote.repository === null
        ? remote.cwd
        : remote.repository.relativeCwd === ""
          ? checkout
          : path.join(checkout, ...remote.repository.relativeCwd.split("/"));
    return { cwd, slug: cwd === null ? ownerSlug : claudeProjectSlug(cwd) };
  });

  const freeBytes = (directory: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.statfs(directory),
      catch: storage(`Could not read the free space at ${directory}.`),
    }).pipe(Effect.map((stats) => Number(stats.bavail) * Number(stats.bsize)));

  /** Brings one session's copy up to date with its owner, or reports why it did not. */
  const replicateOneUnlocked = Effect.fn("ClaudeSessionReplication.replicateOne")(
    function* (input: {
      readonly ownerEnvironmentId: EnvironmentId;
      readonly sessionId: string;
      readonly title: string | null;
      readonly rules: ClaudeSessionReplicationRules;
    }): Effect.fn.Return<
      "current" | "copied" | "claimed" | ClaudeReplicationSkip,
      ClaudeSessionReplicationError
    > {
      const { ownerEnvironmentId, sessionId } = input;
      const skip = (
        reason: ClaudeReplicationSkip["reason"],
        message: string,
        bytes = 0,
      ): ClaudeReplicationSkip => ({
        ownerEnvironmentId,
        sessionId,
        title: input.title,
        bytes,
        reason,
        message,
      });
      // The owner names the id; nothing here builds a path from one that is not a session's.
      if (!isClaudeSessionId(sessionId)) {
        return skip(
          "failed",
          "The owner listed a session id that is not one, so it was not copied.",
        );
      }
      const row = yield* replicas
        .get(sessionId)
        .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
      // A copy stays where it is; only a new one is placed by the rules below.
      const target =
        row === undefined
          ? yield* targetLayout
          : { layout: layoutOf(row.transcriptPath), instanceId: row.providerInstanceId };
      const { layout } = target;
      if (row !== undefined && row.ownerEnvironmentId !== ownerEnvironmentId) {
        return skip(
          "owned_here",
          "This environment holds a copy of that session from another owner.",
        );
      }
      const localPath = row?.transcriptPath;
      const localSize =
        localPath === undefined
          ? undefined
          : yield* fileSystem.stat(localPath).pipe(
              Effect.map((info) => Number(info.size)),
              Effect.option,
              Effect.map(Option.getOrUndefined),
            );
      const asked = yield* Effect.result(
        peers.manifest({
          environmentId: ownerEnvironmentId,
          sessionId,
          ...(localSize === undefined ? {} : { prefixBytes: localSize }),
        }),
      );
      if (asked._tag === "Failure") {
        // An owner that accepted this copy's claim no longer serves it; claiming again finishes it.
        if (row !== undefined && asked.failure.reason === "not_found") {
          const recovered = yield* Effect.result(claimFrom(row));
          if (recovered._tag === "Success") return "claimed";
        }
        return yield* asked.failure;
      }
      const remote = asked.success;
      const placed =
        row === undefined
          ? yield* placement(remote)
          : { cwd: row.cwd, slug: path.basename(path.dirname(row.transcriptPath)) };
      const transcriptTarget = `projects/${placed.slug}/${sessionId}.jsonl`;
      const transcriptPath =
        localPath ?? claudeSessionFileAbsolutePath(path, layout, transcriptTarget);
      if (row === undefined) {
        const ownHere = yield* sql<{ readonly found: number }>`
        SELECT 1 AS found FROM fork_claude_session_sync_state WHERE session_id = ${sessionId}
        LIMIT 1
      `.pipe(Effect.mapError(storage("Could not read this environment's Claude sessions.")));
        const exists = yield* fileSystem
          .exists(transcriptPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (ownHere.length > 0 && !exists) {
          return skip("owned_here", "This environment has its own session with that id.");
        }
      }
      const live = yield* liveOrRefuse(layout.home, "the copy was left as it is");
      if (live.has(sessionId)) {
        return skip("held", "A claude here has this copy open; it is copied again once that ends.");
      }
      const localExists = yield* fileSystem
        .exists(transcriptPath)
        .pipe(Effect.orElseSucceed(() => false));
      const local = localExists
        ? yield* Effect.gen(function* () {
            const sha256 = yield* sha256OfFile(transcriptPath);
            const size = Number((yield* fileSystem.stat(transcriptPath)).size);
            return {
              size,
              sha256,
              prefixOfOwner:
                remote.transcriptPrefix?.size === size && remote.transcriptPrefix.sha256 === sha256,
              alreadyKept: row?.keptSha256 === sha256,
              keepsSyncedPrefix:
                row !== undefined &&
                size >= row.syncedBytes &&
                (yield* sha256OfFile(transcriptPath, row.syncedBytes)) === row.syncedSha256,
            };
          }).pipe(withHost, Effect.mapError(storage(`Could not read ${transcriptPath}.`)))
        : undefined;
      const plan = planClaudeReplica({
        local,
        synced: row === undefined ? undefined : { size: row.syncedBytes, sha256: row.syncedSha256 },
        owner: remote.transcript,
      });
      if (
        row === undefined &&
        local !== undefined &&
        plan.kind !== "fast-forward" &&
        plan.kind !== "current"
      ) {
        return skip("owned_here", "This environment has its own session with that id.");
      }
      const ownerSlugDir = remote.transcript.path.split("/").slice(0, 2).join("/");
      const retarget = (owned: string) =>
        owned.startsWith(`${ownerSlugDir}/`)
          ? `projects/${placed.slug}/${owned.slice(ownerSlugDir.length + 1)}`
          : owned;
      const files = {
        layout,
        sessionId,
        transcript: { file: remote.transcript, target: transcriptTarget },
        sidecars: remote.sidecars.map((file) => ({ file, target: retarget(file.path) })),
      };
      const now = yield* DateTime.now;
      const record = (forked: ReadonlyArray<string>) =>
        replicas
          .upsert({
            sessionId,
            ownerEnvironmentId,
            providerInstanceId: target.instanceId,
            transcriptPath,
            cwd: placed.cwd,
            syncedBytes: remote.transcript.size,
            syncedSha256: remote.transcript.sha256,
            syncedAt: now,
            status: "current",
            forkedSessionIds: forked,
            lastError: null,
            keptSha256: null,
          })
          .pipe(Effect.mapError(storage("Could not record the copy.")));
      if (plan.kind === "current") {
        yield* record(row?.forkedSessionIds ?? []);
        return "current";
      }
      if (plan.kind === "local-ahead" && row !== undefined) {
        yield* claimFrom(row);
        return "claimed";
      }
      const seed = plan.kind === "fast-forward" ? plan.seedBytes : 0;
      const sidecars: Array<{ readonly size: number; readonly presentSize: number | undefined }> =
        [];
      for (const { file, target: sidecarTarget } of files.sidecars) {
        const here = claudeSessionFileAbsolutePath(path, layout, sidecarTarget);
        sidecars.push({
          size: file.size,
          presentSize: yield* fileSystem.stat(here).pipe(
            Effect.map((info) => Number(info.size)),
            Effect.orElseSucceed(() => undefined),
          ),
        });
      }
      const needed = claudeReplicaBytesNeeded({
        transcriptBytes: remote.transcript.size,
        sidecars,
      });
      const free = yield* freeBytes(layout.home);
      if (
        !claudeReplicaFitsReserve({
          freeBytes: free,
          neededBytes: needed,
          reserveGiB: input.rules.reserveGiB,
        })
      ) {
        return skip(
          "disk_reserve",
          `Copying it would leave less than ${input.rules.reserveGiB} GB free here.`,
          needed,
        );
      }
      let forked = row?.forkedSessionIds ?? [];
      if (plan.kind === "diverged") {
        // The owner keeps the id; lines appended only here become their own session through the
        // SDK's fork, before the owner's copy replaces this one. No line is merged by hand.
        const fork = yield* queryRunner
          .forkSession({
            sessionId,
            options: placed.cwd === null ? {} : { dir: placed.cwd },
            environment: { ...hostEnvironment, CLAUDE_CONFIG_DIR: layout.home },
            threadId: ThreadId.make(`claude:${sessionId}`),
            providerSessionId: ProviderSessionId.make(`claude-replica:${sessionId}`),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ClaudeSessionReplicationError({
                  reason: "storage",
                  message:
                    "This copy and its owner both moved on, and the lines added here could not be kept as a session of their own, so the copy was left as it is.",
                  cause,
                }),
            ),
          );
        forked = [...forked, fork.sessionId];
        // Recorded before the copy, so a copy cut short is retried by replacing, never forked
        // again.
        if (row !== undefined && local !== undefined) {
          yield* replicas
            .upsert({ ...row, forkedSessionIds: forked, keptSha256: local.sha256 })
            .pipe(Effect.mapError(storage("Could not record the fork.")));
        }
      }
      yield* copyClaudeSessionFiles({
        ...files,
        source: {
          readChunk: (chunk) =>
            peers.readChunk({ environmentId: ownerEnvironmentId, sessionId, ...chunk }),
        },
        seedTranscriptBytes: seed,
        localTranscript:
          local === undefined ? undefined : { size: local.size, sha256: local.sha256 },
        // A claude that opened the copy since the plan would write lines the rename would drop.
        beforeReplace: liveOrRefuse(layout.home, "the copy was left as it is").pipe(
          Effect.flatMap((open) =>
            open.has(sessionId)
              ? Effect.fail(
                  new ClaudeSessionReplicationError({
                    reason: "refused",
                    message:
                      "A claude here opened this copy while it was being updated, so it was left as it is.",
                  }),
                )
              : Effect.void,
          ),
        ),
      }).pipe(withHost);
      yield* record(forked);
      return "copied";
    },
  );

  const replicateOne = (input: Parameters<typeof replicateOneUnlocked>[0]) =>
    sessionLocks.withLock(input.sessionId, replicateOneUnlocked(input));

  /** Every page of an owner's sessions, or only those changed since `sinceMs`. */
  const listAll = Effect.fn("ClaudeSessionReplication.listAll")(function* (
    environmentId: EnvironmentId,
    sinceMs: number | undefined,
  ) {
    const sessions: Array<ClaudeRemoteSession> = [];
    let cursor: string | null = null;
    let listedAt: DateTime.Utc | undefined;
    do {
      const page: ClaudeRemoteSessionList = yield* peers.list(environmentId, {
        ...(sinceMs === undefined ? {} : { changedSinceMs: sinceMs }),
        ...(cursor === null ? {} : { cursor }),
      });
      listedAt ??= page.listedAt;
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { sessions, listedAt };
  });

  const runPass = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(storage("Could not read settings.")),
    );
    const rules = settings.claudeSessionSync.replication;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const sources: Array<ClaudeReplicationSource> = [];
    const skipped: Array<ClaudeReplicationSkip> = [];
    const enabled = settings.claudeSessionSync.enabled && (yield* links.enabled);
    const linked = enabled
      ? yield* links.list.pipe(Effect.mapError(storage("Could not read this environment's links.")))
      : [];
    const held = yield* replicas.list.pipe(Effect.mapError(storage("Could not read replicas.")));
    const rulesKey = `${rules.pinned}:${rules.activeWithinDays}:${rules.everything}`;
    const fullPass =
      (yield* Ref.getAndUpdate(passCount, (count) => count + 1)) % FULL_LIST_EVERY === 0;
    const forgetListing = (environmentId: EnvironmentId) =>
      Ref.update(listStates, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      });
    for (const link of linked) {
      if (link.access !== "full-access" || link.status === "expired") continue;
      const state = (yield* Ref.get(listStates)).get(link.environmentId);
      const sinceMs = fullPass || state?.rulesKey !== rulesKey ? undefined : state.sinceMs;
      const listed = yield* Effect.result(listAll(link.environmentId, sinceMs));
      if (listed._tag === "Failure") {
        yield* forgetListing(link.environmentId);
        const error = listed.failure;
        yield* replicas
          .markOwnerStale({ ownerEnvironmentId: link.environmentId, error: error.message })
          .pipe(Effect.mapError(storage("Could not record stale replicas.")));
        sources.push({
          environmentId: link.environmentId,
          label: link.label,
          outcome:
            error.reason === "unsupported"
              ? "unsupported"
              : error.reason === "refused"
                ? "refused"
                : "unreachable",
          message: error.message,
        });
        continue;
      }
      const ours = new Set(
        held
          .filter((row) => row.ownerEnvironmentId === link.environmentId)
          .map((row) => row.sessionId),
      );
      const skippedBefore = skipped.length;
      // A full listing that leaves out a copy held here means the owner gave it up: it accepted
      // this copy's claim, which finishes it, or it is gone there, which the report shows.
      const listedIds = new Set(listed.success.sessions.map((session) => session.sessionId));
      const unlisted =
        sinceMs === undefined
          ? held.filter(
              (row) =>
                row.ownerEnvironmentId === link.environmentId && !listedIds.has(row.sessionId),
            )
          : [];
      for (const row of unlisted) {
        const outcome = yield* Effect.result(
          replicateOne({
            ownerEnvironmentId: link.environmentId,
            sessionId: row.sessionId,
            title: null,
            rules,
          }),
        );
        if (outcome._tag === "Failure") {
          skipped.push({
            ownerEnvironmentId: link.environmentId,
            sessionId: row.sessionId,
            title: null,
            bytes: row.syncedBytes,
            reason: "failed",
            message: outcome.failure.message,
          });
        }
      }
      for (const session of listed.success.sessions) {
        if (!ours.has(session.sessionId) && !claudeReplicationRuleMatches(rules, session, nowMs)) {
          continue;
        }
        const outcome = yield* Effect.result(
          replicateOne({
            ownerEnvironmentId: link.environmentId,
            sessionId: session.sessionId,
            title: session.title,
            rules,
          }),
        );
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning("A Claude session could not be copied", {
            ownerEnvironmentId: link.environmentId,
            sessionId: session.sessionId,
            error: outcome.failure,
          });
          skipped.push({
            ownerEnvironmentId: link.environmentId,
            sessionId: session.sessionId,
            title: session.title,
            bytes: session.transcriptBytes,
            reason: "failed",
            message: outcome.failure.message,
          });
        } else if (typeof outcome.success !== "string") {
          skipped.push(outcome.success);
        }
      }
      // A session skipped now is listed again in full next pass, changed or not.
      const { listedAt } = listed.success;
      if (skipped.length > skippedBefore || listedAt === undefined) {
        yield* forgetListing(link.environmentId);
      } else {
        yield* Ref.update(listStates, (current) =>
          new Map(current).set(link.environmentId, {
            sinceMs: DateTime.toEpochMillis(listedAt) - LIST_OVERLAP_MS,
            rulesKey,
          }),
        );
      }
      sources.push({
        environmentId: link.environmentId,
        label: link.label,
        outcome: "synced",
        message: null,
      });
    }
    yield* Ref.set(lastPass, { lastRunAt: yield* DateTime.now, sources, skipped });
  });

  const report = Effect.gen(function* () {
    const pass = yield* Ref.get(lastPass);
    const rows = yield* replicas.list.pipe(Effect.mapError(storage("Could not read replicas.")));
    const titled = yield* sql<{ readonly sessionId: string; readonly title: string }>`
      SELECT r.session_id AS "sessionId", t.title AS title
      FROM fork_claude_session_replicas r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = 'claude:' || r.session_id
    `.pipe(Effect.mapError(storage("Could not read the copies' threads.")));
    const titles = new Map(titled.map((row) => [row.sessionId, row.title]));
    return {
      ...pass,
      replicas: rows.map(({ syncedSha256: _hash, keptSha256: _kept, ...replica }) => ({
        ...replica,
        title: titles.get(replica.sessionId) ?? null,
      })),
    } satisfies ClaudeReplicationReport;
  });

  const replicateNow = passLock.withPermits(1)(runPass).pipe(Effect.andThen(report));

  /** The send gate's claimer: brings the copy up to date, then asks its owner for it. */
  const claimForSend: ClaudeReplicaClaimer = Effect.fn("ClaudeSessionReplication.claimForSend")(
    function* (input: Parameters<ClaudeReplicaClaimer>[0]) {
      const { ownerEnvironmentId } = input;
      // A pass may have claimed it while this send waited for the session's lock.
      const before = yield* replicas
        .get(input.sessionId)
        .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
      if (before === undefined) return undefined;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(storage("Could not read settings.")),
      );
      const outcome = yield* replicateOneUnlocked({
        ownerEnvironmentId,
        sessionId: input.sessionId,
        title: null,
        rules: settings.claudeSessionSync.replication,
      });
      if (outcome === "claimed") return undefined;
      if (typeof outcome !== "string") {
        return yield* new ClaudeSessionReplicationError({
          reason: "refused",
          message: outcome.message,
        });
      }
      const row = yield* replicas
        .get(input.sessionId)
        .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
      if (row !== undefined) yield* claimFrom(row);
      return undefined;
    },
    (effect, input) =>
      sessionLocks.withLock(input.sessionId, effect).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            _tag: "replica" as const,
            ownerEnvironmentId: input.ownerEnvironmentId,
            message: `This session is a copy of one another environment owns, and it could not be moved here, so T3 Code sent nothing: ${error.message} Fork it to continue here from this copy.`,
          }),
        ),
      ),
  );

  const listRemote: ClaudeSessionReplication["Service"]["listRemote"] = ({
    environmentId,
    query,
  }) =>
    peers.list(environmentId, {
      limit: CLAUDE_REMOTE_SESSION_PAGE_LIMIT,
      ...(query === undefined || query === "" ? {} : { query }),
    });

  const start = Effect.fn("ClaudeSessionReplication.start")(function* () {
    yield* gate.install(claimForSend);
    yield* replicateNow.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Claude session replication pass failed", cause),
      ),
      Effect.repeat(Schedule.spaced(PASS_INTERVAL)),
      Effect.forkScoped,
    );
  });

  return ClaudeSessionReplication.of({
    listOwned,
    manifest,
    readFile,
    claim,
    confirmClaim,
    listRemote,
    replicateNow,
    report,
    start,
  });
});

export const layer = Layer.effect(ClaudeSessionReplication, make);
