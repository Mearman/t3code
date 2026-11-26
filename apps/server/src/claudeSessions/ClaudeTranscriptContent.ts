import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { deriveTitle } from "../project/AgentSessionScanner.ts";
import { hashClaudeTranscriptLine, type ClaudeTranscriptIndex } from "./ClaudeTranscriptIndex.ts";
import {
  claudeTranscriptItemId,
  decodeClaudeTranscriptLine,
  type ClaudeTranscriptBlock,
  type ClaudeTranscriptCommandOutput,
  type ClaudeTranscriptForkSource,
  type ClaudeTranscriptRecord,
  type ClaudeTranscriptVisibleText,
} from "./ClaudeTranscriptLine.ts";
import type { ClaudeTranscriptTurn } from "./ClaudeTranscriptTurns.ts";

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

interface ItemBase {
  /** `x:<idScope>:<lineUuid>[:<blockIndex>]`, the same whichever turn the line is in. */
  readonly id: string;
  readonly lineUuid: string;
  readonly timestamp: string;
  readonly forkedFrom: ClaudeTranscriptForkSource | undefined;
}

/** One thing a turn shows, in the turn's order. */
export type ClaudeTranscriptItem =
  | (ItemBase & {
      readonly _tag: "Block";
      /** Undefined when the line's content was a plain string rather than a block array. */
      readonly blockIndex: number | undefined;
      readonly role: "user" | "assistant";
      readonly block: ClaudeTranscriptBlock;
      readonly model: string | undefined;
      /** The API message id; Claude Code writes one line per block, so a message spans lines. */
      readonly messageId: string | undefined;
    })
  | (ItemBase & {
      /** A prompt Claude Code delivered into the turn, or the prompt that opened a queued turn. */
      readonly _tag: "QueuedPrompt";
      readonly prompt: ClaudeTranscriptPrompt;
      readonly blocks: ReadonlyArray<ClaudeTranscriptBlock>;
    })
  | (ItemBase & {
      /** A slash command, as typed, without its markup. */
      readonly _tag: "Command";
      readonly text: string;
    })
  | (ItemBase & {
      /** Output Claude Code printed for a slash command or shell run, without its markup. */
      readonly _tag: "CommandOutput";
      readonly output: ReadonlyArray<ClaudeTranscriptCommandOutput>;
    })
  | (ItemBase & {
      readonly _tag: "Compaction";
      readonly trigger: string;
      readonly preTokens: number;
    })
  | {
      /** A line whose header reads but whose body does not; its offset is for the log. */
      readonly _tag: "Unreadable";
      readonly id: string;
      readonly lineUuid: string;
      readonly offset: number;
    };

export interface ClaudeTranscriptTurnContent {
  readonly turn: ClaudeTranscriptTurn;
  /** Undefined for a turn opened by a line with no prompt before it. */
  readonly prompt: ClaudeTranscriptPrompt | undefined;
  readonly forkedFrom: ClaudeTranscriptForkSource | undefined;
  readonly items: ReadonlyArray<ClaudeTranscriptItem>;
}

export class ClaudeTranscriptChangedError extends Schema.TaggedError<ClaudeTranscriptChangedError>()(
  "ClaudeTranscriptChangedError",
  { lineUuid: Schema.String },
) {
  override get message(): string {
    return `Claude transcript line ${this.lineUuid} is not where or what the index holds; sync it again.`;
  }
}

