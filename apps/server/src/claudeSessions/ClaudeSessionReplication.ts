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
  ClaudeSessionReplicationError,
  type EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  repositoryGroupingKeyOf,
  ThreadId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
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
import { copyClaudeSessionFiles, planClaudeReplica } from "./ClaudeReplicaTransfer.ts";
import {
  claudeProjectSlug,
  claudeReplicaFitsReserve,
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
/** The most sessions one listing returns to a client; a query narrows it further. */
const CLAUDE_REMOTE_SESSION_LIST_LIMIT = 200;

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
  readonly pinned: number;
}

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
    /** Sessions this environment owns, newest first; `query` matches title or folder. */
    readonly listOwned: (input: {
      readonly limit?: number;
      readonly query?: string;
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
  const passLock = yield* Semaphore.make(1);
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

  const ownedRows = (filter: { readonly sessionId?: string; readonly query?: string }) =>
    sql<OwnedSession>`
    SELECT
      s.session_id AS "sessionId",
      s.thread_id AS "threadId",
      t.title AS title,
      s.cwd AS cwd,
      s.file_path AS "filePath",
      s.file_size AS "fileSize",
      s.file_mtime_ms AS "fileMtimeMs",
      CASE WHEN json_extract(t.payload_json, '$.pinnedAt') IS NOT NULL
        OR p.pinned_at IS NOT NULL THEN 1 ELSE 0 END AS pinned
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
          : sql`AND (t.title LIKE ${`%${filter.query}%`} OR s.cwd LIKE ${`%${filter.query}%`})`
      }
    ORDER BY s.file_mtime_ms DESC
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
  )(function* ({ limit, query }) {
    const rows = yield* ownedRows(query === undefined || query === "" ? {} : { query });
    const seen = new Set<string>();
    const sessions: Array<ClaudeRemoteSession> = [];
    for (const row of rows) {
      // A session in two stores is the one changed last, as the sync shows it.
      if (seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      sessions.push({
        sessionId: row.sessionId,
        threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
        title: row.title,
        cwd: row.cwd,
        updatedAt: DateTime.makeUnsafe(row.fileMtimeMs),
        pinned: row.pinned === 1,
        transcriptBytes: row.fileSize,
      });
      if (limit !== undefined && sessions.length >= limit) break;
    }
    return { sessions };
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

  const claim: ClaudeSessionReplication["Service"]["claim"] = Effect.fn(
    "ClaudeSessionReplication.claim",
  )(function* (input) {
    const located = yield* locate(input.sessionId);
    const keep = (message: string) =>
      new ClaudeSessionReplicationError({ reason: "refused", message });
    const link = yield* links
      .get(input.claimantEnvironmentId)
      .pipe(Effect.mapError(storage("Could not read this environment's links.")));
    // Without a link back the owner could never read the lines appended at the claimant.
    if (Option.isNone(link)) {
      return yield* keep(
        "The owner has no link back to the environment asking for this session, so it kept it. Link them both ways.",
      );
    }
    const live = yield* liveSessions.read(path.join(located.layout.home, "sessions"));
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

  /** Where replicas go: the default Claude instance's home, with its `projects/` created. */
  const targetLayout = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(storage("Could not read settings.")),
    );
    const instance = settings.providerInstances[ProviderInstanceId.make(CLAUDE_PROVIDER)];
    const decoded = decodeClaudeSettings(instance?.config ?? {});
    if (Option.isNone(decoded)) {
      return yield* new ClaudeSessionReplicationError({
        reason: "storage",
        message: "The Claude settings here could not be read, so no copy has a home to go to.",
      });
    }
    const instanceEnvironment = yield* mergeProviderInstanceEnvironment(
      instance?.environment,
      hostEnvironment,
    );
    const home = yield* resolveClaudeHomePath(decoded.value, instanceEnvironment).pipe(withHost);
    const projects = path.join(home, "projects");
    yield* fileSystem
      .makeDirectory(projects, { recursive: true })
      .pipe(Effect.mapError(storage(`Could not create ${projects}.`)));
    const projectsDir = yield* fileSystem
      .realPath(projects)
      .pipe(Effect.mapError(storage(`Could not read ${projects}.`)));
    return { projectsDir, home: path.dirname(projectsDir) } satisfies ClaudeSessionLayout;
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
  const replicateOne = Effect.fn("ClaudeSessionReplication.replicateOne")(function* (input: {
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
    const row = yield* replicas
      .get(sessionId)
      .pipe(Effect.mapError(storage("Could not read this environment's replicas.")));
    // A copy stays where it is; only a new one is placed by the rules below.
    const layout = row === undefined ? yield* targetLayout : layoutOf(row.transcriptPath);
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
    const remote = yield* peers.manifest({
      environmentId: ownerEnvironmentId,
      sessionId,
      ...(localSize === undefined ? {} : { prefixBytes: localSize }),
    });
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
    const live = yield* liveSessions.read(path.join(layout.home, "sessions"));
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
    const now = yield* DateTime.now;
    const record = (forked: ReadonlyArray<string>) =>
      replicas
        .upsert({
          sessionId,
          ownerEnvironmentId,
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
      yield* peers.claim({
        environmentId: ownerEnvironmentId,
        claim: {
          sessionId,
          claimantEnvironmentId: yield* environment.getEnvironmentId,
          size: row.syncedBytes,
          sha256: row.syncedSha256,
        },
      });
      yield* replicas
        .remove(sessionId)
        .pipe(Effect.mapError(storage("Could not record that this environment owns the session.")));
      return "claimed";
    }
    const seed = plan.kind === "fast-forward" ? plan.seedBytes : 0;
    let needed = remote.transcript.size - seed;
    for (const file of remote.sidecars) {
      const here = claudeSessionFileAbsolutePath(path, layout, retarget(file.path));
      const size = yield* fileSystem.stat(here).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => -1),
      );
      if (size !== file.size) needed += file.size;
    }
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
      // The owner keeps the id; lines appended only here become their own session through the SDK's
      // fork, before the owner's copy replaces this one. No line is merged by hand.
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
      // Recorded before the copy, so a copy cut short is retried by replacing, never forked again.
      if (row !== undefined && local !== undefined) {
        yield* replicas
          .upsert({ ...row, forkedSessionIds: forked, keptSha256: local.sha256 })
          .pipe(Effect.mapError(storage("Could not record the fork.")));
      }
    }
    yield* copyClaudeSessionFiles({
      source: {
        readChunk: (chunk) =>
          peers.readChunk({ environmentId: ownerEnvironmentId, sessionId, ...chunk }),
      },
      layout,
      sessionId,
      transcript: { file: remote.transcript, target: transcriptTarget },
      sidecars: remote.sidecars.map((file) => ({ file, target: retarget(file.path) })),
      seedTranscriptBytes: seed,
    }).pipe(withHost);
    yield* record(forked);
    return "copied";
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
    for (const link of linked) {
      if (link.access !== "full-access" || link.status === "expired") continue;
      const listed = yield* Effect.result(peers.list(link.environmentId));
      if (listed._tag === "Failure") {
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
    return {
      ...pass,
      replicas: rows.map(({ syncedSha256: _hash, keptSha256: _kept, ...replica }) => replica),
    } satisfies ClaudeReplicationReport;
  });

  const replicateNow = passLock.withPermits(1)(runPass).pipe(Effect.andThen(report));

  /** The send gate's claimer: brings the copy up to date, then asks its owner for it. */
  const claimForSend: ClaudeReplicaClaimer = Effect.fn("ClaudeSessionReplication.claimForSend")(
    function* (input: Parameters<ClaudeReplicaClaimer>[0]) {
      const { ownerEnvironmentId } = input;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(storage("Could not read settings.")),
      );
      const outcome = yield* replicateOne({
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
      if (row === undefined) return undefined;
      yield* peers.claim({
        environmentId: ownerEnvironmentId,
        claim: {
          sessionId: input.sessionId,
          claimantEnvironmentId: yield* environment.getEnvironmentId,
          size: row.syncedBytes,
          sha256: row.syncedSha256,
        },
      });
      yield* replicas
        .remove(input.sessionId)
        .pipe(Effect.mapError(storage("Could not record that this environment owns the session.")));
      return undefined;
    },
    (effect, input) =>
      effect.pipe(
        passLock.withPermits(1),
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
    peers.list(environmentId).pipe(
      Effect.map(({ sessions }) => ({
        sessions: sessions
          .filter(
            (session) =>
              query === undefined ||
              query === "" ||
              (session.title ?? "").toLowerCase().includes(query.toLowerCase()) ||
              (session.cwd ?? "").toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, CLAUDE_REMOTE_SESSION_LIST_LIMIT),
      })),
    );

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
    listRemote,
    replicateNow,
    report,
    start,
  });
});

export const layer = Layer.effect(ClaudeSessionReplication, make);
