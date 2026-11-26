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
 * Where the next read of one transcript resumes. `headHash` digests the file's first bytes and
 * `tailHash` the bytes just before `offset`, up to `GUARD_WINDOW_BYTES` each; the read restarts
 * from the top when either differs, the file is shorter, or `fileId` shows it is another file.
 * A same-length rewrite confined to bytes between the two windows is not detected.
 */
export const ClaudeTranscriptCursor = Schema.Struct({
  offset: Schema.Number,
  headHash: Schema.String,
  tailHash: Schema.String,
  fileId: Schema.NullOr(Schema.String),
  state: ClaudeTranscriptParserState,
});
export type ClaudeTranscriptCursor = typeof ClaudeTranscriptCursor.Type;

const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const EMPTY: Uint8Array = new Uint8Array(0);

export const initialClaudeTranscriptCursor: ClaudeTranscriptCursor = {
  offset: 0,
  headHash: digest(EMPTY),
  tailHash: digest(EMPTY),
  fileId: null,
  state: initialClaudeTranscriptParserState,
};

const READ_CHUNK_BYTES = 256 * 1024;
// Wide enough to span several records, whatever the last ones hold; a line can be many MiB.
const GUARD_WINDOW_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

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
 * Reads complete lines after `cursor` and parses them. Stops at the end of the file or once at
 * least `maxBytes` have been consumed; a last line without its newline is left for the next read.
 * The new cursor's digests are of the bytes parsed, so a rewrite during the read that reaches
 * either window shows at the next read. A read that fails leaves the caller's cursor where it was.
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
    if (length === 0) return EMPTY;
    yield* handle.seek(BigInt(offset), "start");
    const bytes = yield* handle.readAlloc(length);
    return Option.isSome(bytes) ? bytes.value : EMPTY;
  });

  const stored = input.cursor;
  let head = EMPTY;
  let tail = EMPTY;
  let resumes = stored.offset === 0;
  if (!resumes && stored.fileId === fileId && stored.offset <= size) {
    head = yield* readAt(0, Math.min(GUARD_WINDOW_BYTES, stored.offset));
    const tailLength = Math.min(GUARD_WINDOW_BYTES, stored.offset);
    tail = yield* readAt(stored.offset - tailLength, tailLength);
    resumes = digest(head) === stored.headHash && digest(tail) === stored.tailHash;
  }
  const start = resumes ? stored : initialClaudeTranscriptCursor;
  if (!resumes) {
    head = EMPTY;
    tail = EMPTY;
  }

  const decoder = new TextDecoder();
  const lines: Array<ClaudeTranscriptLine> = [];
  let offset = start.offset;
  // Consumed lines, newest last, kept only while they reach into a guard window.
  const headPieces: Array<Uint8Array> = [head];
  let headLength = head.length;
  const tailPieces: Array<Uint8Array> = [tail];
  let tailLength = tail.length;
  const consume = (line: Uint8Array) => {
    if (headLength < GUARD_WINDOW_BYTES) {
      const piece = line.subarray(0, GUARD_WINDOW_BYTES - headLength);
      headPieces.push(piece);
      headLength += piece.length;
    }
    tailPieces.push(line);
    tailLength += line.length;
    let oldest = tailPieces[0];
    while (oldest !== undefined && tailLength - oldest.length >= GUARD_WINDOW_BYTES) {
      tailPieces.shift();
      tailLength -= oldest.length;
      oldest = tailPieces[0];
    }
  };
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
      offset += line.length;
      consume(line);
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
  const tailBytes = concatenate(tailPieces, tailLength);
  const read: ClaudeTranscriptRead = {
    events: parsed.events,
    malformed: parsed.malformed,
    cursor: {
      offset,
      headHash: digest(concatenate(headPieces, headLength)),
      tailHash: digest(tailBytes.subarray(Math.max(0, tailBytes.length - GUARD_WINDOW_BYTES))),
      fileId,
      state: parsed.state,
    },
    rewritten: !resumes,
    atEnd,
  };
  return read;
}, Effect.scoped);
