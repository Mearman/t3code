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
  sameChanges,
} from "./ClaudeSessionCode.ts";

const IDENTITY = ["-c", "user.name=t3", "-c", "user.email=t3@example.com"];
const MOVE = "0123456789abcdef0123456789abcdef";

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
          moveId: MOVE,
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

  it.effect("recreates changes to a file in a legacy encoding byte for byte", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      // "café" and "naïve" in Latin-1: text to git, but not UTF-8.
      const stagedBytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
      const unstagedBytes = new Uint8Array([0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);
      yield* fileSystem.writeFile(path.join(source, "README.md"), stagedBytes);
      yield* git(source, ["add", "README.md"]);
      yield* fileSystem.writeFile(path.join(source, "src", "app.ts"), unstagedBytes);
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const worktreePath = path.join(root, "target", "worktrees", "latin1");

      yield* restoreClaudeSessionCode({
        code,
        checkout: existing,
        worktreePath,
        staging: packageDir,
        moveId: MOVE,
      });

      expect([...(yield* fileSystem.readFile(path.join(worktreePath, "README.md")))]).toEqual([
        ...stagedBytes,
      ]);
      expect([...(yield* fileSystem.readFile(path.join(worktreePath, "src", "app.ts")))]).toEqual([
        ...unstagedBytes,
      ]);
      expect((yield* git(worktreePath, ["diff", "--cached", "--name-only"])).stdout).toBe(
        "README.md\n",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("applies the changes as written whatever the checkout's whitespace config", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      yield* git(existing, ["config", "apply.whitespace", "fix"]);
      const edited = "one\ntrailing   \n";
      yield* fileSystem.writeFileString(path.join(source, "README.md"), edited);
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const worktreePath = path.join(root, "target", "worktrees", "spaces");

      yield* restoreClaudeSessionCode({
        code,
        checkout: existing,
        worktreePath,
        staging: packageDir,
        moveId: MOVE,
      });

      expect(yield* fileSystem.readFileString(path.join(worktreePath, "README.md"))).toBe(edited);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses changes this checkout describes differently, such as a file it marks binary",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, source, existing } = yield* makeRepos;
        yield* fileSystem.writeFileString(
          path.join(existing, ".git", "info", "attributes"),
          "README.md -diff\n",
        );
        yield* fileSystem.writeFileString(path.join(source, "README.md"), "one\ntwo\n");
        const packageDir = path.join(root, "package");
        const code = yield* capture(source, packageDir);
        if (code.kind !== "git") return expect.unreachable();
        const worktreePath = path.join(root, "target", "worktrees", "binary");

        const refused = yield* Effect.flip(
          restoreClaudeSessionCode({
            code,
            checkout: existing,
            worktreePath,
            staging: packageDir,
            moveId: MOVE,
          }),
        );

        expect(refused.message).toContain("did not come out the same");
        expect(yield* fileSystem.exists(worktreePath)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("recreates a staged binary change byte for byte", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => (index * 7) % 256));
      yield* fileSystem.writeFile(path.join(source, "blob.bin"), bytes);
      yield* git(source, ["add", "blob.bin"]);
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const worktreePath = path.join(root, "target", "worktrees", "binary-change");

      yield* restoreClaudeSessionCode({
        code,
        checkout: existing,
        worktreePath,
        staging: packageDir,
        moveId: MOVE,
      });

      expect([...(yield* fileSystem.readFile(path.join(worktreePath, "blob.bin")))]).toEqual([
        ...bytes,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("names every changed file's blobs in full in the patches it packs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source } = yield* makeRepos;
      yield* fileSystem.writeFileString(path.join(source, "README.md"), "changed\n");
      yield* git(source, ["add", "README.md"]);
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git" || code.staged === null) return expect.unreachable();

      const patch = yield* fileSystem.readFileString(path.join(packageDir, code.staged.path));

      expect(patch).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40} /m);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an untracked file executable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      yield* fileSystem.writeFileString(path.join(source, "run.sh"), "#!/bin/sh\n");
      yield* fileSystem.chmod(path.join(source, "run.sh"), 0o755);
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const worktreePath = path.join(root, "target", "worktrees", "exec");

      yield* restoreClaudeSessionCode({
        code,
        checkout: existing,
        worktreePath,
        staging: packageDir,
        moveId: MOVE,
      });

      expect((yield* fileSystem.stat(path.join(worktreePath, "run.sh"))).mode & 0o111).not.toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("stops a move that would carry a repository git does not track", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source } = yield* makeRepos;
      const nested = path.join(source, "nested");
      yield* fileSystem.makeDirectory(nested);
      yield* git(nested, ["init", "-q", "-b", "main"]);
      yield* fileSystem.writeFileString(path.join(nested, "a"), "a\n");
      yield* git(nested, ["add", "a"]);
      yield* git(nested, [...IDENTITY, "commit", "-qm", "a"]);
      const stopped = yield* Effect.flip(capture(source, path.join(root, "package")));
      expect(stopped.reason).toBe("submodule");
      expect(stopped.message).toContain("nested/");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fetches a commit only the remote has without touching the checkout's remote-tracking refs",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, source, existing } = yield* makeRepos;
        yield* fileSystem.writeFileString(path.join(source, "README.md"), "pushed\n");
        yield* git(source, ["add", "README.md"]);
        yield* git(source, [...IDENTITY, "commit", "-qm", "pushed"]);
        yield* git(source, ["push", "-q", "origin", "main"]);
        const remoteRefs = () => git(existing, ["for-each-ref", "refs/remotes"]);
        const before = (yield* remoteRefs()).stdout;
        const packageDir = path.join(root, "package");
        const code = yield* capture(source, packageDir);
        if (code.kind !== "git") return expect.unreachable();
        expect(code.bundle).toBeNull();

        yield* restoreClaudeSessionCode({
          code,
          checkout: existing,
          worktreePath: path.join(root, "target", "worktrees", "pushed"),
          staging: packageDir,
          moveId: MOVE,
        });

        expect((yield* remoteRefs()).stdout).toBe(before);
        expect(yield* fileSystem.exists(path.join(existing, ".git", "FETCH_HEAD"))).toBe(false);
        expect((yield* git(existing, ["for-each-ref", "refs/t3code"])).stdout).toBe("");
      }).pipe(Effect.scoped),
  );

  it.effect("leaves no move refs behind when the changes cannot be recreated", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      yield* fileSystem.writeFileString(
        path.join(source, "src", "app.ts"),
        "export const b = 2;\n",
      );
      yield* git(source, ["add", "src/app.ts"]);
      yield* git(source, [...IDENTITY, "commit", "-qm", "unpushed"]);
      yield* fileSystem.writeFileString(path.join(source, "README.md"), "one\nedit\n");
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git" || code.unstaged === null) return expect.unreachable();
      yield* fileSystem.writeFileString(path.join(packageDir, code.unstaged.path), "not a patch\n");
      const worktreePath = path.join(root, "target", "worktrees", "broken");

      const failed = yield* Effect.flip(
        restoreClaudeSessionCode({
          code,
          checkout: existing,
          worktreePath,
          staging: packageDir,
          moveId: MOVE,
        }),
      );

      expect(failed.reason).toBe("git");
      expect((yield* git(existing, ["for-each-ref", "refs/t3code"])).stdout).toBe("");
      expect(yield* fileSystem.exists(worktreePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "an untracked path climbing out", tamper: { untrackedPath: "../outside/x" } },
    { name: "an untracked path into a .git", tamper: { untrackedPath: "vendor/.git/config" } },
    { name: "a package file outside its package", tamper: { packagePath: "../../outside/x" } },
    { name: "a move id that climbs out", tamper: { moveId: "../.." } },
    { name: "a directory outside the repository", tamper: { relativeCwd: "../../outside" } },
    { name: "a remote that is an option", tamper: { remoteUrl: "--upload-pack=touch x" } },
    { name: "a commit that is not one", tamper: { head: "HEAD~1" } },
    { name: "a branch git refuses", tamper: { branch: "-bad..name" } },
    { name: "a branch git would expand", tamper: { branch: "@{-1}" } },
  ])("refuses a package with $name and writes nothing outside", ({ tamper }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      yield* fileSystem.writeFileString(path.join(source, "x"), "x\n");
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const outside = path.join(root, "outside");
      yield* fileSystem.makeDirectory(outside);
      const forged = {
        ...code,
        ...("remoteUrl" in tamper ? { remoteUrl: tamper.remoteUrl } : {}),
        ...("head" in tamper ? { head: tamper.head } : {}),
        ...("branch" in tamper ? { branch: tamper.branch } : {}),
        ...("relativeCwd" in tamper ? { relativeCwd: tamper.relativeCwd } : {}),
        untracked: code.untracked.map((entry) =>
          entry.kind !== "file"
            ? entry
            : {
                ...entry,
                ...("untrackedPath" in tamper ? { path: tamper.untrackedPath } : {}),
                ...("packagePath" in tamper
                  ? { file: { ...entry.file, path: tamper.packagePath } }
                  : {}),
              },
        ),
      };
      const worktreePath = path.join(root, "target", "worktrees", "forged");

      const refused = yield* Effect.flip(
        restoreClaudeSessionCode({
          code: forged,
          checkout: existing,
          worktreePath,
          staging: packageDir,
          moveId: "moveId" in tamper ? tamper.moveId : MOVE,
        }),
      );

      expect(refused.reason).toBe("refused");
      expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
      expect(yield* fileSystem.exists(worktreePath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("never writes an untracked file through a symbolic link it made", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, existing } = yield* makeRepos;
      const outside = path.join(root, "outside");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(path.join(source, "x"), "x\n");
      const packageDir = path.join(root, "package");
      const code = yield* capture(source, packageDir);
      if (code.kind !== "git") return expect.unreachable();
      const file = code.untracked.find((entry) => entry.kind === "file");
      if (file === undefined) return expect.unreachable();
      // A link to a folder outside, then a file below the link.
      const forged = {
        ...code,
        untracked: [
          { kind: "symlink" as const, path: "link", target: outside },
          { ...file, path: "link/authorized_keys" },
        ],
      };

      const refused = yield* Effect.flip(
        restoreClaudeSessionCode({
          code: forged,
          checkout: existing,
          worktreePath: path.join(root, "target", "worktrees", "linked"),
          staging: packageDir,
          moveId: MOVE,
        }),
      );

      expect(refused.reason).toBe("refused");
      expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
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

describe("sameChanges", () => {
  const patch = (index: string, payload: string, text: string) =>
    new TextEncoder().encode(
      [
        "diff --git a/logo.png b/logo.png",
        `index ${index}`,
        "GIT binary patch",
        "literal 12",
        payload,
        "",
        "diff --git a/README.md b/README.md",
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-one",
        `+${text}`,
        "",
      ].join("\n"),
    );
  const blobs = `${"a".repeat(40)}..${"b".repeat(40)}`;

  it("matches a binary change whose payload another zlib compressed differently", () => {
    expect(
      sameChanges(patch(blobs, "Mc${}compressed", "two"), patch(blobs, "Nd&+other", "two")),
    ).toBe(true);
  });

  it("tells apart a binary change to other bytes, and any text change", () => {
    const other = `${"a".repeat(40)}..${"c".repeat(40)}`;
    expect(sameChanges(patch(blobs, "Mc${}x", "two"), patch(other, "Mc${}x", "two"))).toBe(false);
    expect(sameChanges(patch(blobs, "Mc${}x", "two"), patch(blobs, "Mc${}x", "tw\u00e9"))).toBe(
      false,
    );
  });
});
