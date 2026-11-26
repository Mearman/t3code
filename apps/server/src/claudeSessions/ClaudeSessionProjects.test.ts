import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, type Project } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ClaudeSessionProjects from "./ClaudeSessionProjects.ts";

const AT = "2026-11-26T10:00:00.000Z";

/** Projects by root; a deleted one keeps its row, as the real store does. */
function fakeProjects() {
  const byRoot = new Map<string, Project>();
  const created: Array<string> = [];
  const service = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          [...byRoot.values()].find((project) => project.id === id && project.deletedAt === null),
        ),
      ),
    getByWorkspaceRoot: (root, options) =>
      Effect.succeed(
        Option.fromUndefinedOr(
          [byRoot.get(root)].find(
            (project) =>
              project !== undefined &&
              (options?.includeDeleted === true || project.deletedAt === null),
          ),
        ),
      ),
    bootstrap: (input) =>
      Effect.sync(() => {
        const project: Project = {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
          deletedAt: null,
        };
        byRoot.set(input.workspaceRoot, project);
        created.push(input.workspaceRoot);
        return { project, created: true };
      }),
  });
  const remove = (root: string) => {
    const project = byRoot.get(root);
    if (project !== undefined) byRoot.set(root, { ...project, deletedAt: AT });
  };
  return { service, created, remove, byRoot };
}

const withRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* body(yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const resolverLayer = (input: {
  readonly root: string;
  readonly home: string;
  readonly projects: ReturnType<typeof fakeProjects>;
  readonly temporaryRoots?: ReadonlyArray<string>;
}) =>
  ClaudeSessionProjects.layer.pipe(
    Layer.provide(
      Layer.succeed(ClaudeSessionProjects.ClaudeTemporaryRoots, input.temporaryRoots ?? []),
    ),
    Layer.provide(input.projects.service),
    Layer.provide(ServerConfig.layerTest(input.root, { prefix: "claude-session-projects-" })),
    Layer.provide(SecureRandom.layerWebCrypto),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, input.home)),
    Layer.provide(NodeServices.layer),
  );

const STORE = "/claude/projects\0/claude/sessions";

