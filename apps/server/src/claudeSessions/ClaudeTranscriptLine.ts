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
  extractText,
  isClaudeShellOutput,
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

// Claude Code's model name for the reply it writes itself, such as after an interrupt.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

const ForkSource = Schema.Struct({ sessionId: Schema.String, messageUuid: Schema.String });

// Decoding validates the fields that are read; blocks are then taken from the raw record, since decoding drops the fields a schema does not name.
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
  promptId: Schema.optional(Schema.NullOr(Schema.String)),
  isSidechain: Schema.optional(Schema.Boolean),
});
type RecordHeader = typeof RecordHeader.Type;

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

// The SDK's block union is open-ended; the fields read here and by consumers are checked.
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

/** A block with its index in the line's content array, undefined for string content. */
export interface ClaudeTranscriptIndexedBlock {
  readonly block: ClaudeTranscriptBlock;
  readonly index: number | undefined;
}

function checkedBlocks(content: unknown): ReadonlyArray<ClaudeTranscriptIndexedBlock> {
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

function blockText(blocks: ReadonlyArray<ClaudeTranscriptIndexedBlock>): string {
  return extractText(
    blocks.flatMap(({ block }) =>
      block.type === "text" ? [{ type: "text", text: block.text }] : [],
    ),
  );
}

const isLocalCommandInput = (content: string) => /^<command-(?:name|message)>/.test(content);

const LOCAL_COMMAND_OUTPUT_BLOCK =
  /<(local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>\s*/y;
const STDOUT_OPEN = "<bash-stdout>";
const STDOUT_CLOSE = "</bash-stdout>";
const STDERR_OPEN = "<bash-stderr>";
const STDERR_CLOSE = "</bash-stderr>";

// Shell output can print closing tags verbatim, so its streams are cut at the outer tags.
function shellOutputOf(text: string): ReadonlyArray<ClaudeTranscriptCommandOutput> {
  if (text.startsWith(STDERR_OPEN)) {
    return [{ stream: "stderr", text: text.slice(STDERR_OPEN.length, -STDERR_CLOSE.length) }];
  }
  if (text.endsWith(STDOUT_CLOSE)) {
    return [{ stream: "stdout", text: text.slice(STDOUT_OPEN.length, -STDOUT_CLOSE.length) }];
  }
  const separators = [...text.matchAll(/<\/bash-stdout>\s*<bash-stderr>/g)];
  const last = separators.at(-1);
  if (last === undefined) return [];
  return [
    { stream: "stdout", text: text.slice(STDOUT_OPEN.length, last.index) },
    { stream: "stderr", text: text.slice(last.index + last[0].length, -STDERR_CLOSE.length) },
  ];
}

/** The streams of a line that is only command or shell output, or undefined for any other text. */
function commandOutputOf(
  blocks: ReadonlyArray<ClaudeTranscriptIndexedBlock>,
): ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined {
  if (blocks.length === 0 || blocks.some(({ block }) => block.type !== "text")) return undefined;
  const text = blockText(blocks);
  if (isClaudeShellOutput(text)) return shellOutputOf(text);
  const output: Array<ClaudeTranscriptCommandOutput> = [];
  LOCAL_COMMAND_OUTPUT_BLOCK.lastIndex = 0;
  let end = 0;
  for (
    let match = LOCAL_COMMAND_OUTPUT_BLOCK.exec(text);
    match !== null;
    match = LOCAL_COMMAND_OUTPUT_BLOCK.exec(text)
  ) {
    output.push({
      stream: match[1]?.endsWith("stderr") ? "stderr" : "stdout",
      text: match[2] ?? "",
    });
    end = LOCAL_COMMAND_OUTPUT_BLOCK.lastIndex;
  }
  return output.length > 0 && end === text.length ? output : undefined;
}

/** What the user saw of a line's text, and the part of it that may name the thread. */
export interface ClaudeTranscriptVisibleText {
  readonly text: string;
  readonly titleText: string;
}

/** Every line kind the index and the content reader act on, fully validated. */
export type ClaudeTranscriptRecord =
  | {
      readonly kind: "conversation";
      readonly line: typeof ConversationLine.Type;
      readonly blocks: ReadonlyArray<ClaudeTranscriptIndexedBlock>;
      readonly visible: ClaudeTranscriptVisibleText;
      readonly isTurnEnd: boolean;
      readonly hasToolUse: boolean;
      readonly isToolResult: boolean;
      readonly isInterrupt: boolean;
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined;
    }
  | {
      readonly kind: "queued";
      readonly line: typeof QueuedCommand.Type;
      readonly blocks: ReadonlyArray<ClaudeTranscriptIndexedBlock>;
      readonly visible: ClaudeTranscriptVisibleText;
    }
  | {
      readonly kind: "localCommand";
      readonly line: typeof LocalCommand.Type;
      /** The command as typed; undefined for the output Claude Code printed for it. */
      readonly input: ClaudeTranscriptVisibleText | undefined;
      readonly blocks: ReadonlyArray<ClaudeTranscriptIndexedBlock>;
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput> | undefined;
    }
  | { readonly kind: "turnDuration"; readonly line: typeof TurnDuration.Type }
  | { readonly kind: "compactBoundary"; readonly line: typeof CompactBoundary.Type }
  | { readonly kind: "title"; readonly source: "ai" | "custom"; readonly title: string | undefined }
  | {
      readonly kind: "derivedFrom";
      readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly via: string }>;
    }
  | { readonly kind: "other" };

function decodeBody(type: string, entry: unknown): ClaudeTranscriptRecord {
  switch (type) {
    case "user":
    case "assistant": {
      const line = decoded(decodeConversationLine(entry));
      const content = field(field(entry, "message"), "content");
      const blocks = checkedBlocks(content);
      return {
        kind: "conversation",
        line,
        blocks,
        visible:
          line.type === "user"
            ? claudeUserText(blockText(blocks))
            : { text: blockText(blocks), titleText: "" },
        isTurnEnd: isClaudeTranscriptTurnEnd(entry),
        hasToolUse: blocks.some(({ block }) => block.type === "tool_use"),
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
      if (field(field(entry, "attachment"), "type") !== "queued_command") return { kind: "other" };
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
        return isLocalCommandInput(line.content)
          ? {
              kind: "localCommand",
              line,
              input: claudeUserText(line.content),
              blocks,
              output: undefined,
            }
          : {
              kind: "localCommand",
              line,
              input: undefined,
              blocks,
              output: commandOutputOf(blocks),
            };
      }
      if (subtype === "compact_boundary") {
        return { kind: "compactBoundary", line: decoded(decodeCompactBoundary(entry)) };
      }
      return { kind: "other" };
    }
    case "ai-title":
      return {
        kind: "title",
        source: "ai",
        title: claudeTitle(decoded(decodeAiTitle(entry)).aiTitle),
      };
    case "custom-title":
      return {
        kind: "title",
        source: "custom",
        title: claudeTitle(decoded(decodeCustomTitle(entry)).customTitle),
      };
    case "derived-from":
      return {
        kind: "derivedFrom",
        sessions: decoded(decodeDerivedFrom(entry)).sessions.map((session) => ({
          sessionId: session.id,
          via: session.via,
        })),
      };
    default:
      return { kind: "other" };
  }
}

/** One transcript line, decoded. A line whose header reads but whose body does not is `Unreadable`. */
export type ClaudeTranscriptDecodedLine =
  | { readonly _tag: "Blank" }
  | { readonly _tag: "Unparsed"; readonly cause: unknown }
  | { readonly _tag: "Unreadable"; readonly header: RecordHeader; readonly cause: unknown }
  | {
      readonly _tag: "Record";
      readonly header: RecordHeader;
      readonly record: ClaudeTranscriptRecord;
    };

export function decodeClaudeTranscriptLine(text: string): ClaudeTranscriptDecodedLine {
  if (text.trim().length === 0) return { _tag: "Blank" };
  let header: RecordHeader;
  let entry: unknown;
  try {
    entry = decoded(decodeJson(text));
    header = decoded(decodeRecordHeader(entry));
  } catch (error) {
    if (error instanceof MalformedLine) return { _tag: "Unparsed", cause: error.cause };
    throw error;
  }
  try {
    return { _tag: "Record", header, record: decodeBody(header.type, entry) };
  } catch (error) {
    if (error instanceof MalformedLine) return { _tag: "Unreadable", header, cause: error.cause };
    throw error;
  }
}

/** `x:<scope>:<lineUuid>[:<blockIndex>]`, stable across reads of the same file. */
export function claudeTranscriptItemId(
  scope: string,
  lineUuid: string,
  blockIndex: number | undefined,
): string {
  return blockIndex === undefined
    ? `x:${scope}:${lineUuid}`
    : `x:${scope}:${lineUuid}:${blockIndex}`;
}
