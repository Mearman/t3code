import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  captureClaudeSessionCode,
  claudeSessionCodeFiles,
  git,
  restoreClaudeSessionCode,
} from "./ClaudeSessionCode.ts";

const IDENTITY = ["-c", "user.name=t3", "-c", "user.email=t3@example.com"];

/** A bare remote with one commit, a clone `source` of it and a clone `existing` elsewhere. */
const makeRepos = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  yield* fileSystem.makeDirectory(seed);
  yield* git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  yield* git(seed, ["init", "-q", "-b", "main"]);
  yield* fileSystem.writeFileString(path.join(seed, "README.md"), "one\n");
  yield* fileSystem.writeFileString(path.join(seed, ".gitignore"), ".env\n");
  yield* fileSystem.makeDirectory(path.join(seed, "src"));
  yield* fileSystem.writeFileString(path.join(seed, "src", "app.ts"), "export {};\n");
  yield* git(seed, ["add", "."]);
  yield* git(seed, [...IDENTITY, "commit", "-qm", "init"]);
  yield* git(seed, ["remote", "add", "origin", `file://${remote}`]);
  yield* git(seed, ["push", "-q", "origin", "main"]);
  const source = path.join(root, "source");
  const existing = path.join(root, "target", "existing");
  yield* git(root, ["clone", "-q", `file://${remote}`, source]);
  yield* git(root, ["clone", "-q", `file://${remote}`, existing]);
  return { root, remote, source, existing };
});

/** Everything a person would notice changed in a checkout. */
const snapshot = (checkout: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return {
      head: (yield* git(checkout, ["rev-parse", "HEAD"])).stdout,
      status: (yield* git(checkout, ["status", "--porcelain=v2", "--branch", "-uall"])).stdout,
      // Branches it had; the move adds one of its own for the new worktree, asserted apart.
      branches: (yield* git(checkout, ["branch", "--format=%(refname) %(objectname)"])).stdout
        .split("\n")
        .filter((line) => !line.includes("-moved-")),
      readme: yield* fileSystem.readFileString(path.join(checkout, "README.md")),
    };
  });

const capture = (cwd: string | null, packageDir: string) =>
  captureClaudeSessionCode({ cwd, packageDir, canonicalKey: () => Effect.succeed("example/repo") });

