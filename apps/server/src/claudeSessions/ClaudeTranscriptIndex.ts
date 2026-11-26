// A synchronous digest of bytes already in memory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import {
  CLAUDE_SYNTHETIC_MODEL,
  decodeClaudeTranscriptLine,
  type ClaudeTranscriptRecord,
} from "./ClaudeTranscriptLine.ts";

// Claude Code names a session's transcript after its id; renamed copies such as `<id>.jsonl.superseded-<ms>` or `.orphaned` are archives, not sessions.
const TRANSCRIPT_FILE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The session id a transcript file name carries, or undefined for any other file. */
export function claudeTranscriptSessionId(fileName: string): string | undefined {
  return TRANSCRIPT_FILE_NAME.exec(fileName)?.[1];
}

/** What an indexed line is, as far as the turn structure needs to know. */
export const ClaudeTranscriptLineKind = {
  /** A line with a uuid that holds no content, such as a hook attachment; chains pass through it. */
  Neutral: 0,
  User: 1,
  Assistant: 2,
  Queued: 3,
  CommandInput: 4,
  CommandOutput: 5,
  TurnDuration: 6,
  CompactBoundary: 7,
  /** A user or assistant line whose header reads but whose body does not. */
  Unreadable: 8,
} as const;
export type ClaudeTranscriptLineKind =
  (typeof ClaudeTranscriptLineKind)[keyof typeof ClaudeTranscriptLineKind];

export const ClaudeTranscriptLineFlag = {
  Meta: 1,
  CompactSummary: 2,
  ToolResult: 4,
  Interrupt: 8,
  /** The line is only command or shell output. */
  Output: 16,
  /** The line shows the user text: a prompt, or a command as typed. */
  Visible: 32,
  ToolUse: 64,
  /** A reply whose stop reason ends the turn. */
  TurnEnd: 128,
  Synthetic: 256,
} as const;

type TypedArray = Int32Array | Uint32Array | Float64Array | Uint16Array | Uint8Array;

