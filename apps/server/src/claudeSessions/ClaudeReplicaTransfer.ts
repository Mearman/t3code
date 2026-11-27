import {
  CLAUDE_SESSION_FILE_CHUNK_BYTES,
  type ClaudeSessionFile,
  ClaudeSessionReplicationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  claudeSessionFileAbsolutePath,
  type ClaudeSessionLayout,
  sha256OfFile,
} from "./ClaudeSessionFiles.ts";

/** What a replica's transcript was when it last matched the owner. */
export interface ClaudeReplicaSyncPoint {
  readonly size: number;
  readonly sha256: string;
}

/** The replica's transcript as it is on this machine now. */
export interface ClaudeLocalTranscript {
  readonly size: number;
  readonly sha256: string;
  /** Whether the owner's first `size` bytes hash to `sha256`: the copy only lacks later lines. */
  readonly prefixOfOwner: boolean;
  /** Whether its first `synced.size` bytes still hash to `synced.sha256`. */
  readonly keepsSyncedPrefix: boolean;
  /** Whether its own lines are already kept as a fork, so it may simply be replaced. */
  readonly alreadyKept: boolean;
}

/**
 * What to do with one session's replica. `fresh` and `fast-forward` copy the owner's transcript,
 * the latter starting from the local bytes it already has; `local-ahead` means Claude appended
 * here while the owner did not move, so ownership can follow; `diverged` means the copy holds
 * lines the owner lacks and the owner moved too, so those lines must become their own session;
 * `replace` is a diverged copy whose lines a fork already holds, so only the copy remains to do.
 */
export type ClaudeReplicaPlan =
  | { readonly kind: "current" }
  | { readonly kind: "fresh" }
  | { readonly kind: "fast-forward"; readonly seedBytes: number }
  | { readonly kind: "local-ahead" }
  | { readonly kind: "diverged" }
  | { readonly kind: "replace" };

export const planClaudeReplica = (input: {
  readonly local: ClaudeLocalTranscript | undefined;
  readonly synced: ClaudeReplicaSyncPoint | undefined;
  readonly owner: ClaudeReplicaSyncPoint;
}): ClaudeReplicaPlan => {
  const { local, synced, owner } = input;
  if (local === undefined) return { kind: "fresh" };
  if (local.size === owner.size && local.sha256 === owner.sha256) return { kind: "current" };
  if (local.prefixOfOwner) return { kind: "fast-forward", seedBytes: local.size };
  const ownerUnchanged =
    synced !== undefined && owner.size === synced.size && owner.sha256 === synced.sha256;
  if (ownerUnchanged && local.keepsSyncedPrefix) return { kind: "local-ahead" };
  return local.alreadyKept ? { kind: "replace" } : { kind: "diverged" };
};

/** Reads one owner's files; each chunk arrives checked against the hash the owner sent with it. */
export interface ClaudeReplicaSource {
  readonly readChunk: (input: {
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  }) => Effect.Effect<Uint8Array, ClaudeSessionReplicationError>;
}

/** One owner file and where its copy goes, both relative to their homes. */
export interface ClaudeReplicaFile {
  readonly file: ClaudeSessionFile;
  readonly target: string;
}

const storageError = (message: string) => (cause: unknown) =>
  new ClaudeSessionReplicationError({ reason: "storage", message, cause });

/**
 * Copies a manifest's files into a home, sidecars first and the transcript last. Bytes collect in
 * `<home>/.t3code-replicas/<sessionId>/`; a file moves into place by one rename once its hash
 * matches, so `claude --resume` never sees a half-written transcript, and a cut pass resumes.
 */