it.layer(NodeServices.layer)("session code", (it) => {
  it.effect(
    "recreates unpushed commits, staged, unstaged and untracked changes in a new worktree, leaving the existing checkout and ignored files alone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, source, existing } = yield* makeRepos;
        // Source: one unpushed commit, a staged edit, an unstaged edit, an untracked file and link,
        // and an ignored secret.
        yield* fileSystem.writeFileString(
          path.join(source, "src", "app.ts"),
          "export const a = 1;\n",
        );
        yield* git(source, ["add", "src/app.ts"]);
        yield* git(source, [...IDENTITY, "commit", "-qm", "unpushed"]);
        yield* fileSystem.writeFileString(path.join(source, "README.md"), "one\nstaged\n");
        yield* git(source, ["add", "README.md"]);
        yield* fileSystem.writeFileString(
          path.join(source, "README.md"),
          "one\nstaged\nunstaged\n",
        );
        yield* fileSystem.writeFileString(path.join(source, "src", "new.ts"), "new\n");
        yield* fileSystem.symlink("new.ts", path.join(source, "src", "link.ts"));
        yield* fileSystem.writeFileString(path.join(source, ".env"), "SECRET=1\n");
        // The existing checkout has work of its own that must survive.
        yield* fileSystem.writeFileString(path.join(existing, "README.md"), "theirs\n");
        const before = yield* snapshot(existing);
        const sourceBefore = yield* snapshot(source);

        const packageDir = path.join(root, "package");
        const code = yield* capture(path.join(source, "src"), packageDir);
        if (code.kind !== "git") return expect.unreachable();
        expect(code.relativeCwd).toBe("src");
        expect(code.bundle).not.toBeNull();
        expect(code.untracked.map((entry) => entry.path).sort()).toEqual([
          "src/link.ts",
          "src/new.ts",
        ]);
        expect(claudeSessionCodeFiles(code).every((file) => !file.path.includes(".env"))).toBe(
          true,
        );
        expect(yield* snapshot(source)).toEqual(sourceBefore);

        const worktreePath = path.join(root, "target", "worktrees", "moved");
        const restored = yield* restoreClaudeSessionCode({
          code,
          checkout: existing,
          worktreePath,
          staging: packageDir,
          moveId: "0123456789abcdef",
        });

        expect(restored.cwd).toBe(path.join(worktreePath, "src"));
        expect(restored.branch).toBe("main-moved-01234567");
        expect((yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(code.head);
        for (const args of [
          ["diff", "--cached", "--binary"],
          ["diff", "--binary"],
        ]) {
          expect((yield* git(worktreePath, args)).stdout).toBe((yield* git(source, args)).stdout);
        }
        expect(yield* fileSystem.readFileString(path.join(worktreePath, "src", "new.ts"))).toBe(
          "new\n",
        );
        expect(yield* fileSystem.readLink(path.join(worktreePath, "src", "link.ts"))).toBe(
          "new.ts",
        );
        expect(yield* fileSystem.exists(path.join(worktreePath, ".env"))).toBe(false);
        expect(yield* snapshot(existing)).toEqual(before);
        expect(
          (yield* git(existing, ["rev-parse", "refs/heads/main-moved-01234567"])).stdout.trim(),
        ).toBe((yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim());
        const refs = (yield* git(existing, ["for-each-ref", "refs/t3code"])).stdout;
        expect(refs).toBe("");
      }).pipe(Effect.scoped),
  );

  it.effect("carries nothing but a warning for a directory outside git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const plain = path.join(root, "plain");
      yield* fileSystem.makeDirectory(plain);
      expect(yield* capture(plain, path.join(root, "package"))).toEqual({
        kind: "none",
        cwd: plain,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("stops a move whose repository has no remote", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      yield* git(root, ["init", "-q", "-b", "main"]);
      yield* fileSystem.writeFileString(path.join(root, "a"), "a\n");
      yield* git(root, ["add", "a"]);
      yield* git(root, [...IDENTITY, "commit", "-qm", "a"]);
      const stopped = yield* Effect.flip(capture(root, path.join(root, "..", "package")));
      expect(stopped.reason).toBe("no_remote");
    }).pipe(Effect.scoped),
  );

  it.effect("stops a move that would carry Git LFS content, and names the file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source } = yield* makeRepos;
      yield* fileSystem.writeFileString(
        path.join(source, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      yield* fileSystem.writeFileString(path.join(source, "model.bin"), "weights\n");
      const stopped = yield* Effect.flip(capture(source, path.join(root, "package")));
      expect(stopped.reason).toBe("lfs");
      expect(stopped.message).toContain("model.bin");
    }).pipe(Effect.scoped),
  );

  it.effect("stops a move when a submodule has changes the move cannot carry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, remote, source } = yield* makeRepos;
      yield* git(source, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        `file://${remote}`,
        "vendor/lib",
      ]);
      yield* git(source, [...IDENTITY, "commit", "-qm", "submodule"]);
      yield* fileSystem.writeFileString(
        path.join(source, "vendor", "lib", "README.md"),
        "edited\n",
      );
      const stopped = yield* Effect.flip(capture(source, path.join(root, "package")));
      expect(stopped.reason).toBe("submodule");
      expect(stopped.message).toContain("vendor/lib");
    }).pipe(Effect.scoped),
  );
});

describe("claudeSessionCodeFiles", () => {
  it("lists nothing for code outside git", () => {
    expect(claudeSessionCodeFiles({ kind: "none", cwd: "/tmp/x" })).toEqual([]);
  });
});
