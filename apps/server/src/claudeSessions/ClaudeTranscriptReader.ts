// A synchronous digest of bytes already in memory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ClaudeTranscriptParserState,
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptLine,
  type ClaudeTranscriptLineError,
} from "./ClaudeTranscriptSegments.ts";

// Claude Code names a session's transcript after its id; renamed copies such as `<id>.jsonl.superseded-<ms>` or `.orphaned` are archives, not sessions.
const TRANSCRIPT_FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session id a transcript file name carries, or undefined for any other file. */
export function claudeTranscriptSessionId(fileName: string): string | undefined {
  return TRANSCRIPT_FILE_NAME.exec(fileName)?.[1];
}

/**
 * Where the next read of one transcript resumes. `guardHash` digests the last line consumed, which carries its record's uuid, so the read restarts when that line changed, the file is shorter, or `fileId` shows it is another file.
 */
export const ClaudeTranscriptCursor = Schema.Struct({
  offset: Schema.Number,
  lastLineOffset: Schema.Number,
  guardHash: Schema.String,
  fileId: Schema.NullOr(Schema.String),
  state: ClaudeTranscriptParserState,
});
export type ClaudeTranscriptCursor = typeof ClaudeTranscriptCursor.Type;

export const initialClaudeTranscriptCursor: ClaudeTranscriptCursor = {
  offset: 0,
  lastLineOffset: 0,
  guardHash: "",
  fileId: null,
  state: initialClaudeTranscriptParserState,
};

const READ_CHUNK_BYTES = 256 * 1024;
// A line can be many MiB; the guard digests its length, its first and its last bytes, which hold the record's type and, after the message, its uuid and timestamp.
const GUARD_SPAN_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

function lineGuard(length: number, head: Uint8Array, tail: Uint8Array): string {
  return NodeCrypto.createHash("sha256")
    .update(`${length}:`)
    .update(head)
    .update(tail)
    .digest("hex");
}

// The parts of a line `lineGuard` reads: all of a short line, or its two ends.
function guardSpans(length: number) {
  return length <= 2 * GUARD_SPAN_BYTES
    ? { headLength: length, tailStart: length }
    : { headLength: GUARD_SPAN_BYTES, tailStart: length - GUARD_SPAN_BYTES };
}

function guardOfLine(line: Uint8Array): string {
  const { headLength, tailStart } = guardSpans(line.length);
  return lineGuard(line.length, line.subarray(0, headLength), line.subarray(tailStart));
}

function concatenate(chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array {
  const only = chunks[0];
  if (chunks.length === 1 && only !== undefined) return only;
  const joined = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

export interface ClaudeTranscriptRead {
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  /** Lines stepped past because they could not be understood, with their byte offsets. */
  readonly malformed: ReadonlyArray<ClaudeTranscriptLineError>;
  readonly cursor: ClaudeTranscriptCursor;
  /** The read restarted from the top; earlier events come again with the same ids. */
  readonly rewritten: boolean;
  /** Every complete line has been read; an unterminated last line waits for its newline. */
  readonly atEnd: boolean;
}

/**
 * Reads complete lines after `cursor` and parses them. Stops at the end of the file or once at least `maxBytes` have been consumed; a last line without its newline is left for the next read. A read that fails leaves the caller's cursor where it was.
 */
export const readClaudeTranscript = Effect.fn("readClaudeTranscript")(function* (input: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly cursor: ClaudeTranscriptCursor;
  readonly maxBytes: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const handle = yield* fileSystem.open(input.filePath, { flag: "r" });
  const info = yield* handle.stat;
  const size = Number(info.size);
  const fileId = `${info.dev}:${Option.getOrUndefined(info.ino)}`;

  const readAt = Effect.fnUntraced(function* (offset: number, length: number) {
    if (length === 0) return new Uint8Array(0);
    yield* handle.seek(BigInt(offset), "start");
    const bytes = yield* handle.readAlloc(length);
    return Option.isSome(bytes) ? bytes.value : new Uint8Array(0);
  });
  const guardOnDisk = Effect.fnUntraced(function* (cursor: ClaudeTranscriptCursor) {
    const length = cursor.offset - cursor.lastLineOffset;
    const { headLength, tailStart } = guardSpans(length);
    const head = yield* readAt(cursor.lastLineOffset, headLength);
    const tail = yield* readAt(cursor.lastLineOffset + tailStart, length - tailStart);
    return lineGuard(length, head, tail);
  });

  const resumes =
    input.cursor.offset === 0 ||
    (input.cursor.fileId === fileId &&
      input.cursor.offset <= size &&
      (yield* guardOnDisk(input.cursor)) === input.cursor.guardHash);
  const start = resumes ? input.cursor : initialClaudeTranscriptCursor;

  const decoder = new TextDecoder();
  const lines: Array<ClaudeTranscriptLine> = [];
  let offset = start.offset;
  let lastLineOffset = start.lastLineOffset;
  let guardHash = start.guardHash;
  // The unterminated end of the last chunk, kept as pieces so a long line is copied once.
  let pending: Array<Uint8Array> = [];
  let pendingLength = 0;
  let atEnd = false;
  yield* handle.seek(BigInt(offset), "start");
  while (offset - start.offset < input.maxBytes) {
    const chunk = yield* handle.readAlloc(READ_CHUNK_BYTES);
    if (Option.isNone(chunk)) {
      atEnd = true;
      break;
    }
    const bytes = chunk.value;
    let lineStart = 0;
    let newline = bytes.indexOf(NEWLINE);
    while (newline !== -1) {
      const piece = bytes.subarray(lineStart, newline + 1);
      const line = concatenate([...pending, piece], pendingLength + piece.length);
      pending = [];
      pendingLength = 0;
      lines.push({ text: decoder.decode(line.subarray(0, line.length - 1)), offset });
      lastLineOffset = offset;
      offset += line.length;
      guardHash = guardOfLine(line);
      lineStart = newline + 1;
      newline = bytes.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < bytes.length) {
      pending.push(bytes.subarray(lineStart));
      pendingLength += bytes.length - lineStart;
    }
  }

  const parsed = parseClaudeTranscriptLines({
    sessionId: input.sessionId,
    state: start.state,
    lines,
  });
  const read: ClaudeTranscriptRead = {
    events: parsed.events,
    malformed: parsed.malformed,
    cursor: { offset, lastLineOffset, guardHash, fileId, state: parsed.state },
    rewritten: !resumes,
    atEnd,
  };
  return read;
}, Effect.scoped);
