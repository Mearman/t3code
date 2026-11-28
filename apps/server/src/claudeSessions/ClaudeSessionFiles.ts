import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * Whether a moved part in the old home becomes a symlink to its copy, so both homes resume one
 * history (Claude Code 2.1.311 resumed and appended through a linked transcript, E12). When false
 * the old parts are renamed aside (`.t3-moved`), so neither home keeps a copy that could fork.
 */
export const CLAUDE_MOVE_LINKS_ORIGINALS = true;

/** Whether a host can link a moved session's files: Windows grants links only with elevation. */
export const canLinkClaudeSessionFiles = (platform: NodeJS.Platform) => platform !== "win32";

/** Where a session's transcript lives in a Claude home: `projects/<projectDir>/<id>.jsonl`. */
export const locateClaudeTranscript = Effect.fn("ClaudeSessionFiles.locateTranscript")(function* (
  home: string,
  sessionId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = path.join(home, "projects");
  if (!(yield* fileSystem.exists(projects))) return undefined;
  for (const projectDir of yield* fileSystem.readDirectory(projects)) {
    if (yield* fileSystem.exists(path.join(projects, projectDir, `${sessionId}.jsonl`)))
      return projectDir;
  }
  return undefined;
});

/**
 * The parts of a session that move as one, relative to its home: the transcript, its sidecar
 * directory (`subagents`, `tool-results`, `mcp-tasks`) and its `file-history` and `tasks`
 * directories. Directories move whole, so files Claude writes into them later follow the link.
 */
export const listClaudeSessionParts = Effect.fn("ClaudeSessionFiles.listParts")(function* (
  home: string,
  projectDir: string,
  sessionId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parts = [path.join("projects", projectDir, `${sessionId}.jsonl`)];
  for (const directory of [
    path.join("projects", projectDir, sessionId),
    path.join("file-history", sessionId),
    path.join("tasks", sessionId),
  ]) {
    if (yield* fileSystem.exists(path.join(home, directory))) parts.push(directory);
  }
  return parts;
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.Unknown),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));

// A compact summary is far smaller than this, so a boundary outside the tail has turns after it.
const COMPACTION_TAIL_BYTES = 1024 * 1024;
// Claude Code records the `/compact` command itself and its output as user messages tagged so.
const LOCAL_COMMAND_RECORD =
  /^\s*<(?:command-name|command-message|command-args|local-command-[a-z]+)>/u;

const messageText = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    )
      return block.text;
  }
  return undefined;
};

/**
 * True when the transcript's last conversation turn is a compaction, with nothing after it. The
 * compaction's own command records and meta records after the summary are not conversation.
 */
export const claudeTranscriptEndsCompacted = Effect.fn("ClaudeSessionFiles.endsCompacted")(
  function* (transcript: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const { size } = yield* fileSystem.stat(transcript);
    const start = size > COMPACTION_TAIL_BYTES ? size - BigInt(COMPACTION_TAIL_BYTES) : 0n;
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(transcript, { flag: "r" });
        yield* file.seek(start, "start");
        return yield* readFully(file, Number(size - start));
      }),
    );
    const text = new TextDecoder().decode(bytes);
    let compacted = false;
    // The first line of a tail may be cut mid-record, which simply fails to decode.
    for (const line of text.split("\n")) {
      const record = decodeRecord(line);
      if (Option.isNone(record)) continue;
      const { type, subtype, isMeta, isCompactSummary, message } = record.value;
      if (type === "system" && subtype === "compact_boundary") compacted = true;
      else if (type === "assistant") compacted = false;
      else if (type === "user" && isMeta !== true && isCompactSummary !== true) {
        const body = messageText(message);
        if (body === undefined || !LOCAL_COMMAND_RECORD.test(body)) compacted = false;
      }
    }
    return compacted;
  },
);

