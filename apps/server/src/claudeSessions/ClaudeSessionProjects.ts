// @effect-diagnostics nodeBuiltinImport:off - node:os names the system temporary directory and node:crypto digests a store key.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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

/** Where a session's thread lives, and the directory it runs in when that is not the project root. */
export interface ClaudeSessionPlacement {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export class ClaudeSessionProjects extends Context.Service<
  ClaudeSessionProjects,
  {
    /**
     * The project of a session's working directory: its repository's main checkout, or the directory itself outside a repository. A missing or temporary directory goes to one project the store's sessions share.
     */
    readonly resolve: (input: {
      readonly cwd: string | undefined;
      readonly storeKey: string;
    }) => Effect.Effect<ClaudeSessionPlacement, ClaudeSessionProjectError>;
  }
>()("t3/claudeSessions/ClaudeSessionProjects") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const random = yield* SecureRandom.SecureRandom;
  const known = new Map<string, ProjectId>();
  const temporaryRoots = [
    NodeOS.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
  ];

  const isTemporary = (directory: string) =>
    temporaryRoots.some((root) => directory === root || directory.startsWith(`${root}${path.sep}`));

  const projectAt = Effect.fn("ClaudeSessionProjects.projectAt")(function* (
    workspaceRoot: string,
    title: string,
  ) {
    const cached = known.get(workspaceRoot);
    if (cached !== undefined) return cached;
    const id = yield* random.uuidV4();
    const bootstrapped = yield* projects
      .bootstrap({
        commandId: CommandId.make(`claude-session-project:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        // bootstrap reads before it locks, so a racing create reports the winner as a conflict.
        Effect.map(({ project }) => project.id),
        Effect.catchTag("ProjectConflictError", (conflict) =>
          Effect.succeed(conflict.conflictingProjectId),
        ),
      );
    known.set(workspaceRoot, bootstrapped);
    return bootstrapped;
  });

  const sharedProject = (storeKey: string) => {
    const digest = NodeCrypto.createHash("sha256").update(storeKey).digest("hex").slice(0, 16);
    return projectAt(path.join(config.stateDir, "claude-sessions", digest), "Claude sessions");
  };

  const resolve: ClaudeSessionProjects["Service"]["resolve"] = Effect.fn(
    "ClaudeSessionProjects.resolve",
  )(
    function* ({ cwd, storeKey }) {
      if (cwd === undefined)
        return { projectId: yield* sharedProject(storeKey), worktreePath: null };
      const exists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false));
      if (!exists || isTemporary(cwd)) {
        return { projectId: yield* sharedProject(storeKey), worktreePath: exists ? cwd : null };
      }
      const root = yield* claudeLocalSettingsDirectory(cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const projectId = yield* projectAt(root, path.basename(root) || root).pipe(
        // A folder the project rules refuse still has its sessions shown, in the shared project.
        Effect.catchTag("ProjectInvalidError", () => sharedProject(storeKey)),
      );
      return { projectId, worktreePath: root === cwd ? null : cwd };
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
