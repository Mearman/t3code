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
});

// A meta line with a new prompt id opens a turn once a reply follows it.
const PendingOpener = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  promptId: Schema.String,
  text: Schema.String,
  titleText: Schema.String,
  originKind: Schema.NullOr(Schema.String),
  forkedFrom: Schema.NullOr(ForkSource),
});

/** What the parser carries between reads; serialisable so it persists with an offset. */
export const ClaudeTranscriptParserState = Schema.Struct({
  segment: Schema.NullOr(OpenSegment),
  lastUuid: Schema.NullOr(Schema.String),
  /** Every main-chain uuid since the open segment started, or since the file began. */
  segmentUuids: Schema.Array(Schema.String),
  openedSegmentIds: Schema.Array(Schema.String),
  pendingOpener: Schema.NullOr(PendingOpener),
  forkSessionId: Schema.NullOr(Schema.String),
});
export type ClaudeTranscriptParserState = typeof ClaudeTranscriptParserState.Type;

export const initialClaudeTranscriptParserState: ClaudeTranscriptParserState = {
  segment: null,
  lastUuid: null,
  segmentUuids: [],
  openedSegmentIds: [],
  pendingOpener: null,
  forkSessionId: null,
};

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
  promptId: Schema.optional(Schema.String),
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

export interface ClaudeTranscriptParseResult {
  readonly state: ClaudeTranscriptParserState;
  readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  /** Lines that could not be understood; each was stepped past without changing the state. */
  readonly malformed: ReadonlyArray<ClaudeTranscriptLineError>;
}

/**
 * Folds complete transcript lines, in file order, into segment events. Records of unknown types are skipped. A line that is not JSON, or a known record with a missing or wrongly typed field the parser reads, adds nothing and is reported in `malformed` with its byte offset.
 */
