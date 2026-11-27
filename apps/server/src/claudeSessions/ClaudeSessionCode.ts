import {
  type ClaudeSessionCodeEntry,
  type ClaudeSessionCodePackage,
  type ClaudeSessionFile,
  ClaudeSessionMoveError,
} from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";

import { sha256OfFile } from "./ClaudeSessionFiles.ts";

/** Package files are named by these paths below the package directory. */
const BUNDLE = "bundle";
const STAGED = "staged.patch";
const UNSTAGED = "unstaged.patch";
const UNTRACKED_DIR = "untracked";

const moveError = (reason: ClaudeSessionMoveError["reason"], message: string, cause?: unknown) =>
  new ClaudeSessionMoveError({ reason, message, ...(cause === undefined ? {} : { cause }) });

/** Runs git in `cwd`; output is returned as text, a non-zero exit is an error naming the call. */
export const git = Effect.fn("ClaudeSessionCode.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowFailure?: boolean },
) {
  const environment = yield* HostProcess.Environment;
  const result = yield* spawnAndCollect(
    "git",
    ChildProcess.make("git", ["-C", cwd, ...args], {
      env: { ...environment, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }),
    { maxStdoutBytes: 64 * 1024 * 1024 },
  ).pipe(Effect.mapError((cause) => moveError("git", `git ${args[0]} could not run.`, cause)));
  if (result.code !== 0 && options?.allowFailure !== true) {
    return yield* moveError(
      "git",
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result;
});

const describeFile = Effect.fn("ClaudeSessionCode.describeFile")(function* (
  packageDir: string,
  relative: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(packageDir, relative);
  const size = Number((yield* fileSystem.stat(absolute)).size);
  return {
    path: relative,
    size,
    sha256: yield* sha256OfFile(absolute, size),
  } satisfies ClaudeSessionFile;
});

/** Writes `text` as a package file, or nothing when it is empty. */
const writePatch = Effect.fn("ClaudeSessionCode.writePatch")(function* (
  packageDir: string,
  relative: string,
  text: string,
) {
  if (text.length === 0) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(packageDir, relative), text);
  return yield* describeFile(packageDir, relative);
});

const nulSeparated = (text: string) => text.split("\0").filter((entry) => entry.length > 0);

/**
 * Stops the move when a submodule's content could not be reproduced on another machine: changed
 * inside, checked out away from what the superproject records, or at a commit no remote has.
 */
const checkSubmodules = Effect.fn("ClaudeSessionCode.checkSubmodules")(function* (root: string) {
  const path = yield* Path.Path;
  const status = yield* git(root, ["submodule", "status", "--recursive"]);
  for (const line of status.stdout.split("\n").filter((entry) => entry.length > 0)) {
    const prefix = line[0];
    const [sha, subPath] = line.slice(1).trim().split(/\s+/);
    if (sha === undefined || subPath === undefined || prefix === "-") continue;
    if (prefix === "+" || prefix === "U") {
      return yield* moveError(
        "submodule",
        `Submodule ${subPath} is checked out at a commit the repository does not record, so the other machine could not reproduce it. Commit or reset it first.`,
      );
    }
    const subRoot = path.join(root, subPath);
    const dirty = yield* git(subRoot, ["status", "--porcelain"]);
    if (dirty.stdout.trim().length > 0) {
      return yield* moveError(
        "submodule",
        `Submodule ${subPath} has changes a move does not carry. Commit and push them first.`,
      );
    }
    const onRemote = yield* git(subRoot, ["branch", "-r", "--contains", sha]);
    if (onRemote.stdout.trim().length === 0) {
      return yield* moveError(
        "submodule",
        `Submodule ${subPath} is at ${sha.slice(0, 12)}, which none of its remotes has. Push it first.`,
      );
    }
  }
});

/**
 * Stops the move when content it would carry is stored in Git LFS, which patches and bundles lack.
 */
const checkLfs = Effect.fn("ClaudeSessionCode.checkLfs")(function* (
  root: string,
  paths: ReadonlyArray<string>,
) {
  if (paths.length === 0) return;
  const attributes = yield* git(root, ["check-attr", "-z", "filter", "--", ...paths]);
  const fields = nulSeparated(attributes.stdout);
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index + 2] === "lfs") {
      return yield* moveError(
        "lfs",
        `${fields[index]} is stored in Git LFS, whose content a move cannot carry. Commit and push it, LFS objects included, first.`,
      );
    }
  }
});

