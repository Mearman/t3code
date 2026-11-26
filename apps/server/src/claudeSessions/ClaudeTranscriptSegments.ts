import type { SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  claudeMessagesBeforeTrailingAborts,
  isClaudeTranscriptTurnEnd,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import {
  claudeTitle,
  claudeUserText,
  deriveTitle,
  extractText,
} from "../project/AgentSessionScanner.ts";

/** A content block exactly as Claude Code recorded it; string content becomes one text block. */
export type ClaudeTranscriptBlock =
  | SDKAssistantMessage["message"]["content"][number]
  | Exclude<SDKUserMessage["message"]["content"], string>[number];

/** The original message a forked session's copied line came from. */
export interface ClaudeTranscriptForkSource {
  readonly sessionId: string;
  readonly messageUuid: string;
}

export interface ClaudeTranscriptItem {
  /** `x:<sessionId>:<lineUuid>[:<blockIndex>]`, stable across re-reads of the same file. */
  readonly id: string;
  readonly lineUuid: string;
  /** Undefined when the line's content was a plain string rather than a block array. */
  readonly blockIndex: number | undefined;
  readonly role: "user" | "assistant";
  readonly timestamp: string;
  readonly block: ClaudeTranscriptBlock;
  readonly model: string | undefined;
  /** The API message id; Claude Code writes one line per block, so a message spans lines. */
  readonly messageId: string | undefined;
  readonly forkedFrom: ClaudeTranscriptForkSource | undefined;
}

export interface ClaudeTranscriptPrompt {
  /** What the user typed, as `claudeUserText` shows it; empty for prompts Claude Code wrote. */
  readonly text: string;
  readonly title: string | undefined;
  readonly promptId: string | undefined;
  /** Claude Code's `origin.kind`, such as `human` or `task-notification`, when recorded. */
  readonly originKind: string | undefined;
  /** Claude Code marked the prompt meta: written for the model, not shown as the user's. */
  readonly hidden: boolean;
}

export type ClaudeTranscriptEndReason =
  | "turn-end"
  | "turn-duration"
  | "interrupted"
  | "next-prompt";

export type ClaudeTranscriptEvent =
  | {
      readonly _tag: "SegmentStarted";
      /** The uuid of the record that opened the segment. */
      readonly segmentId: string;
      readonly parentUuid: string | null;
      readonly timestamp: string;
      /** Undefined when content arrived with no prompt before it, such as a file cut mid-turn. */
      readonly prompt: ClaudeTranscriptPrompt | undefined;
      readonly forkedFrom: ClaudeTranscriptForkSource | undefined;
    }
  | { readonly _tag: "Item"; readonly segmentId: string; readonly item: ClaudeTranscriptItem }
  | {
      /** A prompt Claude Code delivered into the running turn, as a steer joins an active run. */
      readonly _tag: "QueuedPrompt";
      readonly segmentId: string;
      /** `x:<sessionId>:<lineUuid>`, after the attachment record that delivered it. */
      readonly id: string;
      readonly lineUuid: string;
      readonly timestamp: string;
      readonly prompt: ClaudeTranscriptPrompt;
      readonly blocks: ReadonlyArray<ClaudeTranscriptBlock>;
      readonly forkedFrom: ClaudeTranscriptForkSource | undefined;
    }
  | {
      /** Follows any content added to the segment after its last end; the latest one holds. */
      readonly _tag: "SegmentEnded";
      readonly segmentId: string;
      readonly reason: ClaudeTranscriptEndReason;
      readonly lastAssistantUuid: string | undefined;
      readonly timestamp: string;
      readonly durationMs: number | undefined;
    }
  | {
      /** A segment whose parent is older than the segment before it, abandoning that one. */
      readonly _tag: "Branch";
      readonly lineUuid: string;
      readonly parentUuid: string;
      readonly previousUuid: string | null;
    }
  | {
      readonly _tag: "CompactBoundary";
      readonly segmentId: string | undefined;
      readonly lineUuid: string;
      readonly logicalParentUuid: string | null;
      readonly trigger: string;
      readonly preTokens: number;
      readonly timestamp: string;
    }
  /** A null custom title clears an earlier rename. */
  | { readonly _tag: "Title"; readonly source: "ai" | "custom"; readonly title: string | null }
  | {
      readonly _tag: "DerivedFrom";
      readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly via: string }>;
    }
  /** The first line copied from another session; each copied line also names its original. */
  | { readonly _tag: "ForkedFrom"; readonly sessionId: string; readonly messageUuid: string };

