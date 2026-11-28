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
import * as Option from "effect/Option";
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

/** Protocols a move may clone or fetch over; a peer-named `ext::` remote would run a command. */
const ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

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
      env: {
        ...environment,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS,
        LC_ALL: "C",
      },
    }),
    { maxStdoutBytes: 64 * 1024 * 1024 },
  ).pipe(
    Effect.mapError((cause) =>
      moveError(
        "git",
        cause._tag === "ProviderProbeOutputLimitError"
          ? `git ${args[0]} wrote more than a move reads, so it stopped.`
          : `git ${args[0]} could not run.`,
        cause,
      ),
    ),
  );
  if (result.code !== 0 && options?.allowFailure !== true) {
    return yield* moveError(
      "git",
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result;
});

/**
 * Writes the staged or unstaged changes as a binary patch straight to `file`, so their bytes are
 * never decoded. Every option a user's config could change is pinned, so two machines describing
 * the same changes write the same bytes.
 */
const diffTo = (cwd: string, staged: boolean, file: string) =>
  git(cwd, [
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    ...(staged ? ["--cached"] : []),
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--no-renames",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--inter-hunk-context=0",
    "-U3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `--output=${file}`,
  ]);

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

/** Packs the staged or unstaged changes as a package file, or nothing when there are none. */
const capturePatch = Effect.fn("ClaudeSessionCode.capturePatch")(function* (
  root: string,
  packageDir: string,
  relative: string,
  staged: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(packageDir, relative);
  yield* diffTo(root, staged, file);
  if (Number((yield* fileSystem.stat(file)).size) > 0)
    return yield* describeFile(packageDir, relative);
  yield* fileSystem.remove(file);
  return null;
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
    const staged = yield* capturePatch(root, input.packageDir, STAGED, true);
    const unstaged = yield* capturePatch(root, input.packageDir, UNSTAGED, false);
    const untracked: Array<ClaudeSessionCodeEntry> = [];
    for (const [index, relative] of untrackedFiles.entries()) {
      // git lists an untracked repository inside the checkout as its directory.
      if (relative.endsWith("/")) {
        return yield* moveError(
          "submodule",
          `${relative} is a repository inside this one that git does not track, so a move cannot carry it. Add it as a submodule or move it out first.`,
        );
      }
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
        executable: ((yield* fileSystem.stat(source)).mode & 0o111) !== 0,
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

/** Applies a patch as written, whatever `apply.whitespace` the checkout's config sets. */
const APPLY = ["apply", "--binary", "--whitespace=nowarn"];

/** A move id as `ClaudeSessionMove` mints it: 16 random bytes in hex. */
export const isClaudeMoveId = (moveId: string) => /^[0-9a-f]{32}$/.test(moveId);

const PACKAGE_FILE = /^(bundle|staged\.patch|unstaged\.patch|untracked\/\d+)$/;

/** A relative path of plain segments that never enters a `.git` directory. */
const isPlainRelativePath = (relative: string) =>
  relative
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        segment.toLowerCase() !== ".git",
    );

/** A remote git reads as a URL or path, never as an option or a `<helper>::` transport. */
const isCloneableRemote = (url: string) => !url.startsWith("-") && !url.includes("::");

/**
 * Checks everything a source sent before the target acts on it: the move id, the commit, the
 * remote, the session directory and every package file and untracked path, which must stay below
 * the staging directory and the new worktree.
 */
export const checkClaudeSessionCodePackage = Effect.fn("checkClaudeSessionCodePackage")(
  function* (input: {
    readonly code: Extract<ClaudeSessionCodePackage, { readonly kind: "git" }>;
    readonly moveId: string;
  }) {
    const { code } = input;
    const refuse = (what: string) =>
      moveError("refused", `The source sent ${what}, so nothing was changed here.`);
    if (!isClaudeMoveId(input.moveId)) return yield* refuse("a move id that is not one");
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(code.head))
      return yield* refuse("a commit that is not one");
    if (!isCloneableRemote(code.remoteUrl)) {
      return yield* refuse(`a remote this machine does not clone (${code.remoteUrl.slice(0, 80)})`);
    }
    if (code.relativeCwd !== "" && !isPlainRelativePath(code.relativeCwd)) {
      return yield* refuse(`a directory outside the repository (${code.relativeCwd})`);
    }
    if (code.branch !== null) {
      const valid = yield* git(".", ["check-ref-format", "--branch", code.branch], {
        allowFailure: true,
      });
      if (valid.code !== 0 || code.branch.startsWith("-")) {
        return yield* refuse(`a branch name git does not accept (${code.branch.slice(0, 80)})`);
      }
    }
    const files = claudeSessionCodeFiles(code).map((file) => file.path);
    const expected = [
      ...(code.bundle === null ? [] : [[code.bundle.path, BUNDLE]]),
      ...(code.staged === null ? [] : [[code.staged.path, STAGED]]),
      ...(code.unstaged === null ? [] : [[code.unstaged.path, UNSTAGED]]),
    ];
    if (
      expected.some(([actual, name]) => actual !== name) ||
      files.some((file) => !PACKAGE_FILE.test(file)) ||
      new Set(files).size !== files.length
    ) {
      return yield* refuse("a package file outside its package");
    }
    const paths = code.untracked.map((entry) => entry.path);
    const bad = paths.find((relative) => !isPlainRelativePath(relative));
    if (bad !== undefined) return yield* refuse(`an untracked path outside the worktree (${bad})`);
    if (new Set(paths).size !== paths.length) return yield* refuse("an untracked path twice");
  },
);

/**
 * Creates `relative`'s directories below `root` one at a time, refusing a symbolic link or file on
 * the way, so nothing written below them can land outside `root`.
 */
const directoryInside = Effect.fn("ClaudeSessionCode.directoryInside")(function* (
  root: string,
  relative: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = root;
  for (const segment of relative === "" ? [] : relative.split("/")) {
    current = path.join(current, segment);
    if (Option.isSome(yield* fileSystem.readLink(current).pipe(Effect.option))) {
      return yield* moveError(
        "refused",
        `${current} is a symbolic link, so nothing is written through it.`,
      );
    }
    if (!(yield* fileSystem.exists(current))) yield* fileSystem.makeDirectory(current);
    else if ((yield* fileSystem.stat(current)).type !== "Directory") {
      return yield* moveError("refused", `${current} is not a directory.`);
    }
  }
  return current;
});

/** Whether two files hold the same bytes. */
const sameBytes = Effect.fn("ClaudeSessionCode.sameBytes")(function* (a: string, b: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const [left, right] = [yield* fileSystem.readFile(a), yield* fileSystem.readFile(b)];
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
});

/**
 * Recreates packed code in a new worktree of `checkout` at `worktreePath`, on a branch of its own,
 * and checks the staged and unstaged changes come out byte for byte. `staging` holds the fetched
 * package files. Only objects and the new branch are added to `checkout`; its working tree, index,
 * branches and remote-tracking refs are left as they are. A worktree that fails part-way is removed.
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
    yield* checkClaudeSessionCodePackage({ code, moveId: input.moveId });
    const staged = (relative: string) => path.join(input.staging, relative);
    // Fetched commits land below this namespace only, never in the checkout's own refs.
    const moveRefs = `refs/t3code/moves/${input.moveId}`;
    const dropMoveRefs = Effect.gen(function* () {
      const refs = yield* git(checkout, ["for-each-ref", "--format=%(refname)", moveRefs]);
      for (const ref of refs.stdout.split("\n").filter((name) => name !== "")) {
        yield* git(checkout, ["update-ref", "-d", ref]);
      }
    }).pipe(Effect.ignore);
    const commitHere = Effect.map(
      git(checkout, ["cat-file", "-e", `${code.head}^{commit}`], { allowFailure: true }),
      (result) => result.code === 0,
    );
    const restore = Effect.gen(function* () {
      if (code.bundle !== null) {
        yield* git(checkout, ["bundle", "verify", "--quiet", staged(code.bundle.path)]);
        yield* git(checkout, [
          "fetch",
          "--quiet",
          "--no-write-fetch-head",
          staged(code.bundle.path),
          `HEAD:${moveRefs}/bundle`,
        ]);
      }
      if (!(yield* commitHere)) {
        // An unreachable remote is not fatal yet: the check below names what is missing.
        yield* git(
          checkout,
          [
            "-c",
            "fetch.recurseSubmodules=false",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--refmap=",
            "--",
            code.remoteUrl,
            `+refs/heads/*:${moveRefs}/remote/*`,
          ],
          { allowFailure: true },
        );
      }
      if (!(yield* commitHere)) {
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
          yield* git(worktreePath, [...APPLY, "--index", staged(code.staged.path)]);
        }
        if (code.unstaged !== null) {
          yield* git(worktreePath, [...APPLY, staged(code.unstaged.path)]);
        }
        for (const entry of code.untracked) {
          const segments = entry.path.split("/");
          const directory = yield* directoryInside(worktreePath, segments.slice(0, -1).join("/"));
          const target = path.join(directory, segments.at(-1) ?? entry.path);
          if (
            (yield* fileSystem.exists(target)) ||
            Option.isSome(yield* fileSystem.readLink(target).pipe(Effect.option))
          ) {
            return yield* moveError("refused", `${entry.path} is already in the new worktree.`);
          }
          if (entry.kind === "symlink") {
            yield* fileSystem.symlink(entry.target, target);
            continue;
          }
          yield* fileSystem.copyFile(staged(entry.file.path), target);
          yield* fileSystem.chmod(target, entry.executable ? 0o755 : 0o644);
        }
        // The changes are recreated exactly when git describes them with the same bytes.
        for (const [patch, cached, again] of [
          [code.staged, true, "staged.again"],
          [code.unstaged, false, "unstaged.again"],
        ] as const) {
          yield* diffTo(worktreePath, cached, staged(again));
          const same =
            patch === null
              ? Number((yield* fileSystem.stat(staged(again))).size) === 0
              : yield* sameBytes(staged(again), staged(patch.path));
          if (!same) {
            return yield* moveError(
              "git",
              "The changes did not come out the same on this machine.",
            );
          }
        }
      });
      yield* fill.pipe(
        Effect.tapError(() =>
          git(checkout, ["worktree", "remove", "--force", worktreePath], {
            allowFailure: true,
          }).pipe(
            Effect.andThen(git(checkout, ["branch", "-D", branch], { allowFailure: true })),
            Effect.ignore,
          ),
        ),
      );
      return branch;
    });
    const branch = yield* restore.pipe(Effect.ensuring(dropMoveRefs));
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
