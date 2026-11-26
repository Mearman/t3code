import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { field } from "../orchestration-v2/unknownField.ts";
import type { ClaudeTranscriptTurnContent } from "./ClaudeTranscriptContent.ts";
import type { ClaudeTranscriptStructure, ClaudeTranscriptTurn } from "./ClaudeTranscriptTurns.ts";

/** A rule the parser's turns break, judged from the transcript's raw lines alone. */
export type ClaudeTranscriptViolationKind =
  | "content-line-missing"
  | "line-in-two-turns"
  | "repeat-emitted"
  | "item-outside-its-chain"
  | "prompt-not-opened"
  | "opened-without-cause"
  | "queued-filed-wrongly"
  | "interrupt-not-kept"
  | "duration-not-kept"
  | "running-before-last"
  | "superseded-end-kept"
  | "start-not-opener-time"
  | "end-before-start"
  | "raw-command-markup"
  | "unreadable-but-readable"
  | "differs-from-whole-read";

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
  readonly uuid: string;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const MARKUP =
  /^\s*<(?:command-(?:name|message|args)|local-command-(?:stdout|stderr|caveat)|bash-(?:stdout|stderr|input))>/;
const OUTPUT_TAG = /^\s*<(?:local-command-(?:stdout|stderr)|bash-(?:stdout|stderr))>/;
const INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);
const SYNTHETIC_MODEL = "<synthetic>";
// A cycle or a chain this long is not a conversation; a walk gives up on it.
const MAX_CHAIN_STEPS = 100_000;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const isString = (value: unknown) => typeof value === "string";
const absentOr = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);

/** A record's type, subtype, sorted keys and Claude Code version: never any of its values. */
function shapeOf(record: unknown): string {
  const type = text(field(record, "type")) ?? "?";
  const kind = text(field(record, "subtype")) ?? text(field(field(record, "attachment"), "type"));
  const keys =
    typeof record === "object" && record !== null ? Object.keys(record).toSorted().join(",") : "";
  const version = text(field(record, "version"));
  return `${kind === undefined ? type : `${type}/${kind}`} keys=[${keys}]${version === undefined ? "" : ` version=${version}`}`;
}

const typeOf = (record: unknown) => text(field(record, "type"));
const subtypeOf = (record: unknown) => text(field(record, "subtype"));
const contentOf = (record: unknown) => field(field(record, "message"), "content");
const isMeta = (record: unknown) => field(record, "isMeta") === true;
const isQueued = (record: unknown) =>
  typeOf(record) === "attachment" &&
  field(field(record, "attachment"), "type") === "queued_command";
const isLocalCommand = (record: unknown) =>
  typeOf(record) === "system" && subtypeOf(record) === "local_command";
const isCommandInput = (record: unknown) =>
  isLocalCommand(record) &&
  /^<command-(?:name|message)>/.test(text(field(record, "content")) ?? "");

function blocksOf(content: unknown): ReadonlyArray<unknown> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textsOf(record: unknown): ReadonlyArray<string> {
  return blocksOf(contentOf(record)).flatMap((block) => {
    const value = field(block, "type") === "text" ? text(field(block, "text")) : undefined;
    return value === undefined ? [] : [value];
  });
}

const hasBlock = (record: unknown, type: string) =>
  blocksOf(contentOf(record)).some((block) => field(block, "type") === type);

function isInterruptLine(record: unknown): boolean {
  const texts = textsOf(record);
  return (
    typeOf(record) === "user" &&
    texts.length > 0 &&
    texts.every((value) => INTERRUPT_MARKERS.has(value.trim()))
  );
}

const isReply = (record: unknown) => typeOf(record) === "assistant";
const isRealReply = (record: unknown) =>
  isReply(record) && field(field(record, "message"), "model") !== SYNTHETIC_MODEL;