/**
 * Packs the code `cwd` is in into `packageDir`: commits no remote has, staged and unstaged changes
 * and untracked files git does not ignore. A directory outside git packs nothing. Reads the
 * checkout only; it never changes it.
 */
export const captureClaudeSessionCode = Effect.fn("captureClaudeSessionCode")(
  function* (input: {
    readonly cwd: string | null;
    readonly packageDir: string;
    readonly canonicalKey: (root: string) => Effect.Effect<string | null>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const none = { kind: "none", cwd: input.cwd } satisfies ClaudeSessionCodePackage;
    if (input.cwd === null || !(yield* fileSystem.exists(input.cwd))) return none;
    const top = yield* git(input.cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (top.code !== 0) return none;
    const root = top.stdout.trim();
    const remotes = (yield* git(root, ["remote"])).stdout.split("\n").filter((name) => name !== "");
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    const canonicalKey = yield* input.canonicalKey(root);
    if (remote === undefined || canonicalKey === null) {
      return yield* moveError(
        "no_remote",
        "The repository has no remote, so the other machine could neither find nor clone it.",
      );
    }
    const remoteUrl = (yield* git(root, ["remote", "get-url", remote])).stdout.trim();
    yield* checkSubmodules(root);
    const head = (yield* git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const branchResult = yield* git(root, ["symbolic-ref", "--short", "-q", "HEAD"], {
      allowFailure: true,
    });
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;

    const unpushedFiles = nulSeparated(
      (yield* git(root, ["log", "-z", "--name-only", "--format=", "HEAD", "--not", "--remotes"]))
        .stdout,
    );
    const changedFiles = nulSeparated(
      (yield* git(root, ["diff", "-z", "--name-only", "HEAD"])).stdout,
    );
    const untrackedFiles = nulSeparated(
      (yield* git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).stdout,
    );
    yield* checkLfs(root, [...new Set([...unpushedFiles, ...changedFiles, ...untrackedFiles])]);

    yield* fileSystem.makeDirectory(input.packageDir, { recursive: true });
    const unpushed = Number(
      (yield* git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).stdout.trim(),
    );
    let bundle: ClaudeSessionFile | null = null;
    if (unpushed > 0) {
      yield* git(root, [
        "bundle",
        "create",
        path.join(input.packageDir, BUNDLE),
        "HEAD",
        "--not",
        "--remotes",
      ]);
      bundle = yield* describeFile(input.packageDir, BUNDLE);
    }
    const staged = yield* writePatch(
      input.packageDir,
      STAGED,
      (yield* git(root, ["diff", "--cached", "--binary"])).stdout,
    );
    const unstaged = yield* writePatch(
      input.packageDir,
      UNSTAGED,
      (yield* git(root, ["diff", "--binary"])).stdout,
    );
    const untracked: Array<ClaudeSessionCodeEntry> = [];
    for (const [index, relative] of untrackedFiles.entries()) {
      const source = path.join(root, relative);
      const link = yield* fileSystem.readLink(source).pipe(Effect.option);
      if (link._tag === "Some") {
        untracked.push({ kind: "symlink", path: relative, target: link.value });
        continue;
      }
      const packed = `${UNTRACKED_DIR}/${index}`;
      yield* fileSystem.makeDirectory(path.join(input.packageDir, UNTRACKED_DIR), {
        recursive: true,
      });
      yield* fileSystem.copyFile(source, path.join(input.packageDir, packed));
      untracked.push({
        kind: "file",
        path: relative,
        file: yield* describeFile(input.packageDir, packed),
      });
    }
    const relativeCwd = path.relative(root, yield* fileSystem.realPath(input.cwd));
    return {
      kind: "git",
      canonicalKey,
      remoteUrl,
      relativeCwd: relativeCwd.split(path.sep).join("/"),
      head,
      branch,
      bundle,
      staged,
      unstaged,
      untracked,
    } satisfies ClaudeSessionCodePackage;
  },
  Effect.mapError((cause) =>
    cause._tag === "ClaudeSessionMoveError"
      ? cause
      : moveError("storage", "The session's code could not be packed.", cause),
  ),
);

/** Every package file a target fetches, with where it goes in its own staging directory. */
export const claudeSessionCodeFiles = (code: ClaudeSessionCodePackage) =>
  code.kind === "none"
    ? []
    : [
        ...(code.bundle === null ? [] : [code.bundle]),
        ...(code.staged === null ? [] : [code.staged]),
        ...(code.unstaged === null ? [] : [code.unstaged]),
        ...code.untracked.flatMap((entry) => (entry.kind === "file" ? [entry.file] : [])),
      ];

const branchName = (branch: string | null, moveId: string) => {
  const tag = moveId.slice(0, 8);
  return branch === null ? `t3code/moved-${tag}` : `${branch}-moved-${tag}`;
};

/**
 * Recreates packed code in a new worktree of `checkout` at `worktreePath`, on a branch of its own,
 * and checks the staged and unstaged changes come out byte for byte. `staging` holds the fetched
 * package files. Only refs and objects are added to `checkout`; its working tree, index and
 * branches are left as they are. A worktree that fails part-way is removed.
 */
export const restoreClaudeSessionCode = Effect.fn("restoreClaudeSessionCode")(
  function* (input: {
    readonly code: Extract<ClaudeSessionCodePackage, { readonly kind: "git" }>;
    readonly checkout: string;
    readonly worktreePath: string;
    readonly staging: string;
    readonly moveId: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { code, checkout, worktreePath } = input;
    const staged = (relative: string) => path.join(input.staging, relative);
    // An unreachable remote is not fatal: the bundle or local objects may hold every commit, and
    // the presence check below stops the move with the reason when they do not.
    yield* git(checkout, ["fetch", "--quiet", "--all"], { allowFailure: true });
    const moveRef = `refs/t3code/moves/${input.moveId}`;
    if (code.bundle !== null) {
      yield* git(checkout, ["bundle", "verify", "--quiet", staged(code.bundle.path)]);
      yield* git(checkout, ["fetch", "--quiet", staged(code.bundle.path), `HEAD:${moveRef}`]);
    }
    const present = yield* git(checkout, ["cat-file", "-e", `${code.head}^{commit}`], {
      allowFailure: true,
    });
    if (present.code !== 0) {
      return yield* moveError(
        "git",
        `Commit ${code.head.slice(0, 12)} is on neither the remote nor the bundle the source sent.`,
      );
    }
    const taken =
      code.branch === null ||
      (yield* git(checkout, ["show-ref", "--verify", "--quiet", `refs/heads/${code.branch}`], {
        allowFailure: true,
      })).code === 0;
    const branch =
      code.branch !== null && !taken ? code.branch : branchName(code.branch, input.moveId);
    yield* fileSystem.makeDirectory(path.dirname(worktreePath), { recursive: true });
    yield* git(checkout, ["worktree", "add", "--quiet", "-b", branch, worktreePath, code.head]);
    const fill = Effect.gen(function* () {
      if (code.staged !== null) {
        yield* git(worktreePath, ["apply", "--index", "--binary", staged(code.staged.path)]);
      }
      if (code.unstaged !== null) {
        yield* git(worktreePath, ["apply", "--binary", staged(code.unstaged.path)]);
      }
      for (const entry of code.untracked) {
        const target = path.join(worktreePath, entry.path);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        if (entry.kind === "symlink") yield* fileSystem.symlink(entry.target, target);
        else yield* fileSystem.copyFile(staged(entry.file.path), target);
      }
      // The changes are recreated exactly when git describes them with the same bytes.
      for (const [patch, args] of [
        [code.staged, ["diff", "--cached", "--binary"]],
        [code.unstaged, ["diff", "--binary"]],
      ] as const) {
        const again = (yield* git(worktreePath, args)).stdout;
        const expected = patch === null ? "" : yield* fileSystem.readFileString(staged(patch.path));
        if (again !== expected) {
          return yield* moveError("git", "The changes did not come out the same on this machine.");
        }
      }
    });
    yield* fill.pipe(
      Effect.tapError(() =>
        git(checkout, ["worktree", "remove", "--force", worktreePath], { allowFailure: true }).pipe(
          Effect.andThen(git(checkout, ["branch", "-D", branch], { allowFailure: true })),
          Effect.ignore,
        ),
      ),
    );
    yield* git(checkout, ["update-ref", "-d", moveRef], { allowFailure: true });
    return {
      branch,
      cwd:
        code.relativeCwd === ""
          ? worktreePath
          : path.join(worktreePath, ...code.relativeCwd.split("/")),
    };
  },
  Effect.mapError((cause) =>
    cause._tag === "ClaudeSessionMoveError"
      ? cause
      : moveError("storage", "The session's code could not be recreated here.", cause),
  ),
);
