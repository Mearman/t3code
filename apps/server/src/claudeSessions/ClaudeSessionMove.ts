import {
  type ClaudeSessionCodePackage,
  ClaudeSessionMoveError,
  type ClaudeSessionMoveInput,
  type ClaudeSessionMoveOffer,
  type ClaudeSessionMoveResult,
  type ClaudeSessionReplicationError,
  type EnvironmentId,
  repositoryGroupingKeyOf,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerClaudeSessions from "../peer/PeerClaudeSessions.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { ClaudeLiveSessions } from "./ClaudeLiveSessions.ts";
import { downloadVerifiedFile } from "./ClaudeReplicaTransfer.ts";
import {
  captureClaudeSessionCode,
  claudeSessionCodeFiles,
  git,
  restoreClaudeSessionCode,
} from "./ClaudeSessionCode.ts";
import { readClaudeSessionRegistry } from "./ClaudeSessionRegistry.ts";
import { ClaudeSessionReplication } from "./ClaudeSessionReplication.ts";

/** How often a session's holder is looked for again after SIGTERM, and how many times. */
const RELEASE_CHECK = "250 millis";
const RELEASE_CHECKS = 60;

/**
 * Runs before a session leaves. The accounts work exports and provides it to compact a session
 * under its old account when the target resumes it as another; by default nothing runs.
 */
const ClaudeMoveCompaction = Context.Reference<
  (input: {
    readonly sessionId: string;
    readonly targetEnvironmentId: EnvironmentId;
  }) => Effect.Effect<void, ClaudeSessionMoveError>
>("t3/claudeSessions/ClaudeMoveCompaction", { defaultValue: () => () => Effect.void });

/** A package the source keeps until its target has taken it. */
interface PendingMove {
  readonly sessionId: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly packageDir: string;
  readonly code: ClaudeSessionCodePackage;
}

export class ClaudeSessionMove extends Context.Service<
  ClaudeSessionMove,
  {
    /**
     * Moves a session this environment owns, with its code, to a linked environment, which then
     * owns it; this one keeps a replica. A held session is refused unless `takeOver` ends its idle
     * holder. Nothing moves when any step fails.
     */
    readonly move: (
      input: ClaudeSessionMoveInput,
    ) => Effect.Effect<ClaudeSessionMoveResult, ClaudeSessionMoveError>;
    /**
     * Takes in a session a linked environment offers: its code in a new worktree, then the session.
     */
    readonly accept: (
      offer: ClaudeSessionMoveOffer,
    ) => Effect.Effect<ClaudeSessionMoveResult, ClaudeSessionMoveError>;
    /** The code a pending move carries, for its target. */
    readonly packageOf: (
      moveId: string,
    ) => Effect.Effect<
      { readonly code: ClaudeSessionCodePackage; readonly packageDir: string } | undefined
    >;
  }
>()("t3/claudeSessions/ClaudeSessionMove") {}

const fromReplication = (error: ClaudeSessionReplicationError) =>
  new ClaudeSessionMoveError({
    reason:
      error.reason === "unreachable" ||
      error.reason === "unknown_link" ||
      error.reason === "disabled"
        ? "unreachable"
        : error.reason === "unsupported"
          ? "unsupported"
          : error.reason === "refused" || error.reason === "not_found"
            ? "refused"
            : "storage",
    message: error.message,
    cause: error,
  });

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** A command that resumes the session with plain `claude` where it now is. */
export const claudeResumeCommand = (input: {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly home: string;
  readonly defaultHome: string;
}) =>
  [
    ...(input.cwd === null ? [] : [`cd ${shellQuote(input.cwd)} &&`]),
    ...(input.home === input.defaultHome ? [] : [`CLAUDE_CONFIG_DIR=${shellQuote(input.home)}`]),
    `claude --resume ${input.sessionId}`,
  ].join(" ");

/**
 * Ends every idle `claude` that has the session open when `takeOver` asks it to, and refuses
 * otherwise. A holder is one `live` confirms by pid and start time; one working is never ended.
 */
export const releaseClaudeSession = Effect.fn("releaseClaudeSession")(function* (input: {
  readonly sessionsDir: string;
  readonly sessionId: string;
  readonly takeOver: boolean;
  readonly live: (sessionsDir: string) => Effect.Effect<ReadonlySet<string>>;
  readonly signal: (pid: number) => Effect.Effect<void, ClaudeSessionMoveError>;
  /** Waits between checks that the holder has gone. */
  readonly pause: Effect.Effect<void>;
}) {
  if (!(yield* input.live(input.sessionsDir)).has(input.sessionId)) return;
  const registry = yield* readClaudeSessionRegistry(input.sessionsDir).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSessionMoveError({
          reason: "storage",
          message: "Claude Code's session registry could not be read.",
          cause,
        }),
    ),
  );
  const holders = registry.entries.filter((entry) => entry.sessionId === input.sessionId);
  if (!input.takeOver) {
    return yield* new ClaudeSessionMoveError({
      reason: "held",
      message: `A claude (pid ${holders.map((entry) => entry.pid).join(", ")}) has this session open. Close it there, or move with take over.`,
    });
  }
  const busy = holders.find((entry) => entry.status !== "idle");
  if (busy !== undefined) {
    return yield* new ClaudeSessionMoveError({
      reason: "busy",
      message: `The claude holding this session (pid ${busy.pid}) is ${busy.status ?? "in an unknown state"}, and a working session is never taken over. Move it once it is idle.`,
    });
  }
  for (const holder of holders) yield* input.signal(holder.pid);
  for (let check = 0; check < RELEASE_CHECKS; check++) {
    yield* input.pause;
    if (!(yield* input.live(input.sessionsDir)).has(input.sessionId)) return;
  }
  return yield* new ClaudeSessionMoveError({
    reason: "held",
    message: "The claude holding this session did not end after it was asked to. Close it there.",
  });
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;
  const replication = yield* ClaudeSessionReplication;
  const peers = yield* PeerClaudeSessions.PeerClaudeSessions;
  const links = yield* PeerLinks.PeerLinks;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const liveSessions = yield* ClaudeLiveSessions;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const random = yield* SecureRandom.SecureRandom;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pending = yield* Ref.make<ReadonlyMap<string, PendingMove>>(new Map());

  const withHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const storage = (message: string) => (cause: unknown) =>
    new ClaudeSessionMoveError({ reason: "storage", message, cause });

  const release = (input: {
    readonly sessionsDir: string;
    readonly sessionId: string;
    readonly takeOver: boolean;
  }) =>
    releaseClaudeSession({
      ...input,
      live: liveSessions.read,
      pause: Effect.sleep(RELEASE_CHECK),
      signal: (pid) =>
        Effect.try({
          try: () => void process.kill(pid, "SIGTERM"),
          catch: storage(`The claude holding this session (pid ${pid}) could not be signalled.`),
        }),
    }).pipe(withHost);

  const canonicalKey = (root: string) =>
    identities
      .resolve(root)
      .pipe(
        Effect.map((identity) => (identity === null ? null : repositoryGroupingKeyOf(identity))),
      );

  const move: ClaudeSessionMove["Service"]["move"] = Effect.fn("ClaudeSessionMove.move")(
    function* (input) {
      const located = yield* replication.ownedSession(input.sessionId).pipe(
        Effect.mapError(
          (error) =>
            new ClaudeSessionMoveError({
              reason: "not_owned",
              message:
                error.reason === "not_found"
                  ? "This environment does not own that session, so it cannot move it. Move it from the environment that owns it."
                  : error.message,
              cause: error,
            }),
        ),
      );
      const link = yield* links.get(input.targetEnvironmentId).pipe(Effect.orDie);
      if (Option.isNone(link)) {
        return yield* new ClaudeSessionMoveError({
          reason: "unreachable",
          message: "This environment is not linked to that one. Link them both ways first.",
        });
      }
      yield* release({
        sessionsDir: path.join(located.layout.home, "sessions"),
        sessionId: input.sessionId,
        takeOver: input.takeOver,
      });
      const compact = yield* ClaudeMoveCompaction;
      yield* compact({
        sessionId: input.sessionId,
        targetEnvironmentId: input.targetEnvironmentId,
      });

      const moveId = Hex.encode(yield* random.randomBytes(16));
      const packageDir = path.join(config.stateDir, "claude-moves", "out", moveId);
      const cleanup = Effect.all([
        Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(moveId);
          return next;
        }),
        fileSystem.remove(packageDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ]);
      return yield* Effect.gen(function* () {
        const code = yield* captureClaudeSessionCode({
          cwd: located.cwd,
          packageDir,
          canonicalKey,
        }).pipe(withHost);
        yield* Ref.update(pending, (current) =>
          new Map(current).set(moveId, {
            sessionId: input.sessionId,
            targetEnvironmentId: input.targetEnvironmentId,
            packageDir,
            code,
          }),
        );
        return yield* peers
          .offerMove({
            environmentId: input.targetEnvironmentId,
            offer: {
              moveId,
              sessionId: input.sessionId,
              sourceEnvironmentId: yield* environment.getEnvironmentId,
            },
          })
          .pipe(Effect.mapError(fromReplication));
      }).pipe(Effect.ensuring(cleanup));
    },
  );

  /** Where the target clones a repository it has no checkout of, beside its worktrees. */
  const cloneFor = Effect.fn("ClaudeSessionMove.cloneFor")(
    function* (code: Extract<ClaudeSessionCodePackage, { readonly kind: "git" }>, base: string) {
      const name =
        path.basename(code.remoteUrl.replace(/\/+$/, "")).replace(/\.git$/, "") || "repository";
      let target = path.join(base, name, name);
      for (let suffix = 2; yield* fileSystem.exists(target); suffix++) {
        target = path.join(base, name, `${name}-${suffix}`);
      }
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* git(path.dirname(target), ["clone", "--quiet", code.remoteUrl, target]).pipe(withHost);
      return target;
    },
    Effect.catchTags({ PlatformError: storage("The repository could not be cloned here.") }),
  );

  const accept: ClaudeSessionMove["Service"]["accept"] = Effect.fn("ClaudeSessionMove.accept")(
    function* (offer) {
      const source = offer.sourceEnvironmentId;
      const code = yield* peers
        .moveManifest({ environmentId: source, moveId: offer.moveId })
        .pipe(Effect.mapError(fromReplication));
      const staging = path.join(config.stateDir, "claude-moves", "in", offer.moveId);
      const warnings: Array<string> = [];
      let codeBytes = 0;
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(storage("Could not read settings.")),
      );
      const base = resolveWorktreesDirectory(
        settings.worktreesDirectory,
        config.worktreesDir,
        path,
        homeDirectory,
      );
      if (base === null) {
        return yield* new ClaudeSessionMoveError({
          reason: "storage",
          message: "The worktree location in Settings → Worktrees is not a folder on this machine.",
        });
      }
      const placed = yield* Effect.gen(function* () {
        if (code.kind === "none") {
          warnings.push(
            code.cwd === null
              ? "The session had no directory, so only the session moved."
              : `${code.cwd} is not in a git repository, so only the session moved, not its files.`,
          );
          const present =
            code.cwd !== null &&
            (yield* fileSystem.exists(code.cwd).pipe(Effect.orElseSucceed(() => false)));
          if (code.cwd === null || present)
            return { cwd: code.cwd, worktreePath: null, branch: null };
          // Claude finds a session by its directory, so one that is missing here gets a folder of
          // its own beside the worktrees; the source's path may not be creatable on this machine.
          const folder = path.join(
            base,
            "moved-sessions",
            `${path.basename(code.cwd)}-${offer.moveId.slice(0, 8)}`,
          );
          yield* fileSystem
            .makeDirectory(folder, { recursive: true })
            .pipe(Effect.mapError(storage(`Could not create ${folder}.`)));
          warnings.push(
            `${code.cwd} is not on this machine, so the session resumes from ${folder}.`,
          );
          return { cwd: folder, worktreePath: null, branch: null };
        }
        for (const file of claudeSessionCodeFiles(code)) {
          yield* downloadVerifiedFile({
            source: {
              readChunk: (chunk) =>
                peers.readMoveChunk({ environmentId: source, moveId: offer.moveId, ...chunk }),
            },
            file,
            target: path.join(staging, file.path),
          }).pipe(withHost, Effect.mapError(fromReplication));
          codeBytes += file.size;
        }
        const found = yield* replication
          .checkoutOf(code.canonicalKey)
          .pipe(Effect.mapError(fromReplication));
        const checkout = found ?? (yield* cloneFor(code, base));
        if (found === undefined) warnings.push(`The repository was cloned to ${checkout}.`);
        const worktreePath = path.join(
          base,
          path.basename(checkout),
          `${(code.branch ?? "session").replaceAll("/", "-")}-${offer.moveId.slice(0, 8)}`,
        );
        const restored = yield* restoreClaudeSessionCode({
          code,
          checkout,
          worktreePath,
          staging,
          moveId: offer.moveId,
        }).pipe(withHost);
        return { cwd: restored.cwd, worktreePath, branch: restored.branch };
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
      );
      const taken = yield* replication
        .takeIn({ ownerEnvironmentId: source, sessionId: offer.sessionId, cwd: placed.cwd })
        .pipe(Effect.mapError(fromReplication));
      return {
        targetEnvironmentId: yield* environment.getEnvironmentId,
        sessionId: offer.sessionId,
        cwd: placed.cwd,
        worktreePath: placed.worktreePath,
        branch: placed.branch,
        resumeCommand: claudeResumeCommand({
          sessionId: offer.sessionId,
          cwd: placed.cwd,
          home: taken.home,
          defaultHome: path.join(homeDirectory, ".claude"),
        }),
        codeBytes,
        warnings,
      } satisfies ClaudeSessionMoveResult;
    },
  );

  return ClaudeSessionMove.of({
    move,
    accept,
    packageOf: Effect.fn("ClaudeSessionMove.packageOf")(function* (moveId: string) {
      const found = (yield* Ref.get(pending)).get(moveId);
      return found === undefined ? undefined : { code: found.code, packageDir: found.packageDir };
    }),
  });
});

export const layer = Layer.effect(ClaudeSessionMove, make);