/** The copy at the target differed from the original, so nothing was replaced. */
export class ClaudeSessionCopyMismatchError extends Schema.TaggedError<ClaudeSessionCopyMismatchError>()(
  "ClaudeSessionCopyMismatchError",
  { file: Schema.String },
) {
  override get message(): string {
    return `The copy of ${this.file} did not match the original, so the session was not moved.`;
  }
}

/** The target home already holds a different file at a session path. */
export class ClaudeSessionTargetConflictError extends Schema.TaggedError<ClaudeSessionTargetConflictError>()(
  "ClaudeSessionTargetConflictError",
  { file: Schema.String },
) {
  override get message(): string {
    return `The other account already has a different ${this.file}, so the session was not moved.`;
  }
}

/** Undoing a part-way move failed, so the old home may hold links to the new one. */
export class ClaudeSessionRollbackError extends Schema.TaggedError<ClaudeSessionRollbackError>()(
  "ClaudeSessionRollbackError",
  { part: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return (
      `The move stopped part-way and ${this.part} could not be put back; ` +
      "check both Claude folders before resuming the session."
    );
  }
}

// Files are compared and copied in pieces of this size, never read whole.
const COMPARE_CHUNK_BYTES = 1024 * 1024;

/** Reads up to `length` bytes, fewer only at the end of the file; one read may return less. */
const readFully = Effect.fnUntraced(function* (file: FileSystem.File, length: number) {
  const pieces: Array<Uint8Array> = [];
  let read = 0;
  while (read < length) {
    const piece = yield* file.readAlloc(length - read);
    if (Option.isNone(piece) || piece.value.length === 0) break;
    pieces.push(piece.value);
    read += piece.value.length;
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return bytes;
});

const sameContents = Effect.fn("ClaudeSessionFiles.sameContents")(function* (
  left: string,
  right: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if ((yield* fileSystem.stat(left)).size !== (yield* fileSystem.stat(right)).size) return false;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const a = yield* fileSystem.open(left, { flag: "r" });
      const b = yield* fileSystem.open(right, { flag: "r" });
      while (true) {
        const x = yield* readFully(a, COMPARE_CHUNK_BYTES);
        const y = yield* readFully(b, COMPARE_CHUNK_BYTES);
        if (x.length !== y.length) return false;
        if (x.length === 0) return true;
        for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return false;
      }
    }),
  );
});

/** What a move did to the files, so the caller can keep it or put it all back. */
export interface ClaudeSessionMoved {
  /** Whether any part was copied, rather than already shared with the target. */
  readonly copied: boolean;
  /** Keeps the move: removes the set-aside originals. */
  readonly commit: Effect.Effect<void>;
  /** Puts every original back and removes every copy this move made. */
  readonly undo: Effect.Effect<void, ClaudeSessionRollbackError>;
}

/**
 * Copies `parts` from `source` to `target`, verifies every file, then links (or sets aside) each
 * original. A part whose two paths already resolve to one file stays, so a move back never replaces
 * the only copy. A failure or interruption puts everything back, or fails with a rollback error.
 */