// A reply whose stop reason ends the turn: any recorded reason but a tool call.
function isEndingReply(record: unknown): boolean {
  const stop = field(field(record, "message"), "stop_reason");
  return (
    isReply(record) &&
    typeof stop === "string" &&
    stop !== "tool_use" &&
    !hasBlock(record, "tool_use")
  );
}

// Lines that carry no content of their own; the conversation's chain runs through them.
function passesThrough(record: unknown): boolean {
  const type = typeOf(record);
  if (type === "user") return isMeta(record) || field(record, "isCompactSummary") === true;
  if (type === "assistant") return false;
  if (type === "attachment") return !isQueued(record);
  if (type === "system")
    return subtypeOf(record) !== "local_command" && subtypeOf(record) !== "turn_duration";
  return true;
}

const REQUIRED: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["text", ["text"]],
  ["thinking", ["thinking"]],
  ["redacted_thinking", ["data"]],
  ["tool_use", ["id", "name"]],
  ["tool_result", ["tool_use_id"]],
]);

function readableContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((block: unknown) => {
    const type = field(block, "type");
    if (typeof type !== "string") return false;
    return (REQUIRED.get(type) ?? []).every((key) => isString(field(block, key)));
  });
}

/** Whether the line carries every field a reader of its kind needs, judged without the parser. */
function isReadable(record: unknown): boolean {
  const type = typeOf(record);
  const header = isString(field(record, "uuid")) && isString(field(record, "timestamp"));
  const parent = field(record, "parentUuid") === null || isString(field(record, "parentUuid"));
  if (type === "user" || type === "assistant") {
    const message = field(record, "message");
    return (
      header &&
      parent &&
      readableContent(field(message, "content")) &&
      absentOr(field(record, "isMeta"), (value) => typeof value === "boolean") &&
      absentOr(field(record, "isCompactSummary"), (value) => typeof value === "boolean") &&
      absentOr(field(record, "promptId"), (value) => value === null || isString(value)) &&
      absentOr(field(message, "model"), isString) &&
      absentOr(field(message, "id"), isString) &&
      absentOr(field(message, "stop_reason"), (value) => value === null || isString(value))
    );
  }
  if (isQueued(record))
    return header && parent && readableContent(field(field(record, "attachment"), "prompt"));
  if (isLocalCommand(record)) return header && parent && isString(field(record, "content"));
  if (type === "system" && subtypeOf(record) === "turn_duration") {
    return header && typeof field(record, "durationMs") === "number";
  }
  if (type === "system" && subtypeOf(record) === "compact_boundary") {
    const metadata = field(record, "compactMetadata");
    return (
      header &&
      isString(field(metadata, "trigger")) &&
      typeof field(metadata, "preTokens") === "number"
    );
  }
  return true;
}

function isContentLine(record: unknown): boolean {
  const type = typeOf(record);
  if (type === "user" || type === "assistant") {
    return !isMeta(record) && field(record, "isCompactSummary") !== true;
  }
  return isQueued(record) || isLocalCommand(record);
}

// A prompt the user typed: text, no tool result, and none of Claude Code's own markup.
function mustOpen(record: unknown): boolean {
  if (typeOf(record) !== "user" || isMeta(record) || field(record, "isCompactSummary") === true)
    return false;
  if (hasBlock(record, "tool_result")) return false;
  const joined = textsOf(record).join("\n").trim();
  return joined.length > 0 && !joined.startsWith("<") && !INTERRUPT_MARKERS.has(joined);
}

function sameText(left: unknown, right: unknown): boolean {
  const commandText = text(field(right, "content"))?.trim();
  return commandText !== undefined && textsOf(left).join("").trim() === commandText;
}

/**
 * Checks a parser's turns against the transcript's lines, in file order, by rules derived from the lines alone: the parser's segmentation is never taken as truth, and nothing it can cause is excused. `contents` are the turns' contents in the structure's order; `others` are structures of the same lines read another way (in pieces, or permuted), which must be equal.
 */