export const copyClaudeSessionFiles = Effect.fn("copyClaudeSessionFiles")(function* (input: {
  readonly source: ClaudeReplicaSource;
  readonly layout: ClaudeSessionLayout;
  readonly sessionId: string;
  /** Each file as the owner names it, and the path it takes below this home. */
  readonly transcript: ClaudeReplicaFile;
  readonly sidecars: ReadonlyArray<ClaudeReplicaFile>;
  /** The local transcript's first bytes to start from instead of fetching them. */
  readonly seedTranscriptBytes: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stagingRoot = path.join(input.layout.home, ".t3code-replicas", input.sessionId);
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.mapError(storageError(`Could not read ${target}.`)));
  const sizeOf = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.mapError(storageError(`Could not read ${target}.`)),
    );
  const hashOf = (target: string) =>
    sha256OfFile(target).pipe(
      Effect.catchTags({ PlatformError: storageError(`Could not read ${target}.`) }),
    );

  let fetchedBytes = 0;
  const staged: Array<{ readonly part: string; readonly target: string }> = [];
  const files = [...input.sidecars, input.transcript];
  for (const { file, target: targetPath } of files) {
    const target = claudeSessionFileAbsolutePath(path, input.layout, targetPath);
    if ((yield* exists(target)) && (yield* sizeOf(target)) === file.size) {
      if ((yield* hashOf(target)) === file.sha256) continue;
    }
    const part = path.join(stagingRoot, `${targetPath}.part`);
    const want = path.join(stagingRoot, `${targetPath}.want`);
    yield* fileSystem
      .makeDirectory(path.dirname(part), { recursive: true })
      .pipe(Effect.mapError(storageError(`Could not create ${path.dirname(part)}.`)));
    const wanted = yield* fileSystem.readFileString(want).pipe(Effect.option);
    if (Option.getOrUndefined(wanted) !== file.sha256) {
      yield* fileSystem.remove(part, { force: true }).pipe(Effect.orDie);
      yield* fileSystem
        .writeFileString(want, file.sha256)
        .pipe(Effect.mapError(storageError(`Could not write ${want}.`)));
    }
    if (!(yield* exists(part))) {
      const seed = file === input.transcript.file ? input.seedTranscriptBytes : 0;
      yield* fileSystem
        .writeFile(part, new Uint8Array())
        .pipe(Effect.mapError(storageError(`Could not write ${part}.`)));
      if (seed > 0) yield* appendPrefix(target, part, Math.min(seed, file.size));
    }
    let offset = yield* sizeOf(part);
    if (offset > file.size) {
      yield* fileSystem
        .truncate(part, 0)
        .pipe(Effect.mapError(storageError(`Could not reset ${part}.`)));
      offset = 0;
    }
    while (offset < file.size) {
      const length = Math.min(CLAUDE_SESSION_FILE_CHUNK_BYTES, file.size - offset);
      const bytes = yield* input.source.readChunk({ path: file.path, offset, length });
      if (bytes.byteLength !== length) {
        return yield* new ClaudeSessionReplicationError({
          reason: "verification",
          message: `${file.path} changed on its owner while it was copied.`,
        });
      }
      yield* fileSystem
        .writeFile(part, bytes, { flag: "a" })
        .pipe(Effect.mapError(storageError(`Could not write ${part}.`)));
      offset += length;
      fetchedBytes += length;
    }
    if ((yield* hashOf(part)) !== file.sha256) {
      // The staged bytes cannot become this file, so the next pass fetches it from the start.
      yield* fileSystem.remove(part, { force: true }).pipe(Effect.orDie);
      return yield* new ClaudeSessionReplicationError({
        reason: "verification",
        message: `${file.path} did not match its owner's copy once fetched.`,
      });
    }
    staged.push({ part, target });
  }

  for (const { part, target } of staged) {
    yield* fileSystem
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError(storageError(`Could not create ${path.dirname(target)}.`)));
    yield* fileSystem
      .rename(part, target)
      .pipe(Effect.mapError(storageError(`Could not move ${target} into place.`)));
  }
  yield* removeSidecarsNotIn(
    input.layout,
    input.sessionId,
    input.transcript.target,
    input.sidecars.map(({ target }) => target),
  );
  yield* fileSystem.remove(stagingRoot, { recursive: true, force: true }).pipe(Effect.orDie);
  return { fetchedBytes };
});

const appendPrefix = Effect.fn("appendPrefix")(function* (
  from: string,
  to: string,
  length: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fileSystem.open(from, { flag: "r" });
      let remaining = length;
      while (remaining > 0) {
        const chunk = yield* handle.readAlloc(Math.min(CLAUDE_SESSION_FILE_CHUNK_BYTES, remaining));
        if (Option.isNone(chunk)) return;
        yield* fileSystem.writeFile(to, chunk.value, { flag: "a" });
        remaining -= chunk.value.byteLength;
      }
    }),
  ).pipe(Effect.mapError(storageError(`Could not read ${from}.`)));
});

const removeSidecarsNotIn = Effect.fn("removeSidecarsNotIn")(function* (
  layout: ClaudeSessionLayout,
  sessionId: string,
  transcriptTarget: string,
  sidecarTargets: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const kept = new Set(sidecarTargets);
  const slugDir = transcriptTarget.split("/").slice(0, 2).join("/");
  for (const root of [
    `${slugDir}/${sessionId}`,
    `file-history/${sessionId}`,
    `tasks/${sessionId}`,
  ]) {
    const directory = claudeSessionFileAbsolutePath(path, layout, root);
    const entries = yield* fileSystem
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      const relative = `${root}/${entry.split(path.sep).join("/")}`;
      const absolute = path.join(directory, entry);
      const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File" && !kept.has(relative)) {
        yield* fileSystem
          .remove(absolute)
          .pipe(Effect.mapError(storageError(`Could not remove ${absolute}.`)));
      }
    }
  }
});
