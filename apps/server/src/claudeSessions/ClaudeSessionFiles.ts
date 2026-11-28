import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

/**
 * After a verified copy to another home, each original is replaced by a symlink to its copy, so
 * both homes resume one history. Claude Code 2.1.311 resumed a session through a symlinked
 * transcript and appended to the link's target, keeping the link (E12, run against a local API
 * stand-in). If a release stops doing that, set this to false: originals are then left in place.
 */
export const CLAUDE_MOVE_LINKS_ORIGINALS = true;

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
 * Every file of a session, relative to its home: the transcript, its sidecar directory
 * (`subagents`, `tool-results`, `mcp-tasks`) and its `file-history` and `tasks` directories.
 */
export const listClaudeSessionFiles = Effect.fn("ClaudeSessionFiles.list")(function* (
  home: string,
  projectDir: string,
  sessionId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = [path.join("projects", projectDir, `${sessionId}.jsonl`)];
  for (const directory of [
    path.join("projects", projectDir, sessionId),
    path.join("file-history", sessionId),
    path.join("tasks", sessionId),
  ]) {
    const absolute = path.join(home, directory);
    if (!(yield* fileSystem.exists(absolute))) continue;
    for (const entry of yield* fileSystem.readDirectory(absolute, { recursive: true })) {
      const relative = path.join(directory, entry);
      if ((yield* fileSystem.stat(path.join(home, relative))).type === "File") files.push(relative);
    }
  }
  return files.toSorted();
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptRecord));

// A compact summary is far smaller than this, so a boundary outside the tail has turns after it.
const COMPACTION_TAIL_BYTES = 1024 * 1024;

/** True when the transcript's last conversation turn is a compaction, with nothing after it. */
export const claudeTranscriptEndsCompacted = Effect.fn("ClaudeSessionFiles.endsCompacted")(
  function* (transcript: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const { size } = yield* fileSystem.stat(transcript);
    const start = size > COMPACTION_TAIL_BYTES ? size - BigInt(COMPACTION_TAIL_BYTES) : 0n;
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(transcript, { flag: "r" });
        yield* file.seek(start, "start");
        return yield* file.readAlloc(Number(size - start));
      }),
    );
    const text = bytes._tag === "Some" ? new TextDecoder().decode(bytes.value) : "";
    let compacted = false;
    // The first line of a tail may be cut mid-record, which simply fails to decode.
    for (const line of text.split("\n")) {
      const record = decodeRecord(line);
      if (record._tag === "None") continue;
      const { type, subtype, isMeta, isCompactSummary } = record.value;
      if (type === "system" && subtype === "compact_boundary") compacted = true;
      else if (type === "assistant" || (type === "user" && !isMeta && !isCompactSummary))
        compacted = false;
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

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Copies `files` from `source` to the same relative paths under `target`, verifies every copy byte
 * for byte, then (with `linkOriginals`) replaces each original with a symlink to its copy. A failed
 * check removes the copies this call made and replaces nothing.
 */
export const copyClaudeSession = Effect.fn("ClaudeSessionFiles.copy")(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly files: ReadonlyArray<string>;
  readonly linkOriginals: boolean;
  /** Corrupts a copy between writing and checking it; tests use it to prove the check. */
  readonly afterCopy?: (copy: string) => Effect.Effect<void, PlatformError.PlatformError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const created: Array<string> = [];
  const verify = Effect.gen(function* () {
    for (const relative of input.files) {
      const original = yield* fileSystem.readFile(path.join(input.source, relative));
      const copy = path.join(input.target, relative);
      if (yield* fileSystem.exists(copy)) {
        if (!sameBytes(original, yield* fileSystem.readFile(copy)))
          return yield* new ClaudeSessionTargetConflictError({ file: relative });
        continue;
      }
      yield* fileSystem.makeDirectory(path.dirname(copy), { recursive: true });
      yield* fileSystem.writeFile(copy, original);
      created.push(copy);
      if (input.afterCopy !== undefined) yield* input.afterCopy(copy);
      if (!sameBytes(original, yield* fileSystem.readFile(copy)))
        return yield* new ClaudeSessionCopyMismatchError({ file: relative });
    }
  });
  yield* verify.pipe(
    Effect.tapError(() =>
      Effect.forEach(created, (copy) => fileSystem.remove(copy), { discard: true }),
    ),
  );
  if (!input.linkOriginals) return;
  for (const relative of input.files) {
    const original = path.join(input.source, relative);
    const staged = `${original}.t3-move`;
    yield* fileSystem.symlink(path.join(input.target, relative), staged);
    yield* fileSystem.rename(staged, original);
  }
});