/** A growable typed array, so per-line state is a fixed handful of numbers, not an object. */
export class ClaudeTranscriptColumn<T extends TypedArray> {
  #data: T;
  readonly #make: (length: number) => T;
  constructor(make: (length: number) => T) {
    this.#make = make;
    this.#data = make(1024);
  }
  get bytes(): number {
    return this.#data.byteLength;
  }
  get(index: number): number {
    const value = this.#data[index];
    if (value === undefined) throw new RangeError(`Column has no slot ${index}.`);
    return value;
  }
  /** The value at `index`, or `fallback` for a slot never set. */
  read(index: number, fallback: number): number {
    return index < this.#data.length ? (this.#data[index] ?? fallback) : fallback;
  }
  set(index: number, value: number): void {
    if (index >= this.#data.length) {
      const grown = this.#make(Math.max(index + 1, this.#data.length * 2));
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data[index] = value;
  }
}

/** 32-bit FNV-1a over a line's bytes: the identity of its content, cheap to keep per line. */
export function hashClaudeTranscriptLine(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/** 32-bit FNV-1a over a text's UTF-16 code units, as the index keeps for each prompt's visible text. */
export function hashClaudeTranscriptText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

interface EntryFields {
  readonly kind: ClaudeTranscriptLineKind;
  readonly flags: number;
  readonly parentUuid: string | null | undefined;
  readonly timestamp: string | undefined;
  readonly promptId: string | null | undefined;
  readonly forkSessionId: string | undefined;
  readonly textHash: number;
  readonly durationMs: number;
}

function entryFields(
  record: ClaudeTranscriptRecord,
  header: HeaderFields,
): EntryFields | undefined {
  const Kind = ClaudeTranscriptLineKind;
  const Flag = ClaudeTranscriptLineFlag;
  const base = {
    parentUuid: header.parentUuid,
    timestamp: header.timestamp,
    promptId: header.promptId,
    forkSessionId: undefined,
    textHash: 0,
    durationMs: 0,
    flags: 0,
  };
  switch (record.kind) {
    case "conversation": {
      const { line } = record;
      const flags =
        (line.isMeta === true ? Flag.Meta : 0) |
        (line.isCompactSummary === true ? Flag.CompactSummary : 0) |
        (record.isToolResult ? Flag.ToolResult : 0) |
        (record.isInterrupt ? Flag.Interrupt : 0) |
        (record.output === undefined ? 0 : Flag.Output) |
        (line.type === "user" && record.visible.text.length > 0 ? Flag.Visible : 0) |
        (record.hasToolUse ? Flag.ToolUse : 0) |
        (record.isTurnEnd && !record.hasToolUse ? Flag.TurnEnd : 0) |
        (line.message.model === CLAUDE_SYNTHETIC_MODEL ? Flag.Synthetic : 0);
      return {
        ...base,
        kind: line.type === "user" ? Kind.User : Kind.Assistant,
        flags,
        forkSessionId: line.forkedFrom?.sessionId,
        textHash: line.type === "user" ? hashClaudeTranscriptText(record.visible.text) : 0,
      };
    }
    case "queued":
      return { ...base, kind: Kind.Queued, forkSessionId: record.line.forkedFrom?.sessionId };
    case "localCommand":
      return record.input === undefined
        ? {
            ...base,
            kind: Kind.CommandOutput,
            flags: record.output === undefined ? 0 : Flag.Output,
            forkSessionId: record.line.forkedFrom?.sessionId,
          }
        : {
            ...base,
            kind: Kind.CommandInput,
            flags: record.input.text.length > 0 ? Flag.Visible : 0,
            forkSessionId: record.line.forkedFrom?.sessionId,
            textHash: hashClaudeTranscriptText(record.input.text),
          };
    case "turnDuration":
      return { ...base, kind: Kind.TurnDuration, durationMs: record.line.durationMs };
    case "compactBoundary":
      // The boundary starts a new chain; its logical parent is where the conversation was.
      return {
        ...base,
        kind: Kind.CompactBoundary,
        parentUuid: header.parentUuid ?? record.line.logicalParentUuid,
      };
    case "other":
      return { ...base, kind: Kind.Neutral };
    case "title":
    case "derivedFrom":
      return undefined;
  }
}

interface HeaderFields {
  readonly type: string;
  readonly uuid?: string | undefined;
  readonly parentUuid?: string | null | undefined;
  readonly timestamp?: string | undefined;
  readonly promptId?: string | null | undefined;
  readonly isSidechain?: boolean | undefined;
}

/** Where an indexed line's bytes are in the file, without its newline. */
export interface ClaudeTranscriptLineLocation {
  readonly offset: number;
  readonly length: number;
  readonly hash: number;
}

/**
 * The minimum about each line of one transcript that turn structure needs, one entry per uuid: the first well-formed line with a uuid wins, a later copy is counted and dropped, and a line that could not be read keeps its slot only until a well-formed copy arrives. Sidechain lines and lines without a uuid are not entries. Memory is a fixed set of numbers per entry, plus each distinct uuid and prompt id string once.
 */
const Column = ClaudeTranscriptColumn;
const makeColumns = () => ({
  entryOf: new Column((length) => new Int32Array(length)),
  uuid: new Column((length) => new Int32Array(length)),
  parent: new Column((length) => new Int32Array(length)),
  promptId: new Column((length) => new Int32Array(length)),
  fork: new Column((length) => new Int32Array(length)),
  timestamp: new Column((length) => new Float64Array(length)),
  offset: new Column((length) => new Float64Array(length)),
  duration: new Column((length) => new Float64Array(length)),
  length: new Column((length) => new Uint32Array(length)),
  lineHash: new Column((length) => new Uint32Array(length)),
  textHash: new Column((length) => new Uint32Array(length)),
  flags: new Column((length) => new Uint16Array(length)),
  kind: new Column((length) => new Uint8Array(length)),
});

export class ClaudeTranscriptIndex {
  #ids = new Map<string, number>();
  #strings: Array<string> = [];
  #c = makeColumns();
  #count = 0;
  #repeated = 0;
  #malformed: Array<number> = [];
  #aiTitle: string | undefined = undefined;
  #customTitle: string | undefined = undefined;
  #derivedFrom: ReadonlyArray<{ readonly sessionId: string; readonly via: string }> = [];
  #version = 0;
  #generation = 0;
  #added: Array<number> = [];
  #replaced = false;
  #factsChanged = false;
  #newMalformed: Array<number> = [];
  #decoder = new TextDecoder();
  /** Where the file has been read to, with the guard digests of its first and last bytes. */
  position: ClaudeTranscriptFilePosition = initialPosition;

  /** Forgets everything, for a file that was replaced, truncated or rewritten. */
  reset(): void {
    this.#ids = new Map();
    this.#strings = [];
    this.#c = makeColumns();
    this.#count = 0;
    this.#repeated = 0;
    this.#malformed = [];
    this.#aiTitle = undefined;
    this.#customTitle = undefined;
    this.#derivedFrom = [];
    this.#version += 1;
    this.#generation += 1;
    this.#added = [];
    this.#replaced = false;
    this.#factsChanged = true;
    this.#newMalformed = [];
    this.position = initialPosition;
  }

  /** What changed since the last call: entries added in order, and whether any was replaced. */
  takeChanges(): ClaudeTranscriptIndexChanges {
    const changes: ClaudeTranscriptIndexChanges = {
      generation: this.#generation,
      added: this.#added,
      replaced: this.#replaced,
      factsChanged: this.#factsChanged,
      malformedOffsets: this.#newMalformed,
    };
    this.#added = [];
    this.#replaced = false;
    this.#factsChanged = false;
    this.#newMalformed = [];
    return changes;
  }

  #malformedAt(offset: number): void {
    this.#malformed.push(offset);
    this.#newMalformed.push(offset);
    this.#version += 1;
  }

  // Ids are stored plus one, so a zeroed slot means none.
  #intern(value: string): number {
    const known = this.#ids.get(value);
    if (known !== undefined) return known;
    const id = this.#strings.length;
    this.#strings.push(value);
    this.#ids.set(value, id);
    this.#c.entryOf.set(id, 0);
    return id;
  }

