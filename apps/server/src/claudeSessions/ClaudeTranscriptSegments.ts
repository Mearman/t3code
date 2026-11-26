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

const OpenSegment = Schema.Struct({
  segmentId: Schema.String,
  /** The turn's prompt id, which the output Claude Code writes for the turn repeats. */
  promptId: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(EndReason),
  lastAssistantUuid: Schema.NullOr(Schema.String),
  openerText: Schema.String,
  startedAt: Schema.String,
});

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

/** What the parser carries between reads; serialisable, and bounded so it persists cheaply. */
export const ClaudeTranscriptParserState = Schema.Struct({
  segment: Schema.NullOr(OpenSegment),
  lastUuid: Schema.NullOr(Schema.String),
  /** The latest main-chain uuids since the open segment started, at most `RECENT_UUID_LIMIT`. */
  recentUuids: Schema.Array(Schema.String),
  pendingOpener: Schema.NullOr(PendingOpener),
  forkSessionId: Schema.NullOr(Schema.String),
});
export type ClaudeTranscriptParserState = typeof ClaudeTranscriptParserState.Type;

export const initialClaudeTranscriptParserState: ClaudeTranscriptParserState = {
  segment: null,
  lastUuid: null,
  recentUuids: [],
  pendingOpener: null,
  forkSessionId: null,
};

// Parents and repeats sit a few records back; this bounds the stored state of a long turn.
const RECENT_UUID_LIMIT = 512;

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

export interface ClaudeTranscriptParseResult {
  readonly state: ClaudeTranscriptParserState;
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  /** Lines that could not be understood; each was stepped past, its uuid kept as a parent. */
  readonly malformed: ReadonlyArray<ClaudeTranscriptLineError>;
}

/**
 * Folds complete transcript lines, in file order, into segment events. Records of unknown types are skipped. A line that is not JSON, or a known record with a missing or wrongly typed field the parser reads, adds no events and is reported in `malformed` with its byte offset.
 *
 * Claude Code can write earlier lines again, unchanged, after compacting. A line timestamped before the open segment started whose parent is outside that segment is such a replay and is skipped. The parser does not remember every uuid; consumers dedupe by the stable item ids.
 */
