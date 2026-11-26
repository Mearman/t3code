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

/** One stream of a command's output, as Claude Code wrapped it in the transcript. */
export interface ClaudeTranscriptCommandOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

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

/**
 * What a read of a transcript reports, in file order. `Item`, `QueuedPrompt` and `SegmentEnded`
 * name the segment their line continues, which can be an earlier one than the latest: Claude Code
 * keeps writing a turn after a newer prompt starts.
 */
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
      /** A segment that starts from a line before the latest segment, not after it; both can go on. */
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
  | {
      /** Output Claude Code printed for a slash command or shell run, without its markup. */
      readonly _tag: "CommandOutput";
      readonly segmentId: string;
      /** `x:<sessionId>:<lineUuid>`. */
      readonly id: string;
      readonly lineUuid: string;
      readonly timestamp: string;
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput>;
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
  startedAt: Schema.String,
  endReason: Schema.NullOr(EndReason),
  durationMs: Schema.NullOr(Schema.Number),
  lastAssistantUuid: Schema.NullOr(Schema.String),
  /** The latest reply stopped for a tool, so the turn goes on when its result arrives. */
  awaitingTool: Schema.Boolean,
});
type SegmentState = typeof SegmentState.Type;

// A meta line with a new prompt id opens a turn once a line descending from it follows.
const PendingOpener = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  promptId: Schema.String,
  text: Schema.String,
  titleText: Schema.String,
  originKind: Schema.NullOr(Schema.String),
  forkedFrom: Schema.NullOr(ForkSource),
  /** The line before the opener, and whether the opener's parent is outside the latest segment. */
  previousUuid: Schema.NullOr(Schema.String),
  branches: Schema.Boolean,
});

/**
 * What the parser carries between reads; serialisable and bounded. Whether a uuid was read before
 * is not kept here: the consumer stores each read's `consumedUuids` and names them in `known`.
 */
export const ClaudeTranscriptParserState = Schema.Struct({
  /** Segments a recent uuid still names, and the latest, oldest first. */
  segments: Schema.Array(SegmentState),
  /** The next segment's ordinal; a pending meta opener's lines are already filed under it. */
  nextOrdinal: Schema.Number,
  /**
   * The latest main-chain uuids, oldest first, with their segment's ordinal, their parent, and
   * whether that parent was yet to be read, so its arrival can refile them.
   */
  recentUuids: Schema.Array(
    Schema.Tuple([Schema.String, Schema.Number, Schema.NullOr(Schema.String), Schema.Boolean]),
  ),
  lastUuid: Schema.NullOr(Schema.String),
  /** What the latest segment's prompt showed, to spot a command Claude Code records twice. */
  latestOpenerText: Schema.String,
  pendingOpener: Schema.NullOr(PendingOpener),
  forkSessionId: Schema.NullOr(Schema.String),
});
export type ClaudeTranscriptParserState = typeof ClaudeTranscriptParserState.Type;

export const initialClaudeTranscriptParserState: ClaudeTranscriptParserState = {
  segments: [],
  nextOrdinal: 0,
  recentUuids: [],
  lastUuid: null,
  latestOpenerText: "",
  pendingOpener: null,
  forkSessionId: null,
};

// Bounds the stored state. A parent further back, or written after its child, is not found, and
// its line joins the latest segment.
const RECENT_UUID_LIMIT = 512;

// Claude Code's model name for the reply it writes itself, such as after an interrupt.
const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

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

const COMMAND_OUTPUT_BLOCK =
  /<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>([\s\S]*?)<\/\1>\s*/y;