  #optional(value: string | null | undefined): number {
    return value === null || value === undefined ? 0 : this.#intern(value) + 1;
  }

  #string(id: number): string {
    const value = this.#strings[id];
    if (value === undefined) throw new RangeError(`Index has no string ${id}.`);
    return value;
  }

  /** Indexes one line, given without its newline, that starts at `offset` in the file. */
  addLine(bytes: Uint8Array, offset: number): void {
    const line = decodeClaudeTranscriptLine(this.#decoder.decode(bytes));
    if (line._tag === "Blank") return;
    if (line._tag === "Unparsed") {
      this.#malformedAt(offset);
      return;
    }
    const { header } = line;
    if (line._tag === "Record") {
      const { record } = line;
      if (record.kind === "title") {
        if (record.source === "ai") this.#aiTitle = record.title ?? this.#aiTitle;
        else this.#customTitle = record.title;
        this.#version += 1;
        this.#factsChanged = true;
        return;
      }
      if (record.kind === "derivedFrom") {
        this.#derivedFrom = record.sessions;
        this.#version += 1;
        this.#factsChanged = true;
        return;
      }
    }
    if (header.uuid === undefined || header.isSidechain === true) {
      if (line._tag === "Unreadable") this.#malformedAt(offset);
      return;
    }
    const fields =
      line._tag === "Record"
        ? entryFields(line.record, header)
        : {
            kind: ClaudeTranscriptLineKind.Unreadable,
            flags: 0,
            parentUuid: header.parentUuid,
            timestamp: header.timestamp,
            promptId: header.promptId,
            forkSessionId: undefined,
            textHash: 0,
            durationMs: 0,
          };
    if (fields === undefined) return;
    const id = this.#intern(header.uuid);
    const existing = this.#c.entryOf.get(id) - 1;
    if (
      existing >= 0 &&
      !(this.kind(existing) === ClaudeTranscriptLineKind.Unreadable && line._tag === "Record")
    ) {
      this.#repeated += 1;
      return;
    }
    const entry = existing >= 0 ? existing : this.#count++;
    if (existing >= 0) this.#replaced = true;
    else this.#added.push(entry);
    this.#c.entryOf.set(id, entry + 1);
    this.#c.uuid.set(entry, id);
    this.#c.parent.set(entry, this.#optional(fields.parentUuid));
    this.#c.promptId.set(entry, this.#optional(fields.promptId));
    this.#c.fork.set(entry, this.#optional(fields.forkSessionId));
    this.#c.timestamp.set(
      entry,
      fields.timestamp === undefined ? Number.NaN : Date.parse(fields.timestamp),
    );
    this.#c.offset.set(entry, offset);
    this.#c.duration.set(entry, fields.durationMs);
    this.#c.length.set(entry, bytes.length);
    this.#c.lineHash.set(entry, hashClaudeTranscriptLine(bytes));
    this.#c.textHash.set(entry, fields.textHash);
    this.#c.flags.set(entry, fields.flags);
    this.#c.kind.set(entry, fields.kind);
    this.#version += 1;
  }

  /** Changes whenever an entry, a malformed line or a session fact does. */
  get version(): number {
    return this.#version;
  }
  get entryCount(): number {
    return this.#count;
  }
  /** Lines with a uuid already indexed, dropped. */
  get repeatedLines(): number {
    return this.#repeated;
  }
  /** Byte offsets of lines that are not JSON records, or are unreadable with no uuid to file. */
  get malformedOffsets(): ReadonlyArray<number> {
    return this.#malformed;
  }
  /** The latest AI title line's title; a later line replaces an earlier one. */
  get aiTitle(): string | undefined {
    return this.#aiTitle;
  }
  /** The latest rename; a rename to nothing clears it. */
  get customTitle(): string | undefined {
    return this.#customTitle;
  }
  get derivedFrom(): ReadonlyArray<{ readonly sessionId: string; readonly via: string }> {
    return this.#derivedFrom;
  }

  entryOf(uuid: string): number | undefined {
    const id = this.#ids.get(uuid);
    if (id === undefined) return undefined;
    const entry = this.#c.entryOf.get(id) - 1;
    return entry >= 0 ? entry : undefined;
  }
  uuid(entry: number): string {
    return this.#string(this.#c.uuid.get(entry));
  }
  parentUuid(entry: number): string | null {
    const id = this.#c.parent.get(entry);
    return id === 0 ? null : this.#string(id - 1);
  }
  /** The uuid's string key: equal for every line naming the same uuid, entry or not. */
  uuidKey(entry: number): number {
    return this.#c.uuid.get(entry);
  }
  /** The parent uuid's string key, or -1 when the parent is null. */
  parentKey(entry: number): number {
    return this.#c.parent.get(entry) - 1;
  }
  /** One more than the greatest string key, so arrays indexed by key can be sized. */
  get keyCount(): number {
    return this.#strings.length;
  }
  /** The parent's entry, or -1 when the parent is null or has no entry. */
  parent(entry: number): number {
    const id = this.#c.parent.get(entry);
    return id === 0 ? -1 : this.#c.entryOf.get(id - 1) - 1;
  }
  /** The prompt id as a number equal across entries with equal prompt ids, 0 for none. */
  promptKey(entry: number): number {
    return this.#c.promptId.get(entry);
  }
  promptId(entry: number): string | undefined {
    const id = this.#c.promptId.get(entry);
    return id === 0 ? undefined : this.#string(id - 1);
  }
  forkSessionId(entry: number): string | undefined {
    const id = this.#c.fork.get(entry);
    return id === 0 ? undefined : this.#string(id - 1);
  }
  /** Milliseconds since the epoch, NaN when the line has no readable timestamp. */
  timestamp(entry: number): number {
    return this.#c.timestamp.get(entry);
  }
  durationMs(entry: number): number {
    return this.#c.duration.get(entry);
  }
  textHash(entry: number): number {
    return this.#c.textHash.get(entry);
  }
  kind(entry: number): number {
    return this.#c.kind.get(entry);
  }
  has(entry: number, flag: number): boolean {
    return (this.#c.flags.get(entry) & flag) !== 0;
  }
  location(entry: number): ClaudeTranscriptLineLocation {
    return {
      offset: this.#c.offset.get(entry),
      length: this.#c.length.get(entry),
      hash: this.#c.lineHash.get(entry),
    };
  }
  lineHash(entry: number): number {
    return this.#c.lineHash.get(entry);
  }

  /** Bytes the columns hold, and characters of the uuid and prompt id strings. */
  footprint(): { readonly columnBytes: number; readonly stringCharacters: number } {
    let stringCharacters = 0;
    for (const value of this.#strings) stringCharacters += value.length;
    let columnBytes = 0;
    for (const column of Object.values(this.#c)) columnBytes += column.bytes;
    return { columnBytes, stringCharacters };
  }
}

export interface ClaudeTranscriptIndexChanges {
  /** Changes whenever the index is reset. */
  readonly generation: number;
  readonly added: ReadonlyArray<number>;
  /** An unreadable entry was replaced by a well-formed copy, changing its fields in place. */
  readonly replaced: boolean;
  readonly factsChanged: boolean;
  readonly malformedOffsets: ReadonlyArray<number>;
}

/** Where a sync resumes. A same-length rewrite between the two guard windows goes unseen. */
export interface ClaudeTranscriptFilePosition {
  readonly offset: number;
  readonly headHash: string;
  readonly tailHash: string;
  readonly fileId: string | undefined;
}

const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const EMPTY: Uint8Array = new Uint8Array(0);
const initialPosition: ClaudeTranscriptFilePosition = {
  offset: 0,
  headHash: digest(EMPTY),
  tailHash: digest(EMPTY),
  fileId: undefined,
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

export interface ClaudeTranscriptSync {
  /** The file was replaced, truncated or rewritten, so the index was rebuilt from the top. */
  readonly rebuilt: boolean;
  readonly linesRead: number;
  readonly bytesRead: number;
}

/**
 * Brings `index` up to date with the file: only bytes appended since the last sync are read, unless the file is another file, is shorter, or its first or last read bytes changed, when the index is rebuilt from the top. An unterminated last line waits for its newline. Memory beyond the index is one read chunk and the longest line, and `afterChunk` runs between chunks.
 */
export const syncClaudeTranscriptIndex = Effect.fn("syncClaudeTranscriptIndex")(function* (input: {
  readonly filePath: string;
  readonly index: ClaudeTranscriptIndex;
  /** Runs after each read chunk's lines are indexed, so work done on them stays bounded. */
  readonly afterChunk: Effect.Effect<void>;
}) {
  const { index } = input;
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

  const stored = index.position;
  let head = EMPTY;
  let tail = EMPTY;
  let resumes = stored.offset === 0;
  if (!resumes && stored.fileId === fileId && stored.offset <= size) {
    head = yield* readAt(0, Math.min(GUARD_WINDOW_BYTES, stored.offset));
    const tailLength = Math.min(GUARD_WINDOW_BYTES, stored.offset);
    tail = yield* readAt(stored.offset - tailLength, tailLength);
    resumes = digest(head) === stored.headHash && digest(tail) === stored.tailHash;
  }
  if (!resumes) {
    index.reset();
    head = EMPTY;
    tail = EMPTY;
  }
  const start = index.position.offset;

  let offset = start;
  let linesRead = 0;
  // Read lines, newest last, kept only while they reach into a guard window.
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
  yield* handle.seek(BigInt(offset), "start");
  for (;;) {
    const chunk = yield* handle.readAlloc(READ_CHUNK_BYTES);
    if (Option.isNone(chunk)) break;
    const bytes = chunk.value;
    let lineStart = 0;
    let newline = bytes.indexOf(NEWLINE);
    while (newline !== -1) {
      const piece = bytes.subarray(lineStart, newline + 1);
      const line = concatenate([...pending, piece], pendingLength + piece.length);
      pending = [];
      pendingLength = 0;
      index.addLine(line.subarray(0, line.length - 1), offset);
      linesRead += 1;
      offset += line.length;
      consume(line);
      lineStart = newline + 1;
      newline = bytes.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < bytes.length) {
      pending.push(bytes.subarray(lineStart));
      pendingLength += bytes.length - lineStart;
    }
    yield* input.afterChunk;
  }
  const tailBytes = concatenate(tailPieces, tailLength);
  index.position = {
    offset,
    headHash: digest(concatenate(headPieces, headLength)),
    tailHash: digest(tailBytes.subarray(Math.max(0, tailBytes.length - GUARD_WINDOW_BYTES))),
    fileId,
  };
  const sync: ClaudeTranscriptSync = {
    rebuilt: !resumes,
    linesRead,
    bytesRead: offset - start,
  };
  return sync;
}, Effect.scoped);
