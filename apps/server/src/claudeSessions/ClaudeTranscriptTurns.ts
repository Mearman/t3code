// A synchronous digest of a turn's identity, already in memory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

import {
  ClaudeTranscriptLineFlag as Flag,
  ClaudeTranscriptLineKind as Kind,
  type ClaudeTranscriptIndex,
} from "./ClaudeTranscriptIndex.ts";

export type ClaudeTranscriptEndReason =
  | "turn-end"
  | "turn-duration"
  | "interrupted"
  | "next-prompt";

/**
 * What opened a turn: a prompt the user typed, a meta line Claude Code wrote with a new prompt id (a task notification, say), a queued prompt delivered after the turn before it ended, a slash command, or a line whose parent is absent or null with no prompt before it.
 */
export type ClaudeTranscriptOpener = "prompt" | "meta" | "queued" | "command" | "orphan";

export interface ClaudeTranscriptTurnEnd {
  readonly reason: ClaudeTranscriptEndReason;
  /** The latest timestamp among the turn's lines, never before the turn started. */
  readonly at: string;
  readonly durationMs: number | undefined;
}

export interface ClaudeTranscriptTurn {
  /** The uuid of the line that opened the turn. */
  readonly id: string;
  readonly opener: ClaudeTranscriptOpener;
  readonly parentUuid: string | null;
  /** The opener's parent, when it is a line of a turn other than the one just before this. */
  readonly branchedFrom: string | undefined;
  readonly promptId: string | undefined;
  readonly startedAt: string;
  /** Undefined only for the last turn, while nothing shows it ended. */
  readonly end: ClaudeTranscriptTurnEnd | undefined;
  readonly lastAssistantUuid: string | undefined;
  /** The lines that give the turn content items, in item order, the opener first. */
  readonly lineUuids: ReadonlyArray<string>;
  /** Changes whenever anything above, or the bytes of any of those lines, does. */
  readonly digest: string;
}

export interface ClaudeTranscriptStructure {
  /** Ordered by when each turn started, then by opener uuid. */
  readonly turns: ReadonlyArray<ClaudeTranscriptTurn>;
  readonly aiTitle: string | undefined;
  readonly customTitle: string | undefined;
  readonly derivedFrom: ReadonlyArray<{ readonly sessionId: string; readonly via: string }>;
  /** The session the first turn copied from another session was copied from. */
  readonly forkedFromSessionId: string | undefined;
}

const NONE = -1;

const finiteOr = (value: number, fallback: number) => (Number.isNaN(value) ? fallback : value);

function compareNumbers(left: number, right: number): number {
  const a = finiteOr(left, Number.POSITIVE_INFINITY);
  const b = finiteOr(right, Number.POSITIVE_INFINITY);
  return a < b ? -1 : a > b ? 1 : 0;
}

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`No slot ${index}.`);
  return value;
}

/**
 * The complete turn structure of everything indexed, as a pure function of the index's entries. A line belongs to the turn of the nearest opener up its parent chain, so lines may be written in any order. File order decides only which copy of a uuid is the entry (the first well-formed one) and the session's titles and derivation (the latest line). Work is linear in entries apart from sorting each turn's lines and the turns.
 */