export function parseClaudeTranscriptLines(input: {
  readonly sessionId: string;
  readonly state: ClaudeTranscriptParserState;
  readonly lines: ReadonlyArray<ClaudeTranscriptLine>;
}): ClaudeTranscriptParseResult {
  let segment = input.state.segment;
  let lastUuid = input.state.lastUuid;
  let segmentUuids = [...input.state.segmentUuids];
  let segmentUuidSet = new Set(segmentUuids);
  const openedSegmentIds = [...input.state.openedSegmentIds];
  const openedSegmentIdSet = new Set(openedSegmentIds);
  let pendingOpener = input.state.pendingOpener;
  let forkSessionId = input.state.forkSessionId;
  const events: Array<ClaudeTranscriptEvent> = [];
  const malformed: Array<ClaudeTranscriptLineError> = [];

  const itemId = (lineUuid: string, index: number | undefined) =>
    claudeTranscriptItemId(input.sessionId, lineUuid, index);
  const seen = (uuid: string) => segmentUuidSet.has(uuid) || openedSegmentIdSet.has(uuid);

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

  const open = (
    opener: LineRef,
    promptId: string | null,
    prompt: ClaudeTranscriptPrompt | undefined,
  ) => {
    if (segment !== null && segment.endReason === null) emitEnd("next-prompt", opener.timestamp);
    // A parent inside the segment before this one follows it; an older one abandons it.
    if (segment !== null && opener.parentUuid !== null && !segmentUuidSet.has(opener.parentUuid)) {
      events.push({
        _tag: "Branch",
        lineUuid: opener.uuid,
        parentUuid: opener.parentUuid,
        previousUuid: lastUuid,
      });
    }
    const opened: typeof OpenSegment.Type = {
      segmentId: opener.uuid,
      promptId,
      endReason: null,
      lastAssistantUuid: null,
      openerText: prompt?.text ?? "",
    };
    segment = opened;
    segmentUuids = [];
    segmentUuidSet = new Set();
    openedSegmentIds.push(opener.uuid);
    openedSegmentIdSet.add(opener.uuid);
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
    visible: { readonly text: string; readonly titleText: string },
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

  const conversationLine = (entry: unknown) => {
    const line = decoded(decodeConversationLine(entry));
    const content = field(field(entry, "message"), "content");
    const blocks = checkedBlocks(content);
    if (line.isCompactSummary === true || seen(line.uuid)) return;
    noteFork(line.forkedFrom);
    if (line.type === "assistant") {
      const opener = pendingOpener;
      const current =
        opener !== null
          ? open(
              { ...opener, forkedFrom: opener.forkedFrom ?? undefined },
              opener.promptId,
              prompt(opener, opener.promptId, opener.originKind ?? undefined, true),
            )
          : (segment ?? open(line, null, undefined));
      pushItems(current.segmentId, line, "assistant", blocks, line.message);
      segment = { ...current, endReason: null, lastAssistantUuid: line.uuid };
      if (isClaudeTranscriptTurnEnd(entry)) emitEnd("turn-end", line.timestamp);
      return;
    }
    const visible = claudeUserText(blockText(blocks));
    if (line.isMeta === true) {
      if (line.promptId !== undefined && line.promptId !== segment?.promptId) {
        pendingOpener = {
          uuid: line.uuid,
          parentUuid: line.parentUuid,
          timestamp: line.timestamp,
          promptId: line.promptId,
          text: visible.text,
          titleText: visible.titleText,
          originKind: line.origin?.kind ?? null,
          forkedFrom: line.forkedFrom ?? null,
        };
      }
      return;
    }
    const isToolResult = blocks.some(
      ({ block }) => typeof field(block, "tool_use_id") === "string",
    );
    // The adapter's abort detection, applied to one message, recognises Claude's interrupt markers.
    const isInterrupt =
      claudeMessagesBeforeTrailingAborts([
        { type: "user", uuid: line.uuid, message: { content } },
      ]) === 0;
    if (isToolResult || isInterrupt) {
      // A result carrying a pending meta line's prompt id shows that line continued this turn.
      if (
        segment !== null &&
        line.promptId !== undefined &&
        line.promptId === pendingOpener?.promptId
      ) {
        segment = { ...segment, promptId: line.promptId };
        pendingOpener = null;
      }
      if (!isInterrupt) {
        continueWith(line, blocks);
        return;
      }
      const current = segment ?? open(line, null, undefined);
      pushItems(current.segmentId, line, "user", blocks);
      emitEnd("interrupted", line.timestamp);
      return;
    }
    // Claude Code's own output for a command or shell run shows no text and repeats its prompt id.
    const opensSegment =
      segment === null ||
      visible.text.length > 0 ||
      (line.promptId !== undefined && line.promptId !== segment.promptId);
    if (!opensSegment) {
      continueWith(line, blocks);
      return;
    }
    const opened = open(
      line,
      line.promptId ?? null,
      prompt(visible, line.promptId, line.origin?.kind, false),
    );
    pushItems(opened.segmentId, line, "user", blocks);
  };

  const queuedCommand = (entry: unknown) => {
    const line = decoded(decodeQueuedCommand(entry));
    const blocks = checkedBlocks(field(field(entry, "attachment"), "prompt"));
    if (seen(line.uuid)) return;
    noteFork(line.forkedFrom);
    const queued = prompt(
      claudeUserText(blockText(blocks)),
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
        prompt: queued,
        blocks: blocks.map(({ block }) => block),
      });
      return;
    }
    // Delivered after the turn ended, it starts the next one within the same prompt id.
    const opened = open(line, segment?.promptId ?? null, queued);
    pushItems(opened.segmentId, line, "user", blocks);
  };

  const localCommand = (entry: unknown) => {
    const line = decoded(decodeLocalCommand(entry));
    if (seen(line.uuid)) return;
    noteFork(line.forkedFrom);
    const blocks = checkedBlocks(line.content);
    if (!isLocalCommandInput(line.content)) {
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

  const system = (entry: unknown) => {
    const subtype = field(entry, "subtype");
    if (subtype === "turn_duration") {
      const line = decoded(decodeTurnDuration(entry));
      // Claude Code times interrupted turns too; the interrupt stays the reason.
      emitEnd(
        segment?.endReason === "interrupted" ? "interrupted" : "turn-duration",
        line.timestamp,
        line.durationMs,
      );
    } else if (subtype === "local_command") {
      localCommand(entry);
    } else if (subtype === "compact_boundary") {
      const line = decoded(decodeCompactBoundary(entry));
      events.push({
        _tag: "CompactBoundary",
        segmentId: segment?.segmentId,
        lineUuid: line.uuid,
        logicalParentUuid: line.logicalParentUuid ?? null,
        trigger: line.compactMetadata.trigger,
        preTokens: line.compactMetadata.preTokens,
        timestamp: line.timestamp,
      });
    }
  };

  const record = (entry: unknown) => {
    const header = decoded(decodeRecordHeader(entry));
    if (header.isSidechain === true) return;
    switch (header.type) {
      case "user":
      case "assistant":
        conversationLine(entry);
        break;
      case "attachment":
        if (field(field(entry, "attachment"), "type") === "queued_command") queuedCommand(entry);
        break;
      case "system":
        system(entry);
        break;
      case "ai-title": {
        const title = claudeTitle(decoded(decodeAiTitle(entry)).aiTitle);
        if (title !== undefined) events.push({ _tag: "Title", source: "ai", title });
        break;
      }
      case "custom-title":
        events.push({
          _tag: "Title",
          source: "custom",
          title: claudeTitle(decoded(decodeCustomTitle(entry)).customTitle) ?? null,
        });
        break;
      case "derived-from":
        events.push({
          _tag: "DerivedFrom",
          sessions: decoded(decodeDerivedFrom(entry)).sessions.map((session) => ({
            sessionId: session.id,
            via: session.via,
          })),
        });
        break;
    }
    if (header.uuid !== undefined) {
      lastUuid = header.uuid;
      if (!segmentUuidSet.has(header.uuid)) {
        segmentUuids.push(header.uuid);
        segmentUuidSet.add(header.uuid);
      }
    }
  };

  for (const line of input.lines) {
    if (line.text.trim().length === 0) continue;
    const before = {
      segment,
      lastUuid,
      segmentUuids,
      segmentUuidCount: segmentUuids.length,
      openedCount: openedSegmentIds.length,
      pendingOpener,
      forkSessionId,
      eventCount: events.length,
    };
    try {
      record(decoded(decodeJson(line.text)));
    } catch (error) {
      if (!(error instanceof MalformedLine)) throw error;
      // Undo what the line changed: the arrays only grew, or were replaced by new ones.
      segment = before.segment;
      lastUuid = before.lastUuid;
      segmentUuids = before.segmentUuids;
      segmentUuids.length = before.segmentUuidCount;
      segmentUuidSet = new Set(segmentUuids);
      for (const id of openedSegmentIds.splice(before.openedCount)) openedSegmentIdSet.delete(id);
      pendingOpener = before.pendingOpener;
      forkSessionId = before.forkSessionId;
      events.length = before.eventCount;
      malformed.push(new ClaudeTranscriptLineError({ offset: line.offset, cause: error.cause }));
    }
  }
  return {
    state: { segment, lastUuid, segmentUuids, openedSegmentIds, pendingOpener, forkSessionId },
    events,
    malformed,
  };
}