const EndReason = Schema.Literals(["turn-end", "turn-duration", "interrupted", "next-prompt"]);

const ForkSource = Schema.Struct({ sessionId: Schema.String, messageUuid: Schema.String });

const SegmentState = Schema.Struct({
  /** Counts segments in file order, so recent uuids can name theirs compactly. */
  ordinal: Schema.Number,
  segmentId: Schema.String,
  /** The turn's prompt id, which the output Claude Code writes for the turn repeats. */
  promptId: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(EndReason),
  lastAssistantUuid: Schema.NullOr(Schema.String),
  openerText: Schema.String,
});
type SegmentState = typeof SegmentState.Type;

// A meta line with a new prompt id opens a turn once a reply or an interrupt follows it.
const PendingOpener = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  promptId: Schema.String,
  text: Schema.String,
  titleText: Schema.String,
  originKind: Schema.NullOr(Schema.String),
  forkedFrom: Schema.NullOr(ForkSource),
  /** The line before the opener, and whether the opener's parent abandons the open segment. */
  previousUuid: Schema.NullOr(Schema.String),
  branches: Schema.Boolean,
});

/**
 * What the parser carries between reads; serialisable and bounded. Whether a uuid was read before
 * is not kept here: the consumer stores each read's `consumedUuids` and names them in `known`.
 */
export const ClaudeTranscriptParserState = Schema.Struct({
  /** The latest segments, oldest first; the last is the one new content joins. */
  segments: Schema.Array(SegmentState),
  nextOrdinal: Schema.Number,
  /** The latest main-chain uuids with their segment ordinals, oldest first. */
  recentUuids: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
  lastUuid: Schema.NullOr(Schema.String),
  pendingOpener: Schema.NullOr(PendingOpener),
  forkSessionId: Schema.NullOr(Schema.String),
});
export type ClaudeTranscriptParserState = typeof ClaudeTranscriptParserState.Type;

export const initialClaudeTranscriptParserState: ClaudeTranscriptParserState = {
  segments: [],
  nextOrdinal: 0,
  recentUuids: [],
  lastUuid: null,
  pendingOpener: null,
  forkSessionId: null,
};

// Claude Code writes a line's parent a few records before it, and finishes a reply within a
// few turns of the next prompt; these bound the stored state of a long session.
const RECENT_UUID_LIMIT = 512;
const RECENT_SEGMENT_LIMIT = 16;