export function claudeTranscriptStructure(index: ClaudeTranscriptIndex): ClaudeTranscriptStructure {
  const count = index.entryCount;
  const parent = new Int32Array(count);
  const childStart = new Int32Array(count + 1);
  for (let entry = 0; entry < count; entry++) {
    const up = index.parent(entry);
    parent[entry] = up;
    if (up !== NONE) childStart[up + 1] = at(childStart, up + 1) + 1;
  }
  for (let entry = 0; entry < count; entry++) {
    childStart[entry + 1] = at(childStart, entry + 1) + at(childStart, entry);
  }
  const children = new Int32Array(at(childStart, count));
  const fill = childStart.slice(0, count);
  for (let entry = 0; entry < count; entry++) {
    const up = at(parent, entry);
    if (up === NONE) continue;
    children[at(fill, up)] = entry;
    fill[up] = at(fill, up) + 1;
  }
  const eachChild = (entry: number, visit: (child: number) => void) => {
    for (let slot = at(childStart, entry); slot < at(childStart, entry + 1); slot++) {
      visit(at(children, slot));
    }
  };

  // Parents before children. A cycle is cut at its least uuid, so file order cannot decide.
  const order = new Int32Array(count);
  const visited = new Uint8Array(count);
  let head = 0;
  let tail = 0;
  const drain = () => {
    while (head < tail) {
      eachChild(at(order, head++), (child) => {
        if (visited[child] === 1) return;
        visited[child] = 1;
        order[tail++] = child;
      });
    }
  };
  for (let entry = 0; entry < count; entry++) {
    if (at(parent, entry) !== NONE) continue;
    visited[entry] = 1;
    order[tail++] = entry;
  }
  drain();
  if (tail < count) {
    const cyclic = [...Array(count).keys()]
      .filter((entry) => visited[entry] === 0)
      .toSorted((left, right) => compareStrings(index.uuid(left), index.uuid(right)));
    for (const entry of cyclic) {
      if (visited[entry] === 1) continue;
      visited[entry] = 1;
      parent[entry] = NONE;
      order[tail++] = entry;
      drain();
    }
  }

  const kind = (entry: number) => index.kind(entry);
  const is = (entry: number, flag: number) => index.has(entry, flag);
  const passesThrough = (entry: number) =>
    kind(entry) === Kind.Neutral ||
    kind(entry) === Kind.CompactBoundary ||
    (kind(entry) === Kind.User && (is(entry, Flag.Meta) || is(entry, Flag.CompactSummary)));
  const isRealReply = (entry: number) =>
    kind(entry) === Kind.Assistant && !is(entry, Flag.Synthetic);

  // Whether a reply follows a line through lines that hold no content, and a tool use's result.
  const reachesReply = new Uint8Array(count);
  const hasResult = new Uint8Array(count);
  for (let position = count - 1; position >= 0; position--) {
    const entry = at(order, position);
    eachChild(entry, (child) => {
      if (kind(child) === Kind.Assistant || (passesThrough(child) && reachesReply[child] === 1)) {
        reachesReply[entry] = 1;
      }
      if (kind(child) === Kind.User && is(child, Flag.ToolResult)) hasResult[entry] = 1;
    });
  }

  const turnOf = new Int32Array(count).fill(NONE);
  const anchor = new Int32Array(count).fill(NONE);
  const isAnchor = new Uint8Array(count);
  const isItem = new Uint8Array(count);
  const depth = new Int32Array(count);
  const openers: Array<number> = [];
  const openerKinds: Array<ClaudeTranscriptOpener> = [];
  const promptEntry: Array<number> = [];

  const promptKeyOf = (turn: number) => {
    const entry = turn === NONE ? NONE : at(promptEntry, turn);
    return entry === NONE ? 0 : index.promptKey(entry);
  };
  // A line after which a queued prompt starts a new turn rather than joining a running one.
  const endsTurn = (entry: number) => {
    const turn = at(turnOf, entry);
    return (
      (kind(entry) === Kind.Assistant && (is(entry, Flag.TurnEnd) || is(entry, Flag.Synthetic))) ||
      kind(entry) === Kind.TurnDuration ||
      (kind(entry) === Kind.User && is(entry, Flag.Interrupt)) ||
      (turn !== NONE && at(openerKinds, turn) === "command")
    );
  };

  for (let position = 0; position < count; position++) {
    const entry = at(order, position);
    const up = at(parent, entry);
    const parentTurn = up === NONE ? NONE : at(turnOf, up);
    const parentPrompt = promptKeyOf(parentTurn);
    const nearest = up === NONE ? NONE : isAnchor[up] === 1 ? up : at(anchor, up);
    anchor[entry] = nearest;
    const ownPrompt = index.promptKey(entry);
    const newPrompt = ownPrompt !== 0 && ownPrompt !== parentPrompt;

    let opens: ClaudeTranscriptOpener | undefined;
    let content = true;
    let item = true;
    let orphans = true;
    switch (kind(entry)) {
      case Kind.User:
        if (is(entry, Flag.Meta)) {
          content = false;
          item = false;
          if (newPrompt && reachesReply[entry] === 1) opens = "meta";
        } else if (is(entry, Flag.CompactSummary)) {
          content = false;
          item = false;
        } else if (
          !is(entry, Flag.ToolResult) &&
          !is(entry, Flag.Interrupt) &&
          !is(entry, Flag.Output)
        ) {
          if (is(entry, Flag.Visible) || newPrompt) opens = "prompt";
        }
        break;
      case Kind.Queued:
        if (parentTurn === NONE || nearest === NONE || endsTurn(nearest)) opens = "queued";
        break;
      case Kind.CommandInput: {
        const duplicate =
          up !== NONE &&
          parentTurn !== NONE &&
          at(openers, parentTurn) === up &&
          kind(up) === Kind.User &&
          is(entry, Flag.Visible) &&
          index.textHash(up) === index.textHash(entry);
        const waitsOnTool =
          parentTurn !== NONE &&
          nearest !== NONE &&
          kind(nearest) === Kind.Assistant &&
          is(nearest, Flag.ToolUse) &&
          hasResult[nearest] === 1;
        if (duplicate) {
          content = false;
          item = false;
        } else if (!waitsOnTool) {
          opens = "command";
        }
        break;
      }
      case Kind.TurnDuration:
        item = false;
        orphans = false;
        break;
      case Kind.CompactBoundary:
        content = false;
        break;
      case Kind.Neutral:
        content = false;
        item = false;
        break;
      default:
        break;
    }
    if (opens === undefined && parentTurn === NONE && content && orphans) opens = "orphan";
    if (opens === undefined) {
      turnOf[entry] = parentTurn;
      depth[entry] = up === NONE ? 0 : at(depth, up) + 1;
      isItem[entry] = item && parentTurn !== NONE ? 1 : 0;
      isAnchor[entry] = content && parentTurn !== NONE ? 1 : 0;
      continue;
    }
    turnOf[entry] = openers.length;
    openers.push(entry);
    openerKinds.push(opens);
    promptEntry.push(
      opens === "queued"
        ? parentTurn === NONE
          ? NONE
          : at(promptEntry, parentTurn)
        : opens === "command"
          ? NONE
          : ownPrompt === 0
            ? NONE
            : entry,
    );
    depth[entry] = 0;
    isItem[entry] = 1;
    isAnchor[entry] = 1;
  }

  const turnCount = openers.length;
  const realReplyBelow = new Uint8Array(count);
  for (let position = count - 1; position >= 0; position--) {
    const entry = at(order, position);
    eachChild(entry, (child) => {
      if (turnOf[child] !== turnOf[entry]) return;
      if (isRealReply(child) || realReplyBelow[child] === 1) realReplyBelow[entry] = 1;
    });
  }

  const latest = new Float64Array(turnCount).fill(Number.NaN);
  const interrupted = new Uint8Array(turnCount);
  const replied = new Uint8Array(turnCount);
  const durationOf = new Int32Array(turnCount).fill(NONE);
  const members: Array<Array<number>> = Array.from({ length: turnCount }, () => []);
  const later = (left: number, right: number) =>
    compareNumbers(index.timestamp(left), index.timestamp(right)) ||
    compareStrings(index.uuid(left), index.uuid(right));
  for (let entry = 0; entry < count; entry++) {
    const turn = at(turnOf, entry);
    if (turn === NONE) continue;
    const time = index.timestamp(entry);
    const previous = at(latest, turn);
    if (!Number.isNaN(time) && (Number.isNaN(previous) || time > previous)) latest[turn] = time;
    if (kind(entry) === Kind.User && is(entry, Flag.Interrupt) && realReplyBelow[entry] === 0) {
      interrupted[turn] = 1;
    }
    if (kind(entry) === Kind.Assistant && is(entry, Flag.TurnEnd) && realReplyBelow[entry] === 0) {
      replied[turn] = 1;
    }
    if (kind(entry) === Kind.TurnDuration) {
      const chosen = at(durationOf, turn);
      if (chosen === NONE || later(entry, chosen) > 0) durationOf[turn] = entry;
    }
    if (isItem[entry] === 1) at(members, turn).push(entry);
  }

  const startOf = (turn: number) => index.timestamp(at(openers, turn));
  const sorted = [...Array(turnCount).keys()].toSorted(
    (left, right) =>
      compareNumbers(startOf(left), startOf(right)) ||
      compareStrings(index.uuid(at(openers, left)), index.uuid(at(openers, right))),
  );
  const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));

  const turns = sorted.map((turn, position): ClaudeTranscriptTurn => {
    const opener = at(openers, turn);
    const kindOfOpener = at(openerKinds, turn);
    const lines = at(members, turn).toSorted(
      (left, right) =>
        Number(left !== opener) - Number(right !== opener) ||
        compareNumbers(index.timestamp(left), index.timestamp(right)) ||
        at(depth, left) - at(depth, right) ||
        compareStrings(index.uuid(left), index.uuid(right)),
    );
    const up = at(parent, opener);
    const parentTurn = up === NONE ? NONE : at(turnOf, up);
    const previous = position === 0 ? NONE : at(sorted, position - 1);
    const branchedFrom =
      kindOfOpener !== "command" && parentTurn !== NONE && parentTurn !== previous
        ? index.uuid(up)
        : undefined;
    const start = finiteOr(startOf(turn), 0);
    const duration = at(durationOf, turn);
    const reason: ClaudeTranscriptEndReason | undefined =
      interrupted[turn] === 1
        ? "interrupted"
        : duration !== NONE
          ? "turn-duration"
          : replied[turn] === 1 || kindOfOpener === "command"
            ? "turn-end"
            : position < turnCount - 1
              ? "next-prompt"
              : undefined;
    const end =
      reason === undefined
        ? undefined
        : {
            reason,
            at: iso(Math.max(start, finiteOr(at(latest, turn), start))),
            durationMs: duration === NONE ? undefined : index.durationMs(duration),
          };
    const lastAssistant = lines.findLast((entry) => kind(entry) === Kind.Assistant);
    const promptOf = at(promptEntry, turn);
    const identity = {
      id: index.uuid(opener),
      opener: kindOfOpener,
      parentUuid: index.parentUuid(opener),
      branchedFrom,
      promptId: promptOf === NONE ? undefined : index.promptId(promptOf),
      startedAt: iso(start),
      end,
      lastAssistantUuid: lastAssistant === undefined ? undefined : index.uuid(lastAssistant),
      lineUuids: lines.map((entry) => index.uuid(entry)),
    };
    const digest = NodeCrypto.createHash("sha256")
      .update(JSON.stringify([identity, lines.map((entry) => index.lineHash(entry))]))
      .digest("hex")
      .slice(0, 32);
    return { ...identity, digest };
  });

  const forked = sorted
    .map((turn) => index.forkSessionId(at(openers, turn)))
    .find((sessionId) => sessionId !== undefined);
  return {
    turns,
    aiTitle: index.aiTitle,
    customTitle: index.customTitle,
    derivedFrom: index.derivedFrom,
    forkedFromSessionId: forked,
  };
}
