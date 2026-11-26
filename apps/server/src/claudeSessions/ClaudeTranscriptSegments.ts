import type { SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  claudeMessagesBeforeTrailingAborts,
  isClaudeTranscriptConversationLine,
  isClaudeTranscriptTurnEnd,
  isClaudeUserToolResultContentBlock,
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
}

export interface ClaudeTranscriptPrompt {
  /** What the user typed, as `claudeUserText` shows it; empty for prompts Claude Code wrote. */
  readonly text: string;
  readonly title: string | undefined;
  readonly promptId: string | undefined;
  /** Claude Code's `origin.kind`, such as `human` or `task-notification`, when recorded. */
  readonly originKind: string | undefined;
}

export type ClaudeTranscriptEndReason =
  | "turn-end"
  | "turn-duration"
  | "interrupted"
  | "next-prompt";

export type ClaudeTranscriptEvent =
  | {
      readonly _tag: "SegmentStarted";
      /** The uuid of the line that opened the segment. */
      readonly segmentId: string;
      readonly parentUuid: string | null;
      readonly timestamp: string;
      /** Undefined when content arrived with no prompt before it, such as a file cut mid-turn. */
      readonly prompt: ClaudeTranscriptPrompt | undefined;
    }
  | { readonly _tag: "Item"; readonly segmentId: string; readonly item: ClaudeTranscriptItem }
  | {
      /** Repeated when more content extends an ended segment; the latest one holds. */
      readonly _tag: "SegmentEnded";
      readonly segmentId: string;
      readonly reason: ClaudeTranscriptEndReason;
      readonly lastAssistantUuid: string | undefined;
      readonly timestamp: string;
      readonly durationMs: number | undefined;
    }
  | {
      /** A prompt or reply whose parent is not the line before it: a rewind or a second writer. */
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
    };

const OpenSegment = Schema.Struct({
  segmentId: Schema.String,
  promptId: Schema.NullOr(Schema.String),
  ended: Schema.Boolean,
  lastAssistantUuid: Schema.NullOr(Schema.String),
});

/** What the parser carries between reads; small and serialisable so it persists with an offset. */
export const ClaudeTranscriptParserState = Schema.Struct({
  segment: Schema.NullOr(OpenSegment),
  lastUuid: Schema.NullOr(Schema.String),
});
export type ClaudeTranscriptParserState = typeof ClaudeTranscriptParserState.Type;

export const initialClaudeTranscriptParserState: ClaudeTranscriptParserState = {
  segment: null,
  lastUuid: null,
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

const ConversationLine = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  promptId: Schema.optional(Schema.String),
  message: Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String }))]),
    model: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
  }),
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

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeConversationLine = Schema.decodeUnknownExit(ConversationLine);
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

function contentBlocks(
  entry: SDKAssistantMessage | SDKUserMessage,
): ReadonlyArray<{ readonly block: ClaudeTranscriptBlock; readonly index: number | undefined }> {
  const content = entry.message.content;
  if (typeof content === "string")
    return [{ block: { type: "text", text: content }, index: undefined }];
  const blocks: Array<{ readonly block: ClaudeTranscriptBlock; readonly index: number }> = [];
  for (const block of content) {
    const required = REQUIRED_BLOCK_FIELDS.get(block.type);
    if (required !== undefined && !required(block)) {
      throw new MalformedLine(`A ${block.type} block lacks its required fields.`);
    }
    blocks.push({ block, index: blocks.length });
  }
  return blocks;
}

/**
 * Folds complete transcript lines, in file order, into segment events. Records of unknown types are skipped; a line that is not JSON, or a known record missing a field the parser needs, fails with the line's offset and leaves the caller's state untouched.
 */
export function parseClaudeTranscriptLines(input: {
  readonly sessionId: string;
  readonly state: ClaudeTranscriptParserState;
  readonly lines: ReadonlyArray<ClaudeTranscriptLine>;
}): Result.Result<
  {
    readonly state: ClaudeTranscriptParserState;
    readonly events: ReadonlyArray<ClaudeTranscriptEvent>;
  },
  ClaudeTranscriptLineError