export function checkClaudeTranscriptTurns(input: {
  readonly lines: ReadonlyArray<string>;
  readonly structure: ClaudeTranscriptStructure;
  readonly contents: ReadonlyArray<ClaudeTranscriptTurnContent>;
  readonly others: ReadonlyArray<{
    readonly name: string;
    readonly structure: ClaudeTranscriptStructure;
  }>;
}): ClaudeTranscriptCheck {
  const violations: Array<ClaudeTranscriptViolation> = [];
  const counts: Record<string, number> = {};
  const count = (key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const report = (
    kind: ClaudeTranscriptViolationKind,
    raw: RawLine | undefined,
    shape?: string,
  ) => {
    violations.push({ kind, line: raw?.number, shape: shape ?? shapeOf(raw?.record) });
    count(`violation ${kind}`);
  };

  // The first readable line with each uuid, else its first line, as Claude Code's reader keeps.
  const first = new Map<string, RawLine>();
  input.lines.forEach((value, index) => {
    if (value.trim().length === 0) return;
    const decoded = decodeJson(value);
    if (Option.isNone(decoded)) {
      count("lines that are not JSON");
      return;
    }
    const record = decoded.value;
    const uuid = text(field(record, "uuid"));
    if (uuid === undefined || field(record, "isSidechain") === true) return;
    const known = first.get(uuid);
    if (known !== undefined) count("repeated lines");
    if (known === undefined || (!isReadable(known.record) && isReadable(record))) {
      first.set(uuid, { number: index + 1, record, uuid });
    }
  });
  count("lines", input.lines.length);

  const parentOf = (raw: RawLine) => {
    const parent = text(field(raw.record, "parentUuid"));
    if (parent !== undefined) return parent;
    return subtypeOf(raw.record) === "compact_boundary"
      ? text(field(raw.record, "logicalParentUuid"))
      : undefined;
  };
  const children = new Map<string, Array<RawLine>>();
  for (const raw of first.values()) {
    const parent = parentOf(raw);
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(raw);
    children.set(parent, list);
  }

  const turnIds = new Map<string, ClaudeTranscriptTurn>();
  const lineTurn = new Map<string, string>();
  const itemIds = new Set<string>();
  for (const turn of input.structure.turns) {
    turnIds.set(turn.id, turn);
    count(`turns opened by ${turn.opener}`);
    count(`turns ended ${turn.end?.reason ?? "running"}`);
    if (turn.branchedFrom !== undefined) count("branches");
  }
  for (const content of input.contents) {
    const turnId = content.turn.id;
    for (const item of content.items) {
      count("items");
      if (itemIds.has(item.id)) report("repeat-emitted", first.get(item.lineUuid));
      itemIds.add(item.id);
      const owner = lineTurn.get(item.lineUuid);
      if (owner !== undefined && owner !== turnId)
        report("line-in-two-turns", first.get(item.lineUuid));
      lineTurn.set(item.lineUuid, turnId);
    }
  }
  const turnOfLine = (uuid: string) => (turnIds.has(uuid) ? uuid : lineTurn.get(uuid));

  // The nearest line up the chain that holds content or opens a turn, through lines that hold neither.
  const anchorOf = (raw: RawLine): RawLine | undefined => {
    let uuid = parentOf(raw);
    for (let steps = 0; uuid !== undefined && steps < MAX_CHAIN_STEPS; steps += 1) {
      const up = first.get(uuid);
      if (up === undefined) return undefined;
      if (turnIds.has(up.uuid) || !passesThrough(up.record)) return up;
      uuid = parentOf(up);
    }
    return undefined;
  };
  const descendants = function* (raw: RawLine, within: string) {
    const stack = [...(children.get(raw.uuid) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || seen.has(next.uuid)) continue;
      seen.add(next.uuid);
      const turn = turnOfLine(next.uuid);
      if (turn !== undefined && turn !== within) continue;
      yield next;
      stack.push(...(children.get(next.uuid) ?? []));
    }
  };
  const repliesThrough = (raw: RawLine) => {
    const stack = [...(children.get(raw.uuid) ?? [])];
    for (let steps = 0; stack.length > 0 && steps < MAX_CHAIN_STEPS; steps += 1) {
      const next = stack.pop();
      if (next === undefined) break;
      if (isReply(next.record)) return true;
      if (passesThrough(next.record)) stack.push(...(children.get(next.uuid) ?? []));
    }
    return false;
  };
  const endsTurn = (raw: RawLine) => {
    const owner = turnOfLine(raw.uuid);
    const opener = owner === undefined ? undefined : first.get(owner);
    return (
      isEndingReply(raw.record) ||
      (isReply(raw.record) && !isRealReply(raw.record)) ||
      (typeOf(raw.record) === "system" && subtypeOf(raw.record) === "turn_duration") ||
      isInterruptLine(raw.record) ||
      (opener !== undefined && isCommandInput(opener.record))
    );
  };
  const waitsOnTool = (anchor: RawLine | undefined) =>
    anchor !== undefined &&
    isReply(anchor.record) &&
    hasBlock(anchor.record, "tool_use") &&
    (children.get(anchor.uuid) ?? []).some((child) => hasBlock(child.record, "tool_result"));

  // Every content line is in exactly one turn, and every turn's lines follow its chain.
  for (const raw of first.values()) {
    if (!isContentLine(raw.record)) continue;
    count("first-occurrence content lines");
    const parent = parentOf(raw);
    const parentRaw = parent === undefined ? undefined : first.get(parent);
    const duplicateCommand =
      isCommandInput(raw.record) &&
      parentRaw !== undefined &&
      typeOf(parentRaw.record) === "user" &&
      sameText(parentRaw.record, raw.record);
    const empty =
      Array.isArray(contentOf(raw.record)) && blocksOf(contentOf(raw.record)).length === 0;
    const turn = turnOfLine(raw.uuid);
    if (turn === undefined) {
      if (duplicateCommand || empty) count("content lines with nothing to show");
      else report("content-line-missing", raw);
      continue;
    }
    if (turnIds.has(raw.uuid)) continue;
    const anchor = anchorOf(raw);
    if (anchor === undefined || turnOfLine(anchor.uuid) !== turn)
      report("item-outside-its-chain", raw);
  }

  // Turns open where the lines say a turn starts, and only there.
  for (const raw of first.values()) {
    const opened = turnIds.has(raw.uuid);
    const anchor = anchorOf(raw);
    if (mustOpen(raw.record) && !opened) report("prompt-not-opened", raw);
    if (isQueued(raw.record)) {
      const startsTurn = anchor === undefined || endsTurn(anchor);
      if (startsTurn !== opened) report("queued-filed-wrongly", raw);
    }
    if (isCommandInput(raw.record) && !opened) {
      const parent = parentOf(raw);
      const parentRaw = parent === undefined ? undefined : first.get(parent);
      const duplicate =
        parentRaw !== undefined &&
        typeOf(parentRaw.record) === "user" &&
        sameText(parentRaw.record, raw.record);
      if (!duplicate && !waitsOnTool(anchor)) report("prompt-not-opened", raw);
    }
    if (!opened) continue;
    const record = raw.record;
    const orphan = anchor === undefined;
    const cause =
      (typeOf(record) === "user" &&
        !isMeta(record) &&
        field(record, "isCompactSummary") !== true &&
        !hasBlock(record, "tool_result") &&
        !isInterruptLine(record) &&
        !OUTPUT_TAG.test(textsOf(record).join(""))) ||
      (typeOf(record) === "user" &&
        isMeta(record) &&
        isString(field(record, "promptId")) &&
        repliesThrough(raw)) ||
      isQueued(record) ||
      isCommandInput(record) ||
      (orphan && (isContentLine(record) || !isReadable(record)));
    if (!cause) report("opened-without-cause", raw);
  }

  const last = input.structure.turns.at(-1);
  for (const content of input.contents) {
    const { turn } = content;
    const opener = first.get(turn.id);
    if (turn !== last && turn.end === undefined) report("running-before-last", opener);
    const openerTime = Date.parse(text(field(opener?.record, "timestamp")) ?? "");
    if (!Number.isNaN(openerTime) && Date.parse(turn.startedAt) !== openerTime) {
      report("start-not-opener-time", opener);
    }
    if (turn.end !== undefined && Date.parse(turn.end.at) < Date.parse(turn.startedAt)) {
      report("end-before-start", opener);
    }
    const lines = [...new Set(content.items.map((item) => item.lineUuid))].flatMap((uuid) => {
      const raw = first.get(uuid);
      return raw === undefined ? [] : [raw];
    });
    const answered = (raw: RawLine) =>
      [...descendants(raw, turn.id)].some(
        (next) => isRealReply(next.record) && lineTurn.get(next.uuid) === turn.id,
      );
    for (const raw of lines) {
      if (isInterruptLine(raw.record) && !answered(raw) && turn.end?.reason !== "interrupted") {
        report("interrupt-not-kept", raw, `ended ${turn.end?.reason ?? "running"}`);
      }
    }
    if (
      turn.end?.reason === "next-prompt" &&
      lines.some((raw) => isEndingReply(raw.record) && isRealReply(raw.record) && !answered(raw))
    ) {
      report("superseded-end-kept", opener);
    }
    for (const item of content.items) {
      const raw = first.get(item.lineUuid);
      if (item._tag === "Unreadable") {
        count("unreadable lines");
        if (raw !== undefined && isReadable(raw.record)) report("unreadable-but-readable", raw);
      }
      const marked =
        (item._tag === "Block" &&
          item.role === "user" &&
          item.lineUuid !== turn.id &&
          item.block.type === "text" &&
          MARKUP.test(item.block.text)) ||
        (item._tag === "Command" && item.text.trimStart().startsWith("<")) ||
        (item._tag === "CommandOutput" && item.output.some((part) => OUTPUT_TAG.test(part.text)));
      if (marked) report("raw-command-markup", raw, `${item._tag} of ${shapeOf(raw?.record)}`);
    }
    const prompt = content.prompt;
    if (prompt !== undefined && (MARKUP.test(prompt.text) || MARKUP.test(prompt.title ?? ""))) {
      report("raw-command-markup", opener, `prompt of ${shapeOf(opener?.record)}`);
    }
  }

  // A turn_duration line times the turn its chain is in, whatever else ended it.
  const durations = new Map<
    string,
    Array<{ readonly raw: RawLine; readonly durationMs: unknown }>
  >();
  for (const raw of first.values()) {
    if (typeOf(raw.record) !== "system" || subtypeOf(raw.record) !== "turn_duration") continue;
    const anchor = anchorOf(raw);
    const turnId = anchor === undefined ? undefined : turnOfLine(anchor.uuid);
    if (turnId === undefined) continue;
    const list = durations.get(turnId) ?? [];
    list.push({ raw, durationMs: field(raw.record, "durationMs") });
    durations.set(turnId, list);
  }
  for (const [turnId, list] of durations) {
    const end = turnIds.get(turnId)?.end;
    const kept =
      (end?.reason === "turn-duration" || end?.reason === "interrupted") &&
      list.some((timed) => timed.durationMs === end.durationMs);
    if (!kept) report("duration-not-kept", list[0]?.raw, `ended ${end?.reason ?? "running"}`);
  }

  const wholeText = JSON.stringify(input.structure);
  for (const other of input.others) {
    if (JSON.stringify(other.structure) === wholeText) continue;
    const index = input.structure.turns.findIndex(
      (turn, position) => JSON.stringify(turn) !== JSON.stringify(other.structure.turns[position]),
    );
    report(
      "differs-from-whole-read",
      undefined,
      `${other.name}: turn ${index === -1 ? input.structure.turns.length : index}; ${input.structure.turns.length} against ${other.structure.turns.length} turns`,
    );
  }
  return { violations, counts };
}
