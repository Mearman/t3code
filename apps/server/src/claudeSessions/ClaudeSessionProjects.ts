// @effect-diagnostics nodeBuiltinImport:off - node:os names the system temporary directory and node:crypto digests a store key.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CommandId, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { claudeLocalSettingsDirectory } from "../provider/Drivers/ClaudeHome.ts";

export class ClaudeSessionProjectError extends Schema.TaggedError<ClaudeSessionProjectError>()(
  "ClaudeSessionProjectError",
  { workspaceRoot: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not find or create the project for ${this.workspaceRoot}.`;
  }
}

/**
 * Where a session's thread lives. `worktreePath` is the session's own working directory whenever it is not the project root, so a send, and a terminal `claude --resume`, run where the session ran.
 */
export interface ClaudeSessionPlacement {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export class ClaudeSessionProjects extends Context.Service<
  ClaudeSessionProjects,
  {
    /**
     * The project of a session's working directory: its repository's main checkout, or the directory itself outside a repository. A missing, temporary, home or root directory, one whose project the user deleted, and one the project rules refuse go to one project the store's sessions share. Undefined when that shared project was deleted too.
     */
    readonly resolve: (input: {
      readonly cwd: string | undefined;
      readonly storeKey: string;
    }) => Effect.Effect<ClaudeSessionPlacement | undefined, ClaudeSessionProjectError>;
  }
>()("t3/claudeSessions/ClaudeSessionProjects") {}

/** Directories whose sessions are scratch work, so they share the store's project. */
export const ClaudeTemporaryRoots = Context.Reference<ReadonlyArray<string>>(
  "t3/claudeSessions/ClaudeSessionProjects/ClaudeTemporaryRoots",
  {
    defaultValue: () => [
      NodeOS.tmpdir(),
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ],
  },
);

type ProjectLookup =
  | { readonly _tag: "Found"; readonly id: ProjectId }
  | { readonly _tag: "Unusable" };

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const home = yield* HostProcess.HomeDirectory;
  // A cached id is checked on every use, so a project deleted since is never written to.
  const known = new Map<string, ProjectId>();
  // Roots whose project the user deleted; an active project of the same root is still found first.
  const deletedRoots = new Set<string>();
  const temporaryRoots = yield* ClaudeTemporaryRoots;

  const isTemporary = (directory: string) =>
    temporaryRoots.some((root) => directory === root || directory.startsWith(`${root}${path.sep}`));
  // A project there would hold the user's whole home or file system.
  const isTooBroad = (directory: string) =>
    directory === home || directory === path.parse(directory).root;
  const exists = (directory: string) =>
    fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false));

  const lookup = Effect.fn("ClaudeSessionProjects.lookup")(function* (
    workspaceRoot: string,
    title: string,
  ) {
    const cached = known.get(workspaceRoot);
    if (cached !== undefined) {
      if (Option.isSome(yield* projects.getById(cached))) {
        return { _tag: "Found", id: cached } satisfies ProjectLookup;
      }
      known.delete(workspaceRoot);
    }
    const active = yield* projects.getByWorkspaceRoot(workspaceRoot);
    if (Option.isSome(active)) {
      known.set(workspaceRoot, active.value.id);
      return { _tag: "Found", id: active.value.id } satisfies ProjectLookup;
    }
    if (!deletedRoots.has(workspaceRoot)) {
      const any = yield* projects.getByWorkspaceRoot(workspaceRoot, { includeDeleted: true });
      if (Option.isSome(any)) deletedRoots.add(workspaceRoot);
    }
    if (deletedRoots.has(workspaceRoot)) return { _tag: "Unusable" } satisfies ProjectLookup;
    const id = yield* random.uuidV4();
    return yield* projects
      .bootstrap({
        commandId: CommandId.make(`claude-session-project:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
      })
      .pipe(
        Effect.map(({ project }): ProjectLookup => {
          known.set(workspaceRoot, project.id);
          return { _tag: "Found", id: project.id };
        }),
        Effect.catchTags({
          // bootstrap reads before it locks, so a racing create reports the winner as a conflict.
          ProjectConflictError: (conflict) =>
            Effect.succeed<ProjectLookup>({ _tag: "Found", id: conflict.conflictingProjectId }),
          ProjectInvalidError: () => Effect.succeed<ProjectLookup>({ _tag: "Unusable" }),
        }),
      );
  });

  const sharedProject = Effect.fn("ClaudeSessionProjects.sharedProject")(function* (
    storeKey: string,
  ) {
    const digest = NodeCrypto.createHash("sha256").update(storeKey).digest("hex").slice(0, 16);
    const root = path.join(config.stateDir, "claude-sessions", digest);
    // The server's own directory, which it creates; no session directory is ever created.
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const found = yield* lookup(root, "Claude sessions");
    return found._tag === "Found" ? found.id : undefined;
  });

  const shared = (storeKey: string, worktreePath: string | null) =>
    Effect.map(sharedProject(storeKey), (projectId) =>
      projectId === undefined ? undefined : { projectId, worktreePath },
    );

  const resolve: ClaudeSessionProjects["Service"]["resolve"] = Effect.fn(
    "ClaudeSessionProjects.resolve",
  )(
    function* ({ cwd, storeKey }) {
      if (cwd === undefined) return yield* shared(storeKey, null);
      if (!(yield* exists(cwd)) || isTemporary(cwd) || isTooBroad(cwd)) {
        return yield* shared(storeKey, cwd);
      }
      const checkout = yield* claudeLocalSettingsDirectory(cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      // A `.git` pointer can name a main checkout that is gone; the session's directory stands in.
      const root = checkout === cwd || (yield* exists(checkout)) ? checkout : cwd;
      if (isTooBroad(root)) return yield* shared(storeKey, cwd);
      const found = yield* lookup(root, path.basename(root) || root);
      if (found._tag === "Unusable") return yield* shared(storeKey, cwd);
      return { projectId: found.id, worktreePath: root === cwd ? null : cwd };
    },
    (effect, { cwd }) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ClaudeSessionProjectError({ workspaceRoot: cwd ?? "", cause }),
        ),
      ),
  );

  return ClaudeSessionProjects.of({ resolve });
});

export const layer = Layer.effect(ClaudeSessionProjects, make);