describe("ClaudeSessionProjects", () => {
  it.effect(
    "puts a session in its main checkout's project, keeping a worktree as its directory",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const main = path.join(root, "repo");
          const worktree = path.join(root, "repo-worktrees", "feature");
          yield* fileSystem.makeDirectory(path.join(main, ".git", "worktrees", "feature"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(main, ".git", "worktrees", "feature", "commondir"),
            "../..\n",
          );
          yield* fileSystem.makeDirectory(worktree, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(worktree, ".git"),
            `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
          );
          const projects = fakeProjects();
          const placement = yield* Effect.gen(function* () {
            const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
            return yield* resolver.resolve({ cwd: worktree, storeKey: STORE });
          }).pipe(Effect.provide(resolverLayer({ root, home: path.join(root, "home"), projects })));
          expect(projects.created).toEqual([main]);
          expect(placement).toEqual({
            projectId: projects.byRoot.get(main)?.id,
            worktreePath: worktree,
          });
        }),
      ),
  );

  it.effect("never creates the main checkout a stale .git pointer names", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = path.join(root, "orphan");
        const gone = path.join(root, "gone");
        yield* fileSystem.makeDirectory(cwd, { recursive: true });
        yield* fileSystem.makeDirectory(path.join(gone, ".git", "worktrees", "orphan"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(gone, ".git", "worktrees", "orphan", "commondir"),
          "../..\n",
        );
        yield* fileSystem.writeFileString(
          path.join(cwd, ".git"),
          `gitdir: ${path.join(gone, ".git", "worktrees", "orphan")}\n`,
        );
        yield* fileSystem.remove(gone, { recursive: true });
        const projects = fakeProjects();
        const placement = yield* Effect.gen(function* () {
          const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
          return yield* resolver.resolve({ cwd, storeKey: STORE });
        }).pipe(Effect.provide(resolverLayer({ root, home: path.join(root, "home"), projects })));
        expect(yield* fileSystem.exists(gone)).toBe(false);
        expect(projects.created).toEqual([cwd]);
        expect(placement?.worktreePath).toBeNull();
      }),
    ),
  );

  it.effect(
    "shares one project for missing, home and deleted-project directories, keeping each cwd",
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = path.join(root, "home");
          const kept = path.join(root, "kept");
          const scratch = path.join(root, "scratch", "run-1");
          yield* fileSystem.makeDirectory(scratch, { recursive: true });
          yield* fileSystem.makeDirectory(home, { recursive: true });
          yield* fileSystem.makeDirectory(kept, { recursive: true });
          const projects = fakeProjects();
          yield* Effect.gen(function* () {
            const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
            const missing = path.join(root, "missing");
            const placed = yield* resolver.resolve({ cwd: kept, storeKey: STORE });
            expect(placed?.worktreePath).toBeNull();

            const atMissing = yield* resolver.resolve({ cwd: missing, storeKey: STORE });
            const atHome = yield* resolver.resolve({ cwd: home, storeKey: STORE });
            const atRoot = yield* resolver.resolve({ cwd: path.parse(root).root, storeKey: STORE });
            const atScratch = yield* resolver.resolve({ cwd: scratch, storeKey: STORE });
            expect(atMissing?.worktreePath).toBe(missing);
            expect(atHome?.worktreePath).toBe(home);
            expect(atScratch?.worktreePath).toBe(scratch);
            expect(
              new Set([
                atMissing?.projectId,
                atHome?.projectId,
                atRoot?.projectId,
                atScratch?.projectId,
              ]).size,
            ).toBe(1);
            expect(projects.created).not.toContain(home);

            // The user deleted the directory's project: it is not brought back, now or later.
            projects.remove(kept);
            const afterDelete = yield* resolver.resolve({ cwd: kept, storeKey: STORE });
            expect(afterDelete).toEqual({ projectId: atMissing?.projectId, worktreePath: kept });
            expect(projects.created.filter((created) => created === kept)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              resolverLayer({ root, home, projects, temporaryRoots: [path.join(root, "scratch")] }),
            ),
          );

          // A fresh resolver, as after a restart, still does not recreate it.
          yield* Effect.gen(function* () {
            const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
            yield* resolver.resolve({ cwd: kept, storeKey: STORE });
            expect(projects.created.filter((created) => created === kept)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              resolverLayer({ root, home, projects, temporaryRoots: [path.join(root, "scratch")] }),
            ),
          );
        }),
      ),
  );

  it.effect("places nothing once the shared project itself was deleted", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const projects = fakeProjects();
        yield* Effect.gen(function* () {
          const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
          const first = yield* resolver.resolve({ cwd: undefined, storeKey: STORE });
          const sharedRoot = [...projects.byRoot.entries()].find(
            ([, project]) => project.id === first?.projectId,
          )?.[0];
          expect(sharedRoot).toBeDefined();
          if (sharedRoot === undefined) return;
          projects.remove(sharedRoot);
          expect(yield* resolver.resolve({ cwd: undefined, storeKey: STORE })).toBeUndefined();
        }).pipe(Effect.provide(resolverLayer({ root, home: path.join(root, "home"), projects })));
      }),
    ),
  );

  it.effect("creates the shared and per-directory projects through the real project service", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const kept = path.join(root, "kept");
        yield* fileSystem.makeDirectory(kept, { recursive: true });
        yield* Effect.gen(function* () {
          const resolver = yield* ClaudeSessionProjects.ClaudeSessionProjects;
          const projects = yield* ProjectService.ProjectService;

          const missing = yield* resolver.resolve({
            cwd: path.join(root, "gone"),
            storeKey: STORE,
          });
          expect(missing).toBeDefined();
          if (missing === undefined) return;
          expect(Option.isSome(yield* projects.getById(missing.projectId))).toBe(true);
          expect(yield* fileSystem.exists(path.join(root, "gone"))).toBe(false);

          const placed = yield* resolver.resolve({ cwd: kept, storeKey: STORE });
          expect(placed?.projectId).not.toBe(missing.projectId);
          if (placed === undefined) return;
          yield* projects.delete({
            commandId: CommandId.make("delete-kept"),
            projectId: placed.projectId,
          });
          expect(yield* resolver.resolve({ cwd: kept, storeKey: STORE })).toEqual({
            projectId: missing.projectId,
            worktreePath: kept,
          });
        }).pipe(Effect.provide(realLayer(root)));
      }),
    ),
  );
});

const layerGitWorkflow = GitWorkflow.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
);

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        invalidate: () => Effect.void,
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const realLayer = (root: string) =>
  ClaudeSessionProjects.layer.pipe(
    Layer.provide(Layer.succeed(ClaudeSessionProjects.ClaudeTemporaryRoots, [])),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, `${root}/home`)),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(layerGitWorkflow),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(root, root)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