export class ClaudeTranscriptLineError extends Schema.TaggedError<ClaudeTranscriptLineError>()(
  "ClaudeTranscriptLineError",
  { offset: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Malformed Claude transcript line at byte ${this.offset}.`;
  }
}

export interface ClaudeTranscriptLine {
  readonly text: string;
  /** Byte offset of the line's first byte in the file. */
  readonly offset: number;
}

function claudeTranscriptItemId(
  sessionId: string,
  lineUuid: string,
  blockIndex: number | undefined,
): string {
  return blockIndex === undefined
    ? `x:${sessionId}:${lineUuid}`
    : `x:${sessionId}:${lineUuid}:${blockIndex}`;
}

// Decoding validates the fields the parser reads; blocks are then taken from the raw record, since decoding drops the fields a schema does not name.
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String }))]);

const Origin = Schema.optional(Schema.Struct({ kind: Schema.optional(Schema.String) }));

const ConversationLine = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  promptId: Schema.optional(Schema.NullOr(Schema.String)),
  origin: Origin,
  forkedFrom: Schema.optional(ForkSource),
  message: Schema.Struct({
    content: Content,
    model: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const QueuedCommand = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  forkedFrom: Schema.optional(ForkSource),
  attachment: Schema.Struct({
    prompt: Content,
    commandMode: Schema.optional(Schema.String),
    origin: Origin,
    isMeta: Schema.optional(Schema.Boolean),
  }),
});

const LocalCommand = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  content: Schema.String,
  forkedFrom: Schema.optional(ForkSource),
});

const TurnDuration = Schema.Struct({
  uuid: Schema.String,
  timestamp: Schema.String,
  durationMs: Schema.Number,
});

const CompactBoundary = Schema.Struct({
  uuid: Schema.String,
  timestamp: Schema.String,
  logicalParentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  compactMetadata: Schema.Struct({ trigger: Schema.String, preTokens: Schema.Number }),
});

const RecordHeader = Schema.Struct({
  type: Schema.String,
  uuid: Schema.optional(Schema.String),
  parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
});

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeRecordHeader = Schema.decodeUnknownExit(RecordHeader);
const decodeConversationLine = Schema.decodeUnknownExit(ConversationLine);
const decodeQueuedCommand = Schema.decodeUnknownExit(QueuedCommand);
const decodeLocalCommand = Schema.decodeUnknownExit(LocalCommand);
const decodeTurnDuration = Schema.decodeUnknownExit(TurnDuration);
const decodeCompactBoundary = Schema.decodeUnknownExit(CompactBoundary);
const decodeAiTitle = Schema.decodeUnknownExit(Schema.Struct({ aiTitle: Schema.String }));
const decodeCustomTitle = Schema.decodeUnknownExit(Schema.Struct({ customTitle: Schema.String }));
const decodeDerivedFrom = Schema.decodeUnknownExit(
  Schema.Struct({
    sessions: Schema.Array(Schema.Struct({ id: Schema.String, via: Schema.String })),
  }),
);

// Fields each known block type cannot do without; unknown block types pass through unchecked.
const REQUIRED_BLOCK_FIELDS: ReadonlyMap<string, (block: unknown) => boolean> = new Map([
  ["text", Schema.is(Schema.Struct({ text: Schema.String }))],
  ["thinking", Schema.is(Schema.Struct({ thinking: Schema.String }))],
  ["redacted_thinking", Schema.is(Schema.Struct({ data: Schema.String }))],
  ["tool_use", Schema.is(Schema.Struct({ id: Schema.String, name: Schema.String }))],
  ["tool_result", Schema.is(Schema.Struct({ tool_use_id: Schema.String }))],
]);

// The SDK's block union is open-ended; the fields the parser and its consumers read are checked.
function isTranscriptBlock(value: unknown): value is ClaudeTranscriptBlock {
  if (!Predicate.hasProperty(value, "type") || typeof value.type !== "string") return false;
  const required = REQUIRED_BLOCK_FIELDS.get(value.type);
  return required === undefined || required(value);
}

class MalformedLine {
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

function attempt<A>(decode: () => A): A | MalformedLine {
  try {
    return decode();
  } catch (error) {
    if (error instanceof MalformedLine) return error;
    throw error;
  }
}

function decoded<A>(exit: Exit.Exit<A, unknown>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new MalformedLine(exit.cause);
}

interface IndexedBlock {
  readonly block: ClaudeTranscriptBlock;
  readonly index: number | undefined;
}

function checkedBlocks(content: unknown): ReadonlyArray<IndexedBlock> {
  if (typeof content === "string") {
    return [{ block: { type: "text", text: content }, index: undefined }];
  }
  if (!Array.isArray(content)) throw new MalformedLine("Content is neither text nor blocks.");
  return content.map((block: unknown, index) => {
    if (!isTranscriptBlock(block)) {
      throw new MalformedLine(`Content block ${index} lacks its required fields.`);
    }
    return { block, index };
  });
}

function blockText(blocks: ReadonlyArray<IndexedBlock>): string {
  return extractText(
    blocks.flatMap(({ block }) =>
      block.type === "text" ? [{ type: "text", text: block.text }] : [],
    ),
  );
}

const isLocalCommandInput = (content: string) => /^<command-(?:name|message)>/.test(content);

interface LineRef {
  readonly uuid: string;
  readonly parentUuid: string | null;
  readonly timestamp: string;
  readonly forkedFrom?: ClaudeTranscriptForkSource | undefined;
}

interface Visible {
  readonly text: string;
  readonly titleText: string;
}

// Every record the parser acts on, fully validated before any state changes.
type DecodedRecord =
  | {
      readonly kind: "conversation";
      readonly line: typeof ConversationLine.Type;
      readonly entry: unknown;
      readonly blocks: ReadonlyArray<IndexedBlock>;
      readonly visible: Visible;
      readonly isToolResult: boolean;
      readonly isInterrupt: boolean;
    }
  | {
      readonly kind: "queued";
      readonly line: typeof QueuedCommand.Type;
      readonly blocks: ReadonlyArray<IndexedBlock>;
      readonly visible: Visible;
    }
  | {
      readonly kind: "localCommand";
      readonly line: typeof LocalCommand.Type;
      readonly blocks: ReadonlyArray<IndexedBlock>;
    }
  | { readonly kind: "turnDuration"; readonly line: typeof TurnDuration.Type }
  | { readonly kind: "compactBoundary"; readonly line: typeof CompactBoundary.Type }
  | { readonly kind: "event"; readonly event: ClaudeTranscriptEvent | undefined }
  | { readonly kind: "ignored" };

function decodeBody(type: string, entry: unknown): DecodedRecord {
  switch (type) {
    case "user":
    case "assistant": {
      const line = decoded(decodeConversationLine(entry));
      const content = field(field(entry, "message"), "content");
      const blocks = checkedBlocks(content);
      return {
        kind: "conversation",
        line,
        entry,
        blocks,
        visible: claudeUserText(blockText(blocks)),
        isToolResult: blocks.some(({ block }) => typeof field(block, "tool_use_id") === "string"),
        // The adapter's abort detection, on one message, recognises Claude's interrupt markers.
        isInterrupt:
          line.type === "user" &&
          claudeMessagesBeforeTrailingAborts([
            { type: "user", uuid: line.uuid, message: { content } },
          ]) === 0,
      };
    }
    case "attachment": {
      if (field(field(entry, "attachment"), "type") !== "queued_command")
        return { kind: "ignored" };
      const line = decoded(decodeQueuedCommand(entry));
      const blocks = checkedBlocks(field(field(entry, "attachment"), "prompt"));
      return { kind: "queued", line, blocks, visible: claudeUserText(blockText(blocks)) };
    }
    case "system": {
      const subtype = field(entry, "subtype");
      if (subtype === "turn_duration") {
        return { kind: "turnDuration", line: decoded(decodeTurnDuration(entry)) };
      }
      if (subtype === "local_command") {
        const line = decoded(decodeLocalCommand(entry));
        return { kind: "localCommand", line, blocks: checkedBlocks(line.content) };
      }
      if (subtype === "compact_boundary") {
        return { kind: "compactBoundary", line: decoded(decodeCompactBoundary(entry)) };
      }
      return { kind: "ignored" };
    }
    case "ai-title": {
      const title = claudeTitle(decoded(decodeAiTitle(entry)).aiTitle);
      return {
        kind: "event",
        event: title === undefined ? undefined : { _tag: "Title", source: "ai", title },
      };
    }
    case "custom-title":
      return {
        kind: "event",
        event: {
          _tag: "Title",
          source: "custom",
          title: claudeTitle(decoded(decodeCustomTitle(entry)).customTitle) ?? null,
        },
      };
    case "derived-from":
      return {
        kind: "event",
        event: {
          _tag: "DerivedFrom",
          sessions: decoded(decodeDerivedFrom(entry)).sessions.map((session) => ({
            sessionId: session.id,
            via: session.via,
          })),
        },
      };
    default:
      return { kind: "ignored" };
  }
}

/** One line, decoded ahead of the fold so the consumer can look up its uuids first. */
export type ClaudeTranscriptDecodedLine =
  | {
      readonly _tag: "Record";
      readonly offset: number;
      readonly header: typeof RecordHeader.Type;
      readonly record: DecodedRecord;
    }
  | {
      readonly _tag: "Malformed";
      readonly header: typeof RecordHeader.Type | undefined;
      readonly error: ClaudeTranscriptLineError;
    };

/** Decodes each line before any parser state is involved; blank lines are dropped. */
export function decodeClaudeTranscriptLines(
  lines: ReadonlyArray<ClaudeTranscriptLine>,
): ReadonlyArray<ClaudeTranscriptDecodedLine> {
  const decodedLines: Array<ClaudeTranscriptDecodedLine> = [];
  for (const line of lines) {
    if (line.text.trim().length === 0) continue;
    const head = attempt(() => {
      const entry = decoded(decodeJson(line.text));
      return { entry, header: decoded(decodeRecordHeader(entry)) };
    });
    if (head instanceof MalformedLine) {
      decodedLines.push({
        _tag: "Malformed",
        header: undefined,
        error: new ClaudeTranscriptLineError({ offset: line.offset, cause: head.cause }),
      });
      continue;
    }
    const record = attempt(() => decodeBody(head.header.type, head.entry));
    decodedLines.push(
      record instanceof MalformedLine
        ? {
            _tag: "Malformed",
            header: head.header,
            error: new ClaudeTranscriptLineError({ offset: line.offset, cause: record.cause }),
          }
        : { _tag: "Record", offset: line.offset, header: head.header, record },
    );
  }
  return decodedLines;
}

/** The uuids of the lines and of their parents, which the consumer looks up to build `known`. */
export function claudeTranscriptLineUuids(
  lines: ReadonlyArray<ClaudeTranscriptDecodedLine>,
): ReadonlyArray<string> {
  const uuids = new Set<string>();
  for (const line of lines) {
    if (line.header?.uuid !== undefined) uuids.add(line.header.uuid);
    const parent = line.header?.parentUuid;
    if (parent !== undefined && parent !== null) uuids.add(parent);
  }
  return [...uuids];
}

export interface ClaudeTranscriptParseResult {
  readonly state: ClaudeTranscriptParserState;
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  /** Lines that could not be understood; each was stepped past, its uuid kept as a parent. */
  readonly malformed: ReadonlyArray<ClaudeTranscriptLineError>;
  /** The uuids first read here, in file order; the consumer stores them with the new state. */
  readonly consumedUuids: ReadonlyArray<string>;
}

/**
 * Folds decoded lines into segment events. A line is skipped only when its uuid was read before,
 * in this call or as named in `known`, which is how lines rewritten after compaction are found.
 * Lines are not written in timestamp or chain order, so each joins its recent parent's segment,
 * else the latest one.
 */
export function foldClaudeTranscriptLines(input: {
  readonly sessionId: string;
  readonly state: ClaudeTranscriptParserState;
  readonly lines: ReadonlyArray<ClaudeTranscriptDecodedLine>;
  readonly known: ReadonlySet<string>;
}): ClaudeTranscriptParseResult {
  const segments = [...input.state.segments];
  let nextOrdinal = input.state.nextOrdinal;
  const recentUuids = [...input.state.recentUuids];
  const recentSegment = new Map(recentUuids);
  let lastUuid = input.state.lastUuid;
  let pendingOpener = input.state.pendingOpener;
  let forkSessionId = input.state.forkSessionId;
  const events: Array<ClaudeTranscriptEvent> = [];
  const malformed: Array<ClaudeTranscriptLineError> = [];
  const consumedUuids: Array<string> = [];
  const consumedHere = new Set<string>();

  const itemId = (lineUuid: string, index: number | undefined) =>
    claudeTranscriptItemId(input.sessionId, lineUuid, index);
  const current = () => segments.at(-1);
  const byOrdinal = (ordinal: number) => segments.find((segment) => segment.ordinal === ordinal);
  const update = (next: SegmentState) => {
    const index = segments.findIndex((segment) => segment.ordinal === next.ordinal);
    segments[index] = next;
    return next;
  };

  const remember = (uuid: string, ordinal: number | undefined) => {
    lastUuid = uuid;
    if (ordinal === undefined || recentSegment.has(uuid)) return;
    recentUuids.push([uuid, ordinal]);
    recentSegment.set(uuid, ordinal);
    const evicted = recentUuids.length > RECENT_UUID_LIMIT ? recentUuids.shift() : undefined;
    if (evicted !== undefined) recentSegment.delete(evicted[0]);
  };

  // The segment a line continues: its parent's when that is recent, else the latest one.
  const segmentFor = (parentUuid: string | null) => {
    const ordinal = parentUuid === null ? undefined : recentSegment.get(parentUuid);
    const parentSegment = ordinal === undefined ? undefined : byOrdinal(ordinal);
    return parentSegment ?? current();
  };

  // A parent read before that is not in the latest segment abandons it.
  const branchesFrom = (parentUuid: string | null) => {
    const latest = current();
    if (latest === undefined || parentUuid === null) return false;
    const ordinal = recentSegment.get(parentUuid);
    if (ordinal !== undefined) return ordinal !== latest.ordinal;
    return input.known.has(parentUuid) || consumedHere.has(parentUuid);
  };

  const emitEnd = (
    segment: SegmentState,
    reason: ClaudeTranscriptEndReason,
    timestamp: string,
    durationMs?: number,
  ) => {
    const ended = update({ ...segment, endReason: reason });
    events.push({
      _tag: "SegmentEnded",
      segmentId: ended.segmentId,
      reason,
      lastAssistantUuid: ended.lastAssistantUuid ?? undefined,
      timestamp,
      durationMs,
    });
    return ended;
  };

  const noteFork = (forkedFrom: ClaudeTranscriptForkSource | undefined) => {
    if (forkedFrom === undefined || forkedFrom.sessionId === forkSessionId) return;
    forkSessionId = forkedFrom.sessionId;
    events.push({ _tag: "ForkedFrom", ...forkedFrom });
  };

  const open = (
    opener: LineRef,
    promptId: string | null,
    prompt: ClaudeTranscriptPrompt | undefined,
    branch: { readonly branches: boolean; readonly previousUuid: string | null } = {
      branches: branchesFrom(opener.parentUuid),
      previousUuid: lastUuid,
    },
  ) => {
    const latest = current();
    if (latest !== undefined && latest.endReason === null) {
      emitEnd(latest, "next-prompt", opener.timestamp);
    }
    if (branch.branches && opener.parentUuid !== null) {
      events.push({
        _tag: "Branch",
        lineUuid: opener.uuid,
        parentUuid: opener.parentUuid,
        previousUuid: branch.previousUuid,
      });
    }
    const opened: SegmentState = {
      ordinal: nextOrdinal,
      segmentId: opener.uuid,
      promptId,
      endReason: null,
      lastAssistantUuid: null,
      openerText: prompt?.text ?? "",
    };
    nextOrdinal += 1;
    segments.push(opened);
    if (segments.length > RECENT_SEGMENT_LIMIT) segments.shift();
    pendingOpener = null;
    events.push({
      _tag: "SegmentStarted",
      segmentId: opener.uuid,
      parentUuid: opener.parentUuid,
      timestamp: opener.timestamp,
      prompt,
      forkedFrom: opener.forkedFrom,
    });
    return opened;
  };

  const pushItems = (
    segmentId: string,
    line: LineRef,
    role: "user" | "assistant",
    blocks: ReadonlyArray<IndexedBlock>,
    message?: { readonly model?: string | undefined; readonly id?: string | undefined },
  ) => {
    for (const { block, index } of blocks) {
      events.push({
        _tag: "Item",
        segmentId,
        item: {
          id: itemId(line.uuid, index),
          lineUuid: line.uuid,
          blockIndex: index,
          role,
          timestamp: line.timestamp,
          block,
          model: message?.model,
          messageId: message?.id,
          forkedFrom: line.forkedFrom,
        },
      });
    }
  };

  // Output Claude Code writes after a turn ended leaves it ended, with a fresh end after it.
  const continueWith = (line: LineRef, blocks: ReadonlyArray<IndexedBlock>) => {
    const target = segmentFor(line.parentUuid) ?? open(line, null, undefined);
    pushItems(target.segmentId, line, "user", blocks);
    if (target.endReason !== null) emitEnd(target, target.endReason, line.timestamp);
    return target;
  };

  const prompt = (
    visible: Visible,
    promptId: string | undefined,
    originKind: string | undefined,
    hidden: boolean,
  ): ClaudeTranscriptPrompt => ({
    text: visible.text,
    title: deriveTitle("claudeAgent", visible.titleText),
    promptId,
    originKind,
    hidden,
  });

  const openPending = (opener: typeof PendingOpener.Type) =>
    open(
      { ...opener, forkedFrom: opener.forkedFrom ?? undefined },
      opener.promptId,
      prompt(opener, opener.promptId, opener.originKind ?? undefined, true),
      opener,
    );

  // A reply or an interrupt opens a pending meta-opened turn unless it continues an older one.
  const takesPending = (parentUuid: string | null) => {
    if (pendingOpener === null) return false;
    const target = segmentFor(parentUuid);
    return (
      parentUuid === pendingOpener.uuid ||
      target === undefined ||
      target.ordinal === current()?.ordinal
    );
  };

  const conversation = (record: Extract<DecodedRecord, { kind: "conversation" }>) => {
    const { line, blocks, visible } = record;
    const promptId = line.promptId ?? undefined;
    if (line.isCompactSummary === true) return segmentFor(line.parentUuid);
    noteFork(line.forkedFrom);
    if (line.type === "assistant") {
      const target =
        pendingOpener !== null && takesPending(line.parentUuid)
          ? openPending(pendingOpener)
          : (segmentFor(line.parentUuid) ?? open(line, null, undefined));
      pushItems(target.segmentId, line, "assistant", blocks, line.message);
      // A late line of an earlier turn keeps that turn's end; the latest turn is running again.
      const endReason = isClaudeTranscriptTurnEnd(record.entry)
        ? "turn-end"
        : target.ordinal === current()?.ordinal
          ? null
          : target.endReason;
      const replied = update({ ...target, endReason: null, lastAssistantUuid: line.uuid });
      return endReason === null ? replied : emitEnd(replied, endReason, line.timestamp);
    }
    if (line.isMeta === true) {
      // Claude Code can follow a turn's opening meta line with more; the first one opens it.
      const latest = current();
      if (
        promptId !== undefined &&
        promptId !== latest?.promptId &&
        promptId !== pendingOpener?.promptId
      ) {
        pendingOpener = {
          uuid: line.uuid,
          parentUuid: line.parentUuid,
          timestamp: line.timestamp,
          promptId,
          text: visible.text,
          titleText: visible.titleText,
          originKind: line.origin?.kind ?? null,
          forkedFrom: line.forkedFrom ?? null,
          previousUuid: lastUuid,
          branches: branchesFrom(line.parentUuid),
        };
      }
      return segmentFor(line.parentUuid);
    }
    if (record.isInterrupt) {
      const opener = pendingOpener;
      const target =
        opener !== null && promptId === opener.promptId && takesPending(line.parentUuid)
          ? openPending(opener)
          : (segmentFor(line.parentUuid) ?? open(line, null, undefined));
      pushItems(target.segmentId, line, "user", blocks);
      return emitEnd(target, "interrupted", line.timestamp);
    }
    if (record.isToolResult) {
      // A result carrying a pending meta line's prompt id shows that line continued this turn.
      const latest = current();
      if (latest !== undefined && promptId !== undefined && promptId === pendingOpener?.promptId) {
        update({ ...latest, promptId });
        pendingOpener = null;
      }
      return continueWith(line, blocks);
    }
    // Claude Code's own output for a command or shell run shows no text and repeats its prompt id.
    const latest = current();
    const opensSegment =
      latest === undefined ||
      visible.text.length > 0 ||
      (promptId !== undefined && promptId !== latest.promptId);
    if (!opensSegment) return continueWith(line, blocks);
    const opened = open(
      line,
      promptId ?? null,
      prompt(visible, promptId, line.origin?.kind, false),
    );
    pushItems(opened.segmentId, line, "user", blocks);
    return opened;
  };

  const queued = (record: Extract<DecodedRecord, { kind: "queued" }>) => {
    const { line, blocks } = record;
    noteFork(line.forkedFrom);
    const queuedPrompt = prompt(
      record.visible,
      undefined,
      line.attachment.origin?.kind ??
        (line.attachment.commandMode === "task-notification" ? "task-notification" : undefined),
      line.attachment.isMeta === true,
    );
    const target = segmentFor(line.parentUuid);
    if (target !== undefined && target.endReason === null) {
      pendingOpener = null;
      events.push({
        _tag: "QueuedPrompt",
        segmentId: target.segmentId,
        id: itemId(line.uuid, undefined),
        lineUuid: line.uuid,
        timestamp: line.timestamp,
        prompt: queuedPrompt,
        blocks: blocks.map(({ block }) => block),
        forkedFrom: line.forkedFrom,
      });
      return target;
    }
    // Delivered after the turn ended, it starts the next one within the same prompt id.
    const opened = open(line, current()?.promptId ?? null, queuedPrompt);
    pushItems(opened.segmentId, line, "user", blocks);
    return opened;
  };

  const localCommand = (record: Extract<DecodedRecord, { kind: "localCommand" }>) => {
    const { line, blocks } = record;
    noteFork(line.forkedFrom);
    if (!isLocalCommandInput(line.content)) return continueWith(line, blocks);
    const latest = current();
    // A command chained into a reply that waits on a tool belongs to that turn, which carries on.
    if (
      latest !== undefined &&
      line.parentUuid !== null &&
      recentSegment.get(line.parentUuid) === latest.ordinal &&
      latest.endReason === null &&
      latest.lastAssistantUuid !== null
    ) {
      return continueWith(line, blocks);
    }
    const visible = claudeUserText(line.content);
    // Claude Code can record one command both as a user line and as this system record.
    if (latest?.segmentId === line.parentUuid && latest.openerText === visible.text) return latest;
    // A command sits outside the conversation, so its parent abandons nothing.
    const opened = open(line, null, prompt(visible, undefined, undefined, false), {
      branches: false,
      previousUuid: lastUuid,
    });
    pushItems(opened.segmentId, line, "user", blocks);
    // A command Claude Code runs itself has no reply to wait for.
    return emitEnd(opened, "turn-end", line.timestamp);
  };

  const apply = (
    header: typeof RecordHeader.Type,
    record: DecodedRecord,
  ): SegmentState | undefined => {
    switch (record.kind) {
      case "conversation":
        return conversation(record);
      case "queued":
        return queued(record);
      case "localCommand":
        return localCommand(record);
      case "turnDuration": {
        const target = segmentFor(header.parentUuid ?? null);
        if (target === undefined) return undefined;
        // Claude Code times interrupted turns too; the interrupt stays the reason.
        return emitEnd(
          target,
          target.endReason === "interrupted" ? "interrupted" : "turn-duration",
          record.line.timestamp,
          record.line.durationMs,
        );
      }
      case "compactBoundary":
        events.push({
          _tag: "CompactBoundary",
          segmentId: current()?.segmentId,
          lineUuid: record.line.uuid,
          logicalParentUuid: record.line.logicalParentUuid ?? null,
          trigger: record.line.compactMetadata.trigger,
          preTokens: record.line.compactMetadata.preTokens,
          timestamp: record.line.timestamp,
        });
        return current();
      case "event":
        if (record.event !== undefined) events.push(record.event);
        return undefined;
      case "ignored":
        return segmentFor(header.parentUuid ?? null);
    }
  };

  for (const line of input.lines) {
    if (line._tag === "Malformed") malformed.push(line.error);
    const header = line.header;
    if (header === undefined || header.isSidechain === true) continue;
    const uuid = header.uuid;
    if (uuid !== undefined && (consumedHere.has(uuid) || input.known.has(uuid))) continue;
    // A stepped-past line's uuid still parents the lines after it.
    const segment =
      line._tag === "Record" ? apply(header, line.record) : segmentFor(header.parentUuid ?? null);
    if (uuid === undefined) continue;
    consumedHere.add(uuid);
    consumedUuids.push(uuid);
    remember(uuid, segment?.ordinal);
  }
  return {
    state: { segments, nextOrdinal, recentUuids, lastUuid, pendingOpener, forkSessionId },
    events,
    malformed,
    consumedUuids,
  };
}

/** Decodes and folds lines in one step, for callers that look nothing up between the two. */
export function parseClaudeTranscriptLines(input: {
  readonly sessionId: string;
  readonly state: ClaudeTranscriptParserState;
  readonly lines: ReadonlyArray<ClaudeTranscriptLine>;
  readonly known: ReadonlySet<string>;
}): ClaudeTranscriptParseResult {
  return foldClaudeTranscriptLines({ ...input, lines: decodeClaudeTranscriptLines(input.lines) });
}
