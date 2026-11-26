import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { field } from "../orchestration-v2/unknownField.ts";
import type { ClaudeTranscriptEvent } from "./ClaudeTranscriptSegments.ts";

/** A rule a transcript's events break, named for the checker's report. */
export type ClaudeTranscriptViolationKind =
  | "content-line-without-event"
  | "repeat-emitted"
  | "split-read-differs"
  | "item-outside-its-chain"
  | "interrupt-not-kept"
  | "superseded-end-kept"
  | "end-before-start"
  | "raw-command-markup";

/** A broken rule, described by line number and record shape only, never by content. */
export interface ClaudeTranscriptViolation {
  readonly kind: ClaudeTranscriptViolationKind;
  /** One-based line number in the transcript, when one line is to blame. */
  readonly line: number | undefined;
  readonly shape: string;
}

export interface ClaudeTranscriptCheck {
  readonly violations: ReadonlyArray<ClaudeTranscriptViolation>;
  readonly counts: Readonly<Record<string, number>>;
}

interface RawLine {
  readonly number: number;
  readonly record: unknown;
  readonly uuid: string | undefined;
  readonly parentUuid: string | undefined;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const COMMAND_MARKUP =
  /^\s*<(?:command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat))>/;
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);
const SYNTHETIC_MODEL = "<synthetic>";
// A cycle or a chain this long is not a conversation; the walk gives up on it.
const MAX_CHAIN_STEPS = 100_000;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A record's type, subtype, sorted keys and Claude Code version: never any of its values. */
function shapeOf(record: unknown): string {
  const type = text(field(record, "type")) ?? "?";
  const kind = text(field(record, "subtype")) ?? text(field(field(record, "attachment"), "type"));
  const keys =
    typeof record === "object" && record !== null ? Object.keys(record).toSorted().join(",") : "";
  const version = text(field(record, "version"));
  return `${kind === undefined ? type : `${type}/${kind}`} keys=[${keys}]${version === undefined ? "" : ` version=${version}`}`;
}

function isContentLine(record: unknown): boolean {
  if (field(record, "isSidechain") === true) return false;
  const type = field(record, "type");
  if (type === "user" || type === "assistant") {
    return field(record, "isMeta") !== true && field(record, "isCompactSummary") !== true;
  }
  if (type === "attachment") return field(field(record, "attachment"), "type") === "queued_command";
  return type === "system" && field(record, "subtype") === "local_command";
}

function blockTexts(record: unknown): ReadonlyArray<string> {
  const content = field(field(record, "message"), "content");
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) =>
    field(block, "type") === "text" && typeof field(block, "text") === "string"
      ? [String(field(block, "text"))]
      : [],
  );
}

function isInterruptLine(record: unknown): boolean {
  const texts = blockTexts(record);
  return (
    field(record, "type") === "user" &&
    texts.length > 0 &&
    texts.every((value) => INTERRUPT_MARKERS.has(value.trim()))
  );
}

/**
 * Checks the events a whole read of a transcript gave against the transcript's own lines, and against the events of the same transcript read in parts. `lines` are the transcript's complete lines in file order; `malformedLines` are the one-based numbers of lines the parser stepped past.
 */