const promptFrom = (
  visible: ClaudeTranscriptVisibleText,
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

function queuedPrompt(record: Extract<ClaudeTranscriptRecord, { kind: "queued" }>) {
  const { attachment } = record.line;
  return promptFrom(
    record.visible,
    undefined,
    attachment.origin?.kind ??
      (attachment.commandMode === "task-notification" ? "task-notification" : undefined),
    attachment.isMeta === true,
  );
}

function openerPrompt(
  turn: ClaudeTranscriptTurn,
  record: ClaudeTranscriptRecord,
): ClaudeTranscriptPrompt | undefined {
  switch (record.kind) {
    case "conversation":
      return turn.opener === "prompt" || turn.opener === "meta"
        ? promptFrom(
            record.visible,
            record.line.promptId ?? undefined,
            record.line.origin?.kind,
            turn.opener === "meta",
          )
        : undefined;
    case "queued":
      return turn.opener === "queued"
        ? { ...queuedPrompt(record), promptId: turn.promptId }
        : undefined;
    case "localCommand":
      return record.input === undefined
        ? undefined
        : promptFrom(record.input, undefined, undefined, false);
    default:
      return undefined;
  }
}

function itemsOf(
  idScope: string,
  record: ClaudeTranscriptRecord,
): ReadonlyArray<ClaudeTranscriptItem> {
  switch (record.kind) {
    case "conversation": {
      const { line } = record;
      const base = {
        lineUuid: line.uuid,
        timestamp: line.timestamp,
        forkedFrom: line.forkedFrom,
      };
      if (line.isMeta === true) return [];
      if (record.output !== undefined) {
        return [
          {
            _tag: "CommandOutput",
            ...base,
            id: claudeTranscriptItemId(idScope, line.uuid, undefined),
            output: record.output,
          },
        ];
      }
      return record.blocks.map(({ block, index }) => ({
        _tag: "Block",
        ...base,
        id: claudeTranscriptItemId(idScope, line.uuid, index),
        blockIndex: index,
        role: line.type,
        block,
        model: line.message.model,
        messageId: line.message.id,
      }));
    }
    case "queued":
      return [
        {
          _tag: "QueuedPrompt",
          id: claudeTranscriptItemId(idScope, record.line.uuid, undefined),
          lineUuid: record.line.uuid,
          timestamp: record.line.timestamp,
          forkedFrom: record.line.forkedFrom,
          prompt: queuedPrompt(record),
          blocks: record.blocks.map(({ block }) => block),
        },
      ];
    case "localCommand": {
      const { line } = record;
      const base = {
        id: claudeTranscriptItemId(idScope, line.uuid, undefined),
        lineUuid: line.uuid,
        timestamp: line.timestamp,
        forkedFrom: line.forkedFrom,
      };
      if (record.input !== undefined)
        return [{ _tag: "Command", ...base, text: record.input.text }];
      if (record.output !== undefined)
        return [{ _tag: "CommandOutput", ...base, output: record.output }];
      return record.blocks.map(({ block, index }) => ({
        _tag: "Block",
        ...base,
        id: claudeTranscriptItemId(idScope, line.uuid, index),
        blockIndex: index,
        role: "user",
        block,
        model: undefined,
        messageId: undefined,
      }));
    }
    case "compactBoundary":
      return [
        {
          _tag: "Compaction",
          id: claudeTranscriptItemId(idScope, record.line.uuid, undefined),
          lineUuid: record.line.uuid,
          timestamp: record.line.timestamp,
          forkedFrom: undefined,
          trigger: record.line.compactMetadata.trigger,
          preTokens: record.line.compactMetadata.preTokens,
        },
      ];
    default:
      return [];
  }
}

const forkOf = (record: ClaudeTranscriptRecord) =>
  record.kind === "conversation" || record.kind === "queued" || record.kind === "localCommand"
    ? record.line.forkedFrom
    : undefined;

/**
 * Reads one turn's lines by their indexed offsets, and nothing else of the file. Fails with `ClaudeTranscriptChangedError` when a line's bytes are not those indexed, as after a rewrite the guard windows missed; sync the index and take the structure again. Memory is the turn's bytes.
 */
export const readClaudeTranscriptTurn = Effect.fn("readClaudeTranscriptTurn")(function* (input: {
  readonly filePath: string;
  readonly index: ClaudeTranscriptIndex;
  readonly idScope: string;
  readonly turn: ClaudeTranscriptTurn;
}) {
  const { index, turn } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const handle = yield* fileSystem.open(input.filePath, { flag: "r" });
  const decoder = new TextDecoder();
  const located: Array<{
    readonly uuid: string;
    readonly offset: number;
    readonly length: number;
    readonly hash: number;
  }> = [];
  for (const uuid of turn.lineUuids) {
    const entry = index.entryOf(uuid);
    if (entry === undefined) return yield* new ClaudeTranscriptChangedError({ lineUuid: uuid });
    located.push({ uuid, ...index.location(entry) });
  }
  // Lines next to each other in the file are read in one call.
  const groups: Array<Array<(typeof located)[number]>> = [];
  for (const line of located.toSorted((left, right) => left.offset - right.offset)) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group !== undefined &&
      previous !== undefined &&
      line.offset === previous.offset + previous.length + 1
    ) {
      group.push(line);
    } else {
      groups.push([line]);
    }
  }
  const records = new Map<string, ClaudeTranscriptRecord | { readonly unreadable: number }>();
  for (const group of groups) {
    const [first] = group;
    const last = group.at(-1);
    if (first === undefined || last === undefined) continue;
    yield* handle.seek(BigInt(first.offset), "start");
    const read = yield* handle.readAlloc(last.offset + last.length - first.offset);
    const bytes = Option.getOrElse(read, () => new Uint8Array(0));
    for (const line of group) {
      const start = line.offset - first.offset;
      const lineBytes = bytes.subarray(start, start + line.length);
      if (lineBytes.length !== line.length || hashClaudeTranscriptLine(lineBytes) !== line.hash) {
        return yield* new ClaudeTranscriptChangedError({ lineUuid: line.uuid });
      }
      const decoded = decodeClaudeTranscriptLine(decoder.decode(lineBytes));
      records.set(
        line.uuid,
        decoded._tag === "Record" ? decoded.record : { unreadable: line.offset },
      );
    }
  }

  let prompt: ClaudeTranscriptPrompt | undefined;
  let forkedFrom: ClaudeTranscriptForkSource | undefined;
  const items: Array<ClaudeTranscriptItem> = [];
  for (const uuid of turn.lineUuids) {
    const record = records.get(uuid);
    if (record === undefined) continue;
    if ("unreadable" in record) {
      items.push({
        _tag: "Unreadable",
        id: claudeTranscriptItemId(input.idScope, uuid, undefined),
        lineUuid: uuid,
        offset: record.unreadable,
      });
      continue;
    }
    if (uuid === turn.id) {
      prompt = openerPrompt(turn, record);
      forkedFrom = forkOf(record);
    }
    items.push(...itemsOf(input.idScope, record));
  }
  const content: ClaudeTranscriptTurnContent = { turn, prompt, forkedFrom, items };
  return content;
}, Effect.scoped);