> {
  let segment = input.state.segment;
  let lastUuid = input.state.lastUuid;
  const events: Array<ClaudeTranscriptEvent> = [];

  const end = (reason: ClaudeTranscriptEndReason, timestamp: string, durationMs?: number) => {
    if (segment === null) return;
    segment = { ...segment, ended: true };
    events.push({
      _tag: "SegmentEnded",
      segmentId: segment.segmentId,
      reason,
      lastAssistantUuid: segment.lastAssistantUuid ?? undefined,
      timestamp,
      durationMs,
    });
  };
  const start = (
    segmentId: string,
    parentUuid: string | null,
    timestamp: string,
    prompt: ClaudeTranscriptPrompt | undefined,
  ) => {
    const started: typeof OpenSegment.Type = {
      segmentId,
      promptId: prompt?.promptId ?? null,
      ended: false,
      lastAssistantUuid: null,
    };
    segment = started;
    events.push({ _tag: "SegmentStarted", segmentId, parentUuid, timestamp, prompt });
    return started;
  };
  // Content with no prompt before it opens a segment of its own, keyed on its first line.
  const current = (line: typeof ConversationLine.Type) =>
    segment ?? start(line.uuid, line.parentUuid, line.timestamp, undefined);
  const pushItems = (
    segmentId: string,
    entry: SDKAssistantMessage | SDKUserMessage,
    line: typeof ConversationLine.Type,
  ) => {
    for (const { block, index } of contentBlocks(entry)) {
      events.push({
        _tag: "Item",
        segmentId,
        item: {
          id: claudeTranscriptItemId(input.sessionId, line.uuid, index),
          lineUuid: line.uuid,
          blockIndex: index,
          role: entry.type,
          timestamp: line.timestamp,
          block,
          model: line.message.model,
          messageId: line.message.id,
        },
      });
    }
  };
  const noteBranch = (line: typeof ConversationLine.Type) => {
    if (line.parentUuid !== null && line.parentUuid !== lastUuid) {
      events.push({
        _tag: "Branch",
        lineUuid: line.uuid,
        parentUuid: line.parentUuid,
        previousUuid: lastUuid,
      });
    }
  };

  const conversationLine = (entry: unknown) => {
    if (!isClaudeTranscriptConversationLine(entry)) {
      throw new MalformedLine("A user or assistant record lacks a uuid or message content.");
    }
    const line = decoded(decodeConversationLine(entry));
    if (line.isMeta === true || line.isCompactSummary === true) return;
    if (entry.type === "assistant") {
      noteBranch(line);
      const open = current(line);
      pushItems(open.segmentId, entry, line);
      segment = { ...open, ended: false, lastAssistantUuid: line.uuid };
      if (isClaudeTranscriptTurnEnd(entry)) end("turn-end", line.timestamp);
      return;
    }
    const isToolResult =
      typeof entry.message.content !== "string" &&
      entry.message.content.some(isClaudeUserToolResultContentBlock);
    // The adapter's abort detection, applied to one message, recognises Claude's interrupt markers.
    const isInterrupt =
      claudeMessagesBeforeTrailingAborts([
        { type: "user", uuid: line.uuid, message: entry.message },
      ]) === 0;
    const visible = claudeUserText(extractText(entry.message.content));
    // Claude Code's own output for a command or shell run shares the prompt id of what ran it.
    const continuesSegment =
      isToolResult ||
      isInterrupt ||
      (segment !== null &&
        (line.promptId === undefined
          ? visible.text.length === 0
          : line.promptId === segment.promptId));
    if (continuesSegment) {
      pushItems(current(line).segmentId, entry, line);
      if (isInterrupt) end("interrupted", line.timestamp);
      return;
    }
    noteBranch(line);
    if (segment !== null && !segment.ended) end("next-prompt", line.timestamp);
    const originKind = field(field(entry, "origin"), "kind");
    const opened = start(line.uuid, line.parentUuid, line.timestamp, {
      text: visible.text,
      title: deriveTitle("claudeAgent", visible.titleText),
      promptId: line.promptId,
      originKind: typeof originKind === "string" ? originKind : undefined,
    });
    pushItems(opened.segmentId, entry, line);
  };

  const record = (entry: unknown) => {
    const type = field(entry, "type");
    if (typeof type !== "string") throw new MalformedLine("The record has no type.");
    if (field(entry, "isSidechain") === true) return;
    switch (type) {
      case "user":
      case "assistant":
        conversationLine(entry);
        break;
      case "system": {
        const subtype = field(entry, "subtype");
        if (subtype === "turn_duration") {
          const line = decoded(decodeTurnDuration(entry));
          end("turn-duration", line.timestamp, line.durationMs);
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
        break;
      }
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
    // Every main-chain record with a uuid, attachments and system notes included, is a parent.
    const uuid = field(entry, "uuid");
    if (typeof uuid === "string") lastUuid = uuid;
  };

  for (const line of input.lines) {
    if (line.text.trim().length === 0) continue;
    try {
      record(decoded(decodeJson(line.text)));
    } catch (error) {
      if (error instanceof MalformedLine) {
        return Result.fail(
          new ClaudeTranscriptLineError({ offset: line.offset, cause: error.cause }),
        );
      }
      throw error;
    }
  }
  return Result.succeed({ state: { segment, lastUuid }, events });
}
