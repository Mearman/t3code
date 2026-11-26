// A synchronous digest of a few bytes per read.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { GUARD_LENGTH } from "../usage/usageTranscriptReader.ts";
import {
  ClaudeTranscriptParserState,
  initialClaudeTranscriptParserState,
  parseClaudeTranscriptLines,
  type ClaudeTranscriptEvent,
  type ClaudeTranscriptLine,
} from "./ClaudeTranscriptSegments.ts";

// Claude Code names a session's transcript after its id; renamed copies such as `<id>.jsonl.superseded-<ms>` or `.orphaned` are archives, not sessions.
const TRANSCRIPT_FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session id a transcript file name carries, or undefined for any other file. */
export function claudeTranscriptSessionId(fileName: string): string | undefined {
  return TRANSCRIPT_FILE_NAME.exec(fileName)?.[1];
}

/**
 * Where the next read of one transcript resumes. `guardHash` digests the bytes just before `offset`; when they differ, or the file is shorter, the file was rewritten and is read again.
 */
export const ClaudeTranscriptCursor = Schema.Struct({
  offset: Schema.Number,
  guardHash: Schema.String,
  state: ClaudeTranscriptParserState,
});
export type ClaudeTranscriptCursor = typeof ClaudeTranscriptCursor.Type;

const guardHashOf = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const initialClaudeTranscriptCursor: ClaudeTranscriptCursor = {
  offset: 0,
  guardHash: guardHashOf(new Uint8Array(0)),
  state: initialClaudeTranscriptParserState,
};

const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * Reads complete lines after `cursor` and parses them. Stops once at least `maxBytes` have been consumed or the file ends; a last line without its newline is left for the next read. `rewritten` means the read restarted from the top, so earlier events are emitted again with the same ids. A malformed line fails with `ClaudeTranscriptLineError`; the caller keeps its cursor.
 */
export const readClaudeTranscript = Effect.fn("readClaudeTranscript")(function* (input: {
  readonly filePath: string;
  readonly sessionId: string;
  readonly cursor: ClaudeTranscriptCursor;
  readonly maxBytes: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const handle = yield* fileSystem.open(input.filePath, { flag: "r" });
  const size = Number((yield* handle.stat).size);
  const guardAt = Effect.fnUntraced(function* (offset: number) {
    const length = Math.min(GUARD_LENGTH, offset);
    if (length === 0) return guardHashOf(new Uint8Array(0));
    yield* handle.seek(BigInt(offset - length), "start");
    const bytes = yield* handle.readAlloc(length);
    return guardHashOf(Option.isSome(bytes) ? bytes.value : new Uint8Array(0));
  });

  const resumes =
    input.cursor.offset <= size && (yield* guardAt(input.cursor.offset)) === input.cursor.guardHash;
  const cursor = resumes ? input.cursor : initialClaudeTranscriptCursor;

  const decoder = new TextDecoder();
  const lines: Array<ClaudeTranscriptLine> = [];
  let offset = cursor.offset;
  let pending = new Uint8Array(0);
  let atEnd = false;
  yield* handle.seek(BigInt(offset), "start");
  while (offset - cursor.offset < input.maxBytes) {
    const chunk = yield* handle.readAlloc(READ_CHUNK_BYTES);
    if (Option.isNone(chunk)) {
      atEnd = true;
      break;
    }
    const joined = new Uint8Array(pending.length + chunk.value.length);
    joined.set(pending);
    joined.set(chunk.value, pending.length);
    let lineStart = 0;
    let newline = joined.indexOf(NEWLINE);
    while (newline !== -1) {
      lines.push({ text: decoder.decode(joined.subarray(lineStart, newline)), offset });
      offset += newline + 1 - lineStart;
      lineStart = newline + 1;
      newline = joined.indexOf(NEWLINE, lineStart);
    }
    pending = joined.slice(lineStart);
  }

  const parsed = parseClaudeTranscriptLines({
    sessionId: input.sessionId,
    state: cursor.state,
    lines,
  });
  if (Result.isFailure(parsed)) return yield* parsed.failure;
  const next: ClaudeTranscriptCursor = {
    offset,
    guardHash: offset === cursor.offset ? cursor.guardHash : yield* guardAt(offset),
    state: parsed.success.state,
  };
  const events: ReadonlyArray<ClaudeTranscriptEvent> = parsed.success.events;
  return { events, cursor: next, rewritten: !resumes, atEnd };
}, Effect.scoped);