export const moveClaudeSessionParts = Effect.fn("ClaudeSessionFiles.moveParts")(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly parts: ReadonlyArray<string>;
  readonly linkOriginals: boolean;
  /** Runs after each file is copied, before it is checked; tests corrupt or fail with it. */
  readonly afterCopy?: (copy: string) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Runs after each original is set aside and before its link is made; tests fail it. */
  readonly afterSetAside?: (part: string) => Effect.Effect<void, PlatformError.PlatformError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realPath = (file: string) =>
    fileSystem.realPath(file).pipe(Effect.asSome, Effect.orElseSucceed(Option.none));
  const createdFiles: Array<string> = [];
  const createdParts: Array<string> = [];
  const replaced: Array<{
    readonly part: string;
    readonly original: string;
    readonly aside: string;
    linked: boolean;
  }> = [];
  const moving: Array<string> = [];

  // Records the outermost directory it creates, so undoing removes every directory the move made.
  const makeDirectories = Effect.fnUntraced(function* (directory: string) {
    let outermost: string | undefined;
    for (let current = directory; !(yield* fileSystem.exists(current));) {
      outermost = current;
      current = path.dirname(current);
    }
    if (outermost === undefined) return;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    createdParts.push(outermost);
  });
  const removeCopies = Effect.gen(function* () {
    for (const file of createdFiles.toReversed()) yield* fileSystem.remove(file);
    for (const part of createdParts.toReversed())
      yield* fileSystem.remove(part, { recursive: true });
  });
  const putBack = Effect.gen(function* () {
    for (const { part, original, aside, linked } of replaced.toReversed()) {
      yield* Effect.gen(function* () {
        // A part whose link failed has nothing at its own path yet.
        if (linked) yield* fileSystem.remove(original);
        yield* fileSystem.rename(aside, original);
      }).pipe(Effect.mapError((cause) => new ClaudeSessionRollbackError({ part, cause })));
    }
    yield* removeCopies.pipe(
      Effect.mapError((cause) => new ClaudeSessionRollbackError({ part: "a copy", cause })),
    );
  });

  const copyAndReplace = Effect.gen(function* () {
    for (const part of input.parts) {
      const original = path.join(input.source, part);
      const copy = path.join(input.target, part);
      const [from, to] = [yield* realPath(original), yield* realPath(copy)];
      if (Option.isSome(from) && Option.isSome(to) && from.value === to.value) continue;
      moving.push(part);
      const isDirectory = (yield* fileSystem.stat(original)).type === "Directory";
      const files = isDirectory
        ? (yield* fileSystem.readDirectory(original, { recursive: true })).map((entry) =>
            path.join(part, entry),
          )
        : [part];
      if (isDirectory) yield* makeDirectories(copy);
      for (const relative of files) {
        const fromFile = path.join(input.source, relative);
        if ((yield* fileSystem.stat(fromFile)).type !== "File") continue;
        const toFile = path.join(input.target, relative);
        if (yield* fileSystem.exists(toFile)) {
          if (!(yield* sameContents(fromFile, toFile)))
            return yield* new ClaudeSessionTargetConflictError({ file: relative });
          continue;
        }
        yield* makeDirectories(path.dirname(toFile));
        yield* fileSystem.copyFile(fromFile, toFile);
        if (!createdParts.some((created) => toFile.startsWith(`${created}${path.sep}`)))
          createdFiles.push(toFile);
        if (input.afterCopy !== undefined) yield* input.afterCopy(toFile);
        if (!(yield* sameContents(fromFile, toFile)))
          return yield* new ClaudeSessionCopyMismatchError({ file: relative });
      }
    }
    for (const part of moving) {
      const original = path.join(input.source, part);
      const aside = `${original}.${input.linkOriginals ? "t3-move-original" : "t3-moved"}`;
      yield* fileSystem.rename(original, aside);
      const entry = { part, original, aside, linked: false };
      replaced.push(entry);
      if (input.afterSetAside !== undefined) yield* input.afterSetAside(part);
      if (input.linkOriginals) {
        yield* fileSystem.symlink(path.join(input.target, part), original);
        entry.linked = true;
      }
    }
  });

  // Uninterruptible, so a cut-off request finishes or undoes its step instead of stopping part-way.
  const exit = yield* Effect.exit(Effect.uninterruptible(copyAndReplace));
  if (Exit.isFailure(exit)) {
    yield* Effect.uninterruptible(putBack);
    return yield* Effect.failCause(exit.cause);
  }
  return {
    copied: moving.length > 0,
    // The links already work, so a leftover original costs only space; it is logged, not undone.
    commit: input.linkOriginals
      ? Effect.forEach(replaced, ({ aside }) => fileSystem.remove(aside, { recursive: true }), {
          discard: true,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude-account-move.remove-originals-failed", { cause }),
          ),
        )
      : Effect.void,
    undo: Effect.uninterruptible(putBack),
  } satisfies ClaudeSessionMoved;
});