export function checkClaudeTranscriptEvents(input: {
  readonly lines: ReadonlyArray<string>;
  readonly whole: ReadonlyArray<ClaudeTranscriptEvent>;
  readonly split: ReadonlyArray<ClaudeTranscriptEvent>;
  readonly malformedLines: ReadonlySet<number>;
}): ClaudeTranscriptCheck {
  const violations: Array<ClaudeTranscriptViolation> = [];
  const counts: Record<string, number> = {};
  const count = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const report = (
    kind: ClaudeTranscriptViolationKind,
    line: RawLine | undefined,
    shape: string,
  ) => {
    violations.push({ kind, line: line?.number, shape });
    count(`violation ${kind}`);
  };

  // The first line written with each uuid, which is the one the parser reads.
  const firstByUuid = new Map<string, RawLine>();
  const rawLines: Array<RawLine> = [];
  input.lines.forEach((value, index) => {
    if (value.trim().length === 0) return;
    const decoded = decodeJson(value);
    if (Option.isNone(decoded)) return;
    const record = decoded.value;
    const uuid = text(field(record, "uuid"));
    const parentUuid = text(field(record, "parentUuid"));
    const raw = { number: index + 1, record, uuid, parentUuid };
    rawLines.push(raw);
    if (uuid !== undefined && field(record, "isSidechain") !== true && !firstByUuid.has(uuid)) {
      firstByUuid.set(uuid, raw);
    }
  });
  count("lines", input.lines.length);
  count("lines stepped past as malformed", input.malformedLines.size);

  const segmentOrder: Array<string> = [];
  const segmentStarts = new Map<string, string>();
  const emittedLines = new Set<string>();
  const emittedIds = new Set<string>();
  const segmentItems = new Map<
    string,
    Array<{ readonly lineUuid: string; readonly role: string }>
  >();
  const endsAfterStart = new Map<
    string,
    Array<Extract<ClaudeTranscriptEvent, { _tag: "SegmentEnded" }>>
  >();

  const noteEmitted = (id: string, lineUuid: string, raw: RawLine | undefined) => {
    if (emittedIds.has(id)) report("repeat-emitted", raw, shapeOf(raw?.record));
    emittedIds.add(id);
    emittedLines.add(lineUuid);
  };

  for (const event of input.whole) {
    switch (event._tag) {
      case "SegmentStarted": {
        const raw = firstByUuid.get(event.segmentId);
        noteEmitted(`segment:${event.segmentId}`, event.segmentId, raw);
        segmentOrder.push(event.segmentId);
        segmentStarts.set(event.segmentId, event.timestamp);
        count("segments");
        const prompt = event.prompt;
        if (
          prompt !== undefined &&
          (COMMAND_MARKUP.test(prompt.text) || COMMAND_MARKUP.test(prompt.title ?? ""))
        ) {
          report("raw-command-markup", raw, `prompt of ${shapeOf(raw?.record)}`);
        }
        break;
      }
      case "Item": {
        const raw = firstByUuid.get(event.item.lineUuid);
        noteEmitted(event.item.id, event.item.lineUuid, raw);
        count("items");
        const items = segmentItems.get(event.segmentId) ?? [];
        items.push({ lineUuid: event.item.lineUuid, role: event.item.role });
        segmentItems.set(event.segmentId, items);
        const block = event.item.block;
        if (
          event.item.role === "user" &&
          event.item.lineUuid !== event.segmentId &&
          block.type === "text" &&
          COMMAND_MARKUP.test(block.text)
        ) {
          report("raw-command-markup", raw, `item of ${shapeOf(raw?.record)}`);
        }
        if (segmentOrder.at(-1) !== event.segmentId) count("items filed under an earlier segment");
        break;
      }
      case "QueuedPrompt":
        noteEmitted(event.id, event.lineUuid, firstByUuid.get(event.lineUuid));
        count("queued prompts into a running turn");
        break;
      case "CommandOutput": {
        noteEmitted(event.id, event.lineUuid, firstByUuid.get(event.lineUuid));
        count("command output lines");
        const items = segmentItems.get(event.segmentId) ?? [];
        items.push({ lineUuid: event.lineUuid, role: "user" });
        segmentItems.set(event.segmentId, items);
        break;
      }
      case "SegmentEnded": {
        const ends = endsAfterStart.get(event.segmentId) ?? [];
        ends.push(event);
        endsAfterStart.set(event.segmentId, ends);
        const startedAt = segmentStarts.get(event.segmentId);
        if (startedAt !== undefined && Date.parse(event.timestamp) < Date.parse(startedAt)) {
          report(
            "end-before-start",
            firstByUuid.get(event.segmentId),
            shapeOf(firstByUuid.get(event.segmentId)?.record),
          );
        }
        break;
      }
      case "Branch":
        count("branches");
        break;
      default:
        break;
    }
  }

  // Every first occurrence of a content line yields an event, unless the parser stepped past it.
  for (const raw of firstByUuid.values()) {
    if (raw.uuid === undefined || !isContentLine(raw.record)) continue;
    count("first-occurrence content lines");
    if (emittedLines.has(raw.uuid) || input.malformedLines.has(raw.number)) continue;
    // Claude Code can record one slash command as a user line and as a system record.
    const parent = raw.parentUuid === undefined ? undefined : firstByUuid.get(raw.parentUuid);
    if (
      field(raw.record, "type") === "system" &&
      parent !== undefined &&
      segmentStarts.has(parent.uuid ?? "")
    ) {
      count("slash commands recorded twice, read once");
      continue;
    }
    report("content-line-without-event", raw, shapeOf(raw.record));
  }
  count(
    "repeated lines",
    rawLines.length - firstByUuid.size - rawLines.filter((raw) => raw.uuid === undefined).length,
  );

  // An item belongs to the segment of the nearest segment opener up its parent chain.
  const openerOf = (start: string) => {
    let uuid: string | undefined = start;
    for (let steps = 0; uuid !== undefined && steps < MAX_CHAIN_STEPS; steps += 1) {
      if (segmentStarts.has(uuid)) return uuid;
      uuid = firstByUuid.get(uuid)?.parentUuid;
    }
    return undefined;
  };
  for (const [segmentId, items] of segmentItems) {
    for (const item of items) {
      const opener = openerOf(item.lineUuid);
      if (opener === undefined) {
        count("items with no opener up their chain");
      } else if (opener !== segmentId) {
        const raw = firstByUuid.get(item.lineUuid);
        report("item-outside-its-chain", raw, shapeOf(raw?.record));
      }
    }
  }

  // Each segment's last end agrees with the markers its own lines carry.
  for (const [segmentId, items] of segmentItems) {
    const last = endsAfterStart.get(segmentId)?.at(-1);
    if (last === undefined) continue;
    const records = items.flatMap((item) => {
      const raw = firstByUuid.get(item.lineUuid);
      return raw === undefined ? [] : [raw];
    });
    const unique = [...new Map(records.map((raw) => [raw.number, raw])).values()];
    const lastInterrupt = unique.findLastIndex((raw) => isInterruptLine(raw.record));
    if (lastInterrupt !== -1) {
      const after = unique.slice(lastInterrupt + 1);
      const onlySynthetic = after.every(
        (raw) =>
          field(raw.record, "type") === "assistant" &&
          field(field(raw.record, "message"), "model") === SYNTHETIC_MODEL,
      );
      if (onlySynthetic && last.reason !== "interrupted") {
        report("interrupt-not-kept", unique[lastInterrupt], `ended ${last.reason}`);
      }
    }
    const lastReply = unique.findLast(
      (raw) =>
        field(raw.record, "type") === "assistant" &&
        field(field(raw.record, "message"), "model") !== SYNTHETIC_MODEL,
    );
    const stop = text(field(field(lastReply?.record, "message"), "stop_reason"));
    if (last.reason === "next-prompt" && stop !== undefined && stop !== "tool_use") {
      report("superseded-end-kept", lastReply, `stop_reason=${stop}`);
    }
  }

  const wholeText = JSON.stringify(input.whole);
  const splitText = JSON.stringify(input.split);
  if (wholeText !== splitText) {
    const index = input.whole.findIndex(
      (event, position) => JSON.stringify(event) !== JSON.stringify(input.split[position]),
    );
    const differs = index === -1 ? input.whole.length : index;
    report(
      "split-read-differs",
      undefined,
      `event ${differs}: whole ${input.whole[differs]?._tag ?? "none"}, split ${input.split[differs]?._tag ?? "none"}; ${input.whole.length} against ${input.split.length} events`,
    );
  }
  return { violations, counts };
}