export function parseClaudeTranscriptLines(input: {
  readonly sessionId: string;
  readonly state: ClaudeTranscriptParserState;
  readonly lines: ReadonlyArray<ClaudeTranscriptLine>;
}): ClaudeTranscriptParseResult {
  let segment = input.state.segment;
  let lastUuid = input.state.lastUuid;
  let recentUuids = [...input.state.recentUuids];
  let recentUuidSet = new Set(recentUuids);
  let pendingOpener = input.state.pendingOpener;
  let forkSessionId = input.state.forkSessionId;
  const events: Array<ClaudeTranscriptEvent> = [];
  const malformed: Array<ClaudeTranscriptLineError> = [];

  const itemId = (lineUuid: string, index: number | undefined) =>
    claudeTranscriptItemId(input.sessionId, lineUuid, index);

  const remember = (uuid: string) => {
    lastUuid = uuid;
    if (recentUuidSet.has(uuid)) return;
    recentUuids.push(uuid);
    recentUuidSet.add(uuid);
    const evicted = recentUuids.length > RECENT_UUID_LIMIT ? recentUuids.shift() : undefined;
    if (evicted !== undefined) recentUuidSet.delete(evicted);
  };

  const isReplay = (header: typeof RecordHeader.Type) => {
    if (segment === null || header.timestamp === undefined) return false;
    const at = Date.parse(header.timestamp);
    const startedAt = Date.parse(segment.startedAt);
    const parent = header.parentUuid ?? null;
    return at < startedAt && (parent === null || !recentUuidSet.has(parent));
  };

  const emitEnd = (reason: ClaudeTranscriptEndReason, timestamp: string, durationMs?: number) => {
    if (segment === null) return;
    segment = { ...segment, endReason: reason };
    events.push({
      _tag: "SegmentEnded",
      segmentId: segment.segmentId,
      reason,
      lastAssistantUuid: segment.lastAssistantUuid ?? undefined,
      timestamp,
      durationMs,
    });
  };

  const noteFork = (forkedFrom: ClaudeTranscriptForkSource | undefined) => {
    if (forkedFrom === undefined || forkedFrom.sessionId === forkSessionId) return;
    forkSessionId = forkedFrom.sessionId;
    events.push({ _tag: "ForkedFrom", ...forkedFrom });
  };

  // A parent inside the open segment follows it; any other abandons it.
  const branchesFrom = (parentUuid: string | null) =>
    segment !== null && parentUuid !== null && !recentUuidSet.has(parentUuid);

  const open = (
    opener: LineRef,
    promptId: string | null,
    prompt: ClaudeTranscriptPrompt | undefined,
    branch: { readonly branches: boolean; readonly previousUuid: string | null } = {
      branches: branchesFrom(opener.parentUuid),
      previousUuid: lastUuid,
    },
  ) => {
    if (segment !== null && segment.endReason === null) emitEnd("next-prompt", opener.timestamp);
    if (branch.branches && opener.parentUuid !== null) {
      events.push({
        _tag: "Branch",
        lineUuid: opener.uuid,
        parentUuid: opener.parentUuid,
        previousUuid: branch.previousUuid,
      });
    }
    const opened: typeof OpenSegment.Type = {
      segmentId: opener.uuid,
      promptId,
      endReason: null,
      lastAssistantUuid: null,
      openerText: prompt?.text ?? "",
      startedAt: opener.timestamp,
    };
    segment = opened;
    recentUuids = [opener.uuid];
    recentUuidSet = new Set(recentUuids);
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
    const current = segment ?? open(line, null, undefined);
    pushItems(current.segmentId, line, "user", blocks);
    if (current.endReason !== null) emitEnd(current.endReason, line.timestamp);
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

  const conversation = (record: Extract<DecodedRecord, { kind: "conversation" }>) => {
    const { line, blocks, visible } = record;
    const promptId = line.promptId ?? undefined;
    if (line.isCompactSummary === true) return;
    noteFork(line.forkedFrom);
    if (line.type === "assistant") {
      const current =
        pendingOpener !== null
          ? openPending(pendingOpener)
          : (segment ?? open(line, null, undefined));
      pushItems(current.segmentId, line, "assistant", blocks, line.message);
      segment = { ...current, endReason: null, lastAssistantUuid: line.uuid };
      if (isClaudeTranscriptTurnEnd(record.entry)) emitEnd("turn-end", line.timestamp);
      return;
    }
    if (line.isMeta === true) {
      // Claude Code can follow a turn's opening meta line with more; the first one opens it.
      if (
        promptId !== undefined &&
        promptId !== segment?.promptId &&
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
      return;
    }
    if (record.isInterrupt) {
      const opener = pendingOpener;
      const current =
        opener !== null && promptId === opener.promptId
          ? openPending(opener)
          : (segment ?? open(line, null, undefined));
      pushItems(current.segmentId, line, "user", blocks);
      emitEnd("interrupted", line.timestamp);
      return;
    }
    if (record.isToolResult) {
      // A result carrying a pending meta line's prompt id shows that line continued this turn.
      if (segment !== null && promptId !== undefined && promptId === pendingOpener?.promptId) {
        segment = { ...segment, promptId };
        pendingOpener = null;
      }
      continueWith(line, blocks);
      return;
    }
    // Claude Code's own output for a command or shell run shows no text and repeats its prompt id.
    const opensSegment =
      segment === null ||
      visible.text.length > 0 ||
      (promptId !== undefined && promptId !== segment.promptId);
    if (!opensSegment) {
      continueWith(line, blocks);
      return;
    }
    const opened = open(
      line,
      promptId ?? null,
      prompt(visible, promptId, line.origin?.kind, false),
    );
    pushItems(opened.segmentId, line, "user", blocks);
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
    if (segment !== null && segment.endReason === null) {
      pendingOpener = null;
      events.push({
        _tag: "QueuedPrompt",
        segmentId: segment.segmentId,
        id: itemId(line.uuid, undefined),
        lineUuid: line.uuid,
        timestamp: line.timestamp,
        prompt: queuedPrompt,
        blocks: blocks.map(({ block }) => block),
        forkedFrom: line.forkedFrom,
      });
      return;
    }
    // Delivered after the turn ended, it starts the next one within the same prompt id.
    const opened = open(line, segment?.promptId ?? null, queuedPrompt);
    pushItems(opened.segmentId, line, "user", blocks);
  };

  const localCommand = (record: Extract<DecodedRecord, { kind: "localCommand" }>) => {
    const { line, blocks } = record;
    noteFork(line.forkedFrom);
    // A command run while a reply waits on a tool belongs to that turn, which carries on after it.
    const running =
      segment !== null && segment.endReason === null && segment.lastAssistantUuid !== null;
    if (!isLocalCommandInput(line.content) || running) {
      continueWith(line, blocks);
      return;
    }
    const visible = claudeUserText(line.content);
    // Claude Code can record one command both as a user line and as this system record.
    if (segment?.segmentId === line.parentUuid && segment.openerText === visible.text) return;
    const opened = open(line, null, prompt(visible, undefined, undefined, false));
    pushItems(opened.segmentId, line, "user", blocks);
    // A command Claude Code runs itself has no reply to wait for.
    emitEnd("turn-end", line.timestamp);
  };

  const apply = (record: DecodedRecord) => {
    switch (record.kind) {
      case "conversation":
        conversation(record);
        return;
      case "queued":
        queued(record);
        return;
      case "localCommand":
        localCommand(record);
        return;
      case "turnDuration":
        // Claude Code times interrupted turns too; the interrupt stays the reason.
        emitEnd(
          segment?.endReason === "interrupted" ? "interrupted" : "turn-duration",
          record.line.timestamp,
          record.line.durationMs,
        );
        return;
      case "compactBoundary":
        events.push({
          _tag: "CompactBoundary",
          segmentId: segment?.segmentId,
          lineUuid: record.line.uuid,
          logicalParentUuid: record.line.logicalParentUuid ?? null,
          trigger: record.line.compactMetadata.trigger,
          preTokens: record.line.compactMetadata.preTokens,
          timestamp: record.line.timestamp,
        });
        return;
      case "event":
        if (record.event !== undefined) events.push(record.event);
        return;
      case "ignored":
        return;
    }
  };

  for (const line of input.lines) {
    if (line.text.trim().length === 0) continue;
    // Decoding throws before any state changes, so a bad line leaves nothing half applied.
    const head = attempt(() => {
      const entry = decoded(decodeJson(line.text));
      return { entry, header: decoded(decodeRecordHeader(entry)) };
    });
    if (head instanceof MalformedLine) {
      malformed.push(new ClaudeTranscriptLineError({ offset: line.offset, cause: head.cause }));
      continue;
    }
    const { entry, header } = head;
    if (header.isSidechain === true) continue;
    if (header.uuid !== undefined && (recentUuidSet.has(header.uuid) || isReplay(header))) continue;
    const record = attempt(() => decodeBody(header.type, entry));
    if (record instanceof MalformedLine) {
      malformed.push(new ClaudeTranscriptLineError({ offset: line.offset, cause: record.cause }));
    } else {
      apply(record);
    }
    // A stepped-past line's uuid still parents the lines after it.
    if (header.uuid !== undefined) remember(header.uuid);
  }
  return {
    state: { segment, lastUuid, recentUuids, pendingOpener, forkSessionId },
    events,
    malformed,
  };
}