/** The streams of a line that is only command output, or undefined for any other text. */
function commandOutputOf(
  blocks: ReadonlyArray<IndexedBlock>,
): ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined {
  if (blocks.length === 0 || blocks.some(({ block }) => block.type !== "text")) return undefined;
  const text = blockText(blocks);
  const output: Array<ClaudeTranscriptCommandOutput> = [];
  COMMAND_OUTPUT_BLOCK.lastIndex = 0;
  let end = 0;
  for (
    let match = COMMAND_OUTPUT_BLOCK.exec(text);
    match !== null;
    match = COMMAND_OUTPUT_BLOCK.exec(text)
  ) {
    output.push({
      stream: match[1]?.endsWith("stderr") ? "stderr" : "stdout",
      text: match[2] ?? "",
    });
    end = COMMAND_OUTPUT_BLOCK.lastIndex;
  }
  return output.length > 0 && end === text.length ? output : undefined;
}

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
      readonly isTurnEnd: boolean;
      readonly blocks: ReadonlyArray<IndexedBlock>;
      readonly visible: Visible;
      readonly isToolResult: boolean;
      readonly isInterrupt: boolean;
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined;
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
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined;
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
        isTurnEnd: isClaudeTranscriptTurnEnd(entry),
        blocks,
        visible: claudeUserText(blockText(blocks)),
        isToolResult: blocks.some(({ block }) => typeof field(block, "tool_use_id") === "string"),
        // The adapter's abort detection, on one message, recognises Claude's interrupt markers.
        isInterrupt:
          line.type === "user" &&
          claudeMessagesBeforeTrailingAborts([
            { type: "user", uuid: line.uuid, message: { content } },
          ]) === 0,
        output: line.type === "user" ? commandOutputOf(blocks) : undefined,
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
        const blocks = checkedBlocks(line.content);
        return { kind: "localCommand", line, blocks, output: commandOutputOf(blocks) };
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
  /**
   * The uuids whose lines this fold read, malformed ones excepted. Store them in the same commit
   * as the events and the new state, never before, or a failed commit loses those lines for good.
   */
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
  const recentUuids = input.state.recentUuids.map(([uuid, ordinal, parentUuid, parentUnread]) => ({
    uuid,
    ordinal,
    parentUuid,
    parentUnread,
  }));
  const recentEntry = new Map(recentUuids.map((entry) => [entry.uuid, entry]));
  let lastUuid = input.state.lastUuid;
  let latestOpenerText = input.state.latestOpenerText;
  let pendingOpener = input.state.pendingOpener;
  let forkSessionId = input.state.forkSessionId;
  const events: Array<ClaudeTranscriptEvent> = [];
  const malformed: Array<ClaudeTranscriptLineError> = [];
  const consumedUuids: Array<string> = [];
  const consumedHere = new Set<string>();

  const itemId = (lineUuid: string, index: number | undefined) =>
    claudeTranscriptItemId(input.sessionId, lineUuid, index);
  const current = () => segments.at(-1);
  const isLatest = (segment: SegmentState) => segment.ordinal === current()?.ordinal;
  const byOrdinal = (ordinal: number) => segments.find((segment) => segment.ordinal === ordinal);
  const update = (next: SegmentState) => {
    const index = segments.findIndex((segment) => segment.ordinal === next.ordinal);
    segments[index] = next;
    return next;
  };
  const parentOrdinal = (parentUuid: string | null) =>
    parentUuid === null ? undefined : recentEntry.get(parentUuid)?.ordinal;

  // Keeps every segment a recent uuid names, so a parent in the window never resolves elsewhere.
  const pruneSegments = () => {
    const named = new Set(recentUuids.map((entry) => entry.ordinal));
    const latest = current();
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment !== undefined && segment !== latest && !named.has(segment.ordinal)) {
        segments.splice(index, 1);
      }
    }
  };

  // Lines read before their parent took the latest segment; once the parent is read, they and
  // the lines that inherited their segment take the parent's instead.
  let awaitedParents = new Set(
    recentUuids.flatMap((entry) =>
      entry.parentUnread && entry.parentUuid !== null ? [entry.parentUuid] : [],
    ),
  );
  const refileChildren = (uuid: string, ordinal: number) => {
    const previous = new Map<string, number>();
    for (const entry of recentUuids) {
      if (entry.parentUuid === null || entry.uuid === uuid) continue;
      const direct = entry.parentUuid === uuid && entry.parentUnread;
      const inherited = previous.get(entry.parentUuid) === entry.ordinal;
      if (!direct && !inherited) continue;
      previous.set(entry.uuid, entry.ordinal);
      entry.ordinal = ordinal;
      entry.parentUnread = false;
    }
    awaitedParents = new Set(
      recentUuids.flatMap((entry) =>
        entry.parentUnread && entry.parentUuid !== null ? [entry.parentUuid] : [],
      ),
    );
  };

  const remember = (
    uuid: string,
    ordinal: number | undefined,
    parentUuid: string | null,
    parentUnread: boolean,
  ) => {
    lastUuid = uuid;
    if (ordinal === undefined || recentEntry.has(uuid)) return;
    const entry = { uuid, ordinal, parentUuid, parentUnread };
    recentUuids.push(entry);
    recentEntry.set(uuid, entry);
    const evicted = recentUuids.length > RECENT_UUID_LIMIT ? recentUuids.shift() : undefined;
    if (evicted !== undefined) recentEntry.delete(evicted.uuid);
    if (parentUnread && parentUuid !== null) awaitedParents.add(parentUuid);
    if (awaitedParents.has(uuid)) refileChildren(uuid, ordinal);
  };

  // The segment a line continues: its parent's when that is recent, else the latest one.
  const segmentFor = (parentUuid: string | null) => {
    const ordinal = parentOrdinal(parentUuid);
    const parentSegment = ordinal === undefined ? undefined : byOrdinal(ordinal);
    return parentSegment ?? current();
  };

  // A parent read before that is not in the latest segment: the new segment starts from it.
  const branchesFrom = (parentUuid: string | null) => {
    const latest = current();
    if (latest === undefined || parentUuid === null) return false;
    const ordinal = recentEntry.get(parentUuid)?.ordinal;
    if (ordinal !== undefined) return ordinal !== latest.ordinal;
    return input.known.has(parentUuid) || consumedHere.has(parentUuid);
  };

  // A pending meta opener's lines are filed under the ordinal its segment will take.
  const discardPending = () => {
    if (pendingOpener === null) return;
    pendingOpener = null;
    nextOrdinal += 1;
  };

  const emitEnd = (
    segment: SegmentState,
    reason: ClaudeTranscriptEndReason,
    timestamp: string,
    durationMs: number | null = segment.endReason === reason ? segment.durationMs : null,
  ) => {
    const ended = update({ ...segment, endReason: reason, durationMs });
    // Claude Code can write a turn's later lines with earlier timestamps than its prompt.
    const at = Date.parse(timestamp) < Date.parse(ended.startedAt) ? ended.startedAt : timestamp;
    events.push({
      _tag: "SegmentEnded",
      segmentId: ended.segmentId,
      reason,
      lastAssistantUuid: ended.lastAssistantUuid ?? undefined,
      timestamp: at,
      durationMs: durationMs ?? undefined,
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
    fromPending = false,
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
    if (!fromPending) discardPending();
    const opened: SegmentState = {
      ordinal: nextOrdinal,
      segmentId: opener.uuid,
      promptId,
      startedAt: opener.timestamp,
      endReason: null,
      durationMs: null,
      lastAssistantUuid: null,
      awaitingTool: false,
    };
    nextOrdinal += 1;
    pendingOpener = null;
    segments.push(opened);
    latestOpenerText = prompt?.text ?? "";
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
  const continueWith = (
    line: LineRef,
    blocks: ReadonlyArray<IndexedBlock>,
    output?: ReadonlyArray<ClaudeTranscriptCommandOutput>,
  ) => {
    const target = segmentFor(line.parentUuid) ?? open(line, null, undefined);
    if (output === undefined) {
      pushItems(target.segmentId, line, "user", blocks);
    } else {
      events.push({
        _tag: "CommandOutput",
        segmentId: target.segmentId,
        id: itemId(line.uuid, undefined),
        lineUuid: line.uuid,
        timestamp: line.timestamp,
        output,
      });
    }
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
      true,
    );

  // A line opens the pending meta-opened turn when it descends from the opener, or when its
  // parent is unknown, as where compaction breaks the chain.
  const takesPending = (parentUuid: string | null) => {
    if (pendingOpener === null) return false;
    const ordinal = parentOrdinal(parentUuid);
    return ordinal === undefined || ordinal === nextOrdinal;
  };

  // Ended only by a newer prompt while waiting on a tool, the turn is still running.
  const isRunning = (segment: SegmentState) =>
    segment.endReason === null || (segment.endReason === "next-prompt" && segment.awaitingTool);

  const conversation = (record: Extract<DecodedRecord, { kind: "conversation" }>) => {
    const { line, blocks, visible } = record;
    const promptId = line.promptId ?? undefined;
    if (line.isCompactSummary === true) return parentOrdinal(line.parentUuid) ?? current()?.ordinal;
    noteFork(line.forkedFrom);
    if (line.type === "assistant") {
      const target =
        pendingOpener !== null && takesPending(line.parentUuid)
          ? openPending(pendingOpener)
          : (segmentFor(line.parentUuid) ?? open(line, null, undefined));
      pushItems(target.segmentId, line, "assistant", blocks, line.message);
      // Claude Code's own reply after an interrupt leaves the turn interrupted.
      if (line.message.model === CLAUDE_SYNTHETIC_MODEL && target.endReason === "interrupted") {
        return emitEnd(target, "interrupted", line.timestamp).ordinal;
      }
      // A late line of a superseded turn keeps its end; the latest turn is running again.
      const endReason = record.isTurnEnd ? "turn-end" : isLatest(target) ? null : target.endReason;
      const replied = update({
        ...target,
        endReason: null,
        lastAssistantUuid: line.uuid,
        awaitingTool: line.message.stop_reason === "tool_use",
      });
      return endReason === null
        ? replied.ordinal
        : emitEnd(
            replied,
            endReason,
            line.timestamp,
            endReason === target.endReason ? target.durationMs : null,
          ).ordinal;
    }
    if (line.isMeta === true) {
      // Claude Code can follow a turn's opening meta line with more; the first one opens it.
      const latest = current();
      if (
        promptId !== undefined &&
        promptId !== latest?.promptId &&
        promptId !== pendingOpener?.promptId
      ) {
        discardPending();
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
        return nextOrdinal;
      }
      return parentOrdinal(line.parentUuid) ?? current()?.ordinal;
    }
    if (record.isInterrupt) {
      const opener = pendingOpener;
      const target =
        opener !== null && promptId === opener.promptId && takesPending(line.parentUuid)
          ? openPending(opener)
          : (segmentFor(line.parentUuid) ?? open(line, null, undefined));
      pushItems(target.segmentId, line, "user", blocks);
      return emitEnd(update({ ...target, awaitingTool: false }), "interrupted", line.timestamp)
        .ordinal;
    }
    if (record.isToolResult) {
      const target = segmentFor(line.parentUuid) ?? open(line, null, undefined);
      // A result carrying a pending meta line's prompt id shows that line continued this turn.
      if (promptId !== undefined && promptId === pendingOpener?.promptId) {
        update({ ...target, promptId });
        discardPending();
      }
      return continueWith(line, blocks).ordinal;
    }
    // Claude Code writes a command's or shell run's output itself; it continues what ran it.
    if (record.output !== undefined) return continueWith(line, blocks, record.output).ordinal;
    // Other lines Claude Code writes show no text and repeat their turn's prompt id.
    const latest = current();
    const opensSegment =
      latest === undefined ||
      visible.text.length > 0 ||
      (promptId !== undefined && promptId !== latest.promptId);
    if (!opensSegment) return continueWith(line, blocks).ordinal;
    const opened = open(
      line,
      promptId ?? null,
      prompt(visible, promptId, line.origin?.kind, false),
    );
    pushItems(opened.segmentId, line, "user", blocks);
    return opened.ordinal;
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
    if (target !== undefined && isRunning(target)) {
      discardPending();
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
      return target.ordinal;
    }
    // Delivered after the turn ended, it starts the next one within the same prompt id.
    const opened = open(line, current()?.promptId ?? null, queuedPrompt);
    pushItems(opened.segmentId, line, "user", blocks);
    return opened.ordinal;
  };

  const localCommand = (record: Extract<DecodedRecord, { kind: "localCommand" }>) => {
    const { line, blocks } = record;
    noteFork(line.forkedFrom);
    if (!isLocalCommandInput(line.content))
      return continueWith(line, blocks, record.output).ordinal;
    // A command chained to the reply a turn's tool call waits on belongs to it, and it carries on.
    const target = segmentFor(line.parentUuid);
    if (
      target !== undefined &&
      line.parentUuid === target.lastAssistantUuid &&
      target.awaitingTool &&
      isRunning(target)
    ) {
      return continueWith(line, blocks).ordinal;
    }
    const visible = claudeUserText(line.content);
    const latest = current();
    // Claude Code can record one command both as a user line and as this system record.
    if (latest?.segmentId === line.parentUuid && latestOpenerText === visible.text) {
      return latest.ordinal;
    }
    // A command sits outside the conversation, so its parent starts no branch.
    const opened = open(line, null, prompt(visible, undefined, undefined, false), {
      branches: false,
      previousUuid: lastUuid,
    });
    pushItems(opened.segmentId, line, "user", blocks);
    // A command Claude Code runs itself has no reply to wait for.
    return emitEnd(opened, "turn-end", line.timestamp).ordinal;
  };

  // Returns the ordinal of the segment the line is filed under, for its children to follow.
  const apply = (header: typeof RecordHeader.Type, record: DecodedRecord): number | undefined => {
    const parentUuid = header.parentUuid ?? null;
    switch (record.kind) {
      case "conversation":
        return conversation(record);
      case "queued":
        return queued(record);
      case "localCommand":
        return localCommand(record);
      case "turnDuration": {
        const target = segmentFor(parentUuid);
        if (target === undefined) return undefined;
        // Claude Code times interrupted turns too; the interrupt stays the reason.
        const reason = target.endReason === "interrupted" ? "interrupted" : "turn-duration";
        const ended = emitEnd(
          update({ ...target, awaitingTool: false }),
          reason,
          record.line.timestamp,
          reason === "turn-duration" ? record.line.durationMs : target.durationMs,
        );
        return ended.ordinal;
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
        return current()?.ordinal;
      case "event":
        if (record.event !== undefined) events.push(record.event);
        return undefined;
      case "ignored":
        return parentOrdinal(parentUuid) ?? current()?.ordinal;
    }
  };

  for (const line of input.lines) {
    if (line._tag === "Malformed") malformed.push(line.error);
    const header = line.header;
    if (header === undefined || header.isSidechain === true) continue;
    const uuid = header.uuid;
    if (uuid !== undefined && (consumedHere.has(uuid) || input.known.has(uuid))) continue;
    const parentUuid = header.parentUuid ?? null;
    const parentUnread =
      parentUuid !== null &&
      parentOrdinal(parentUuid) === undefined &&
      !consumedHere.has(parentUuid) &&
      !input.known.has(parentUuid);
    // A stepped-past line still parents the lines after it, but a good copy of it is read later.
    if (line._tag === "Malformed") {
      if (uuid !== undefined) {
        remember(uuid, parentOrdinal(parentUuid) ?? current()?.ordinal, parentUuid, parentUnread);
      }
      continue;
    }
    const ordinal = apply(header, line.record);
    if (uuid === undefined) continue;
    consumedHere.add(uuid);
    consumedUuids.push(uuid);
    remember(uuid, ordinal, parentUuid, parentUnread);
  }
  pruneSegments();
  return {
    state: {
      segments,
      nextOrdinal,
      recentUuids: recentUuids.map(
        (entry) => [entry.uuid, entry.ordinal, entry.parentUuid, entry.parentUnread] as const,
      ),
      lastUuid,
      latestOpenerText,
      pendingOpener,
      forkSessionId,
    },
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
