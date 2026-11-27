// @effect-diagnostics nodeBuiltinImport:off - node:crypto hashes session files for verified copies.
import * as NodeCrypto from "node:crypto";

import { type ClaudeSessionFile, ClaudeSessionReplicationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Claude Code names project directories after the cwd; longer names are cut and suffixed. */
const MAX_SLUG_LENGTH = 200;
const HASH_CHUNK_BYTES = 1024 * 1024;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The directory below `projects/` Claude Code keeps a cwd's sessions in (SDK `rd`, 0.3.321). */
export const claudeProjectSlug = (cwd: string): string => {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  }
  return `${slug.slice(0, MAX_SLUG_LENGTH)}-${Math.abs(hash).toString(36)}`;
};

export const isClaudeSessionId = (sessionId: string) => SESSION_ID_PATTERN.test(sessionId);

/** Where a store's session files live: its `projects/` and the home beside it. */
export interface ClaudeSessionLayout {
  readonly projectsDir: string;
  readonly home: string;
}

const isPlainSegment = (segment: string) =>
  segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\");

/**
 * Whether `relativePath` names one of `sessionId`'s files and nothing else in a home: its
 * transcript, a file below its sidecar directory, or below its `file-history/` or `tasks/` entry.
 */
export const isClaudeSessionFilePath = (sessionId: string, relativePath: string): boolean => {
  if (!isClaudeSessionId(sessionId)) return false;
  const segments = relativePath.split("/");
  if (!segments.every(isPlainSegment)) return false;
  const [root, second, third, ...rest] = segments;
  if (root === "projects") {
    if (second === undefined || third === undefined) return false;
    return rest.length === 0 ? third === `${sessionId}.jsonl` : third === sessionId;
  }
  if (root === "file-history" || root === "tasks") {
    return second === sessionId && third !== undefined;
  }
  return false;
};

/** The absolute path of a session file named by `isClaudeSessionFilePath`. */
export const claudeSessionFileAbsolutePath = (
  path: Path.Path,
  layout: ClaudeSessionLayout,
  relativePath: string,
) => {
  const [root, ...rest] = relativePath.split("/");
  return root === "projects"
    ? path.join(layout.projectsDir, ...rest)
    : path.join(layout.home, relativePath);
};

/** SHA-256 of the first `length` bytes of a file, or of all of it. */
export const sha256OfFile = Effect.fn("sha256OfFile")(function* (
  filePath: string,
  length?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash("sha256");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(filePath, { flag: "r" });
      let remaining = length ?? Number.POSITIVE_INFINITY;
      while (remaining > 0) {
        const chunk = yield* handle.readAlloc(Math.min(HASH_CHUNK_BYTES, remaining));
        if (Option.isNone(chunk)) break;
        hash.update(chunk.value);
        remaining -= chunk.value.byteLength;
      }
      if (length !== undefined && remaining > 0) {
        return yield* new ClaudeSessionReplicationError({
          reason: "verification",
          message: `${filePath} is shorter than the ${length} bytes to hash.`,
        });
      }
    }),
  );
  return hash.digest("hex");
});

export const sha256OfBytes = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Regular files below `directory`, as paths relative to it; none when it does not exist. */
const regularFilesBelow = Effect.fn("regularFilesBelow")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(directory, { recursive: true })
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));
  const files: Array<{ readonly relative: string; readonly size: number }> = [];
  for (const entry of entries) {
    const info = yield* fileSystem.stat(path.join(directory, entry));
    // A symlink is followed by stat, so a link out of the session is checked when it is served.
    if (info.type === "File") files.push({ relative: entry, size: Number(info.size) });
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
});

/**
 * Every file of a session: its transcript first, then its sidecars, each with its size and hash as
 * read now. `transcriptPath` is the transcript's absolute path below `layout.projectsDir`.
 */
export const listClaudeSessionFiles = Effect.fn("listClaudeSessionFiles")(function* (input: {
  readonly layout: ClaudeSessionLayout;
  readonly sessionId: string;
  readonly transcriptPath: string;
}) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const slug = path.basename(path.dirname(input.transcriptPath));
  const describe = Effect.fnUntraced(function* (relativePath: string) {
    const absolute = claudeSessionFileAbsolutePath(path, input.layout, relativePath);
    const info = yield* fileSystem.stat(absolute);
    const size = Number(info.size);
    const sha256 = yield* sha256OfFile(absolute, size);
    return { path: relativePath, size, sha256 } satisfies ClaudeSessionFile;
  });
  const transcript = yield* describe(`projects/${slug}/${input.sessionId}.jsonl`);
  const sidecars: Array<ClaudeSessionFile> = [];
  for (const root of [
    `projects/${slug}/${input.sessionId}`,
    `file-history/${input.sessionId}`,
    `tasks/${input.sessionId}`,
  ]) {
    const directory = claudeSessionFileAbsolutePath(path, input.layout, root);
    for (const file of yield* regularFilesBelow(directory)) {
      const relativePath = `${root}/${file.relative.split(path.sep).join("/")}`;
      if (isClaudeSessionFilePath(input.sessionId, relativePath)) {
        sidecars.push(yield* describe(relativePath));
      }
    }
  }
  return { transcript, sidecars };
});

/**
 * The real path of a session file a linked environment asked for, or undefined when the path is
 * not one of the session's files or resolves (through a symlink) outside its directory.
 * `transcriptPath` is the session's transcript, which fixes its project directory.
 */
export const resolveServedClaudeSessionFile = Effect.fn("resolveServedClaudeSessionFile")(
  function* (input: {
    readonly layout: ClaudeSessionLayout;
    readonly sessionId: string;
    readonly transcriptPath: string;
    readonly relativePath: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const segments = input.relativePath.split("/");
    const slug = path.basename(path.dirname(input.transcriptPath));
    if (!isClaudeSessionFilePath(input.sessionId, input.relativePath)) return undefined;
    if (segments[0] === "projects" && segments[1] !== slug) return undefined;
    const root = claudeSessionFileAbsolutePath(path, input.layout, segments.slice(0, 2).join("/"));
    const absolute = claudeSessionFileAbsolutePath(path, input.layout, input.relativePath);
    const realRoot = yield* fileSystem.realPath(root).pipe(Effect.option);
    const realFile = yield* fileSystem.realPath(absolute).pipe(Effect.option);
    if (Option.isNone(realRoot) || Option.isNone(realFile)) return undefined;
    // The transcript is the root itself's child; every sidecar sits below the session's directory.
    return realFile.value.startsWith(`${realRoot.value}${path.sep}`) ? realFile.value : undefined;
  },
);

/** Whether copying `neededBytes` leaves at least `reserveGiB` free of `freeBytes`. */
export const claudeReplicaFitsReserve = (input: {
  readonly freeBytes: number;
  readonly neededBytes: number;
  readonly reserveGiB: number;
}) => input.freeBytes - input.neededBytes >= input.reserveGiB * 1024 ** 3;
