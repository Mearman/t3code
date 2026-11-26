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
 * What opened a turn: a prompt the user typed, a meta line Claude Code wrote with a new prompt id (a task notification, say), a queued prompt delivered after the turn before it ended, a slash command, or a line with no turn above it and none started before it.
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
  /** Changes whenever anything above, or the bytes or order of any of those lines, does. */
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

export const NONE = -1;

const finiteOr = (value: number, fallback: number) => (Number.isNaN(value) ? fallback : value);

/** Orders timestamps with an unreadable one (NaN) after every readable one. */
export function compareTimes(left: number, right: number): number {
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

/** Where an entry hangs: its parent's position, or for a root the turn it is filed with by time. */
export interface ClaudeTranscriptEntryView {
  readonly up: number;
  /** The parent's turn, by opener entry; for a root, the host turn or NONE. */
  readonly parentTurn: number;
  /** The nearest line above that holds content or opens a turn. */
  readonly nearest: number;
  readonly parentDepth: number;
}

/** What the turn structure needs to know, beyond the index, to decide one entry. */
export interface ClaudeTranscriptDecisionInputs {
  readonly reachesReply: (entry: number) => boolean;
  readonly hasResult: (entry: number) => boolean;
  readonly turnOf: (entry: number) => number;
  /** The kind of the turn's opener, undefined while an update has closed that turn. */
  readonly openerKind: (turn: number) => ClaudeTranscriptOpener | undefined;
  readonly promptEntry: (turn: number) => number;
  readonly latestPromptTime: number;
}

export interface ClaudeTranscriptDecision {
  /** The entry's turn, by opener entry: the entry itself when it opens one, NONE for none. */
  readonly turn: number;
  readonly opens: ClaudeTranscriptOpener | undefined;
  readonly isItem: boolean;
  readonly isAnchor: boolean;
  readonly depth: number;
  /** For an opener, the entry whose prompt id the turn carries, or NONE. */
  readonly promptEntry: number;
  /** A command joined a tool call's turn only because no prompt is stamped after it yet. */
  readonly provisional: boolean;
}

/** The per-line rules every way of building turns shares, over one index. */
export class ClaudeTranscriptTurnRules {
  readonly index: ClaudeTranscriptIndex;
  constructor(index: ClaudeTranscriptIndex) {
    this.index = index;
  }

  kind(entry: number): number {
    return this.index.kind(entry);
  }
  is(entry: number, flag: number): boolean {
    return this.index.has(entry, flag);
  }
  /** Lines with no content of their own; a reply below one still answers what is above it. */
  passesThrough(entry: number): boolean {
    const kind = this.kind(entry);
    return (
      kind === Kind.Neutral ||
      kind === Kind.CompactBoundary ||
      (kind === Kind.User && (this.is(entry, Flag.Meta) || this.is(entry, Flag.CompactSummary)))
    );
  }
  isRealReply(entry: number): boolean {
    return this.kind(entry) === Kind.Assistant && !this.is(entry, Flag.Synthetic);
  }
  /** What a child gives its parent's `reachesReply`. */
  repliesUp(child: number, childReachesReply: boolean): boolean {
    return this.kind(child) === Kind.Assistant || (this.passesThrough(child) && childReachesReply);
  }
  isToolResult(entry: number): boolean {
    return this.kind(entry) === Kind.User && this.is(entry, Flag.ToolResult);
  }
  isInterrupt(entry: number): boolean {
    return this.kind(entry) === Kind.User && this.is(entry, Flag.Interrupt);
  }
  isEndingReply(entry: number): boolean {
    return this.kind(entry) === Kind.Assistant && this.is(entry, Flag.TurnEnd);
  }
  /** A user line a person typed, by its own fields; a later one shows an earlier wait ended. */
  isPromptLike(entry: number): boolean {
    return (
      this.kind(entry) === Kind.User &&
      !this.is(entry, Flag.Meta) &&
      !this.is(entry, Flag.CompactSummary) &&
      !this.is(entry, Flag.ToolResult) &&
      !this.is(entry, Flag.Interrupt) &&
      !this.is(entry, Flag.Output) &&
      (this.is(entry, Flag.Visible) || this.index.promptKey(entry) !== 0)
    );
  }
  /** A root filed with a turn by time: its parent is named but absent, or it is a compaction. */
  isDetachedRoot(entry: number): boolean {
    return this.index.parentUuid(entry) !== null || this.kind(entry) === Kind.CompactBoundary;
  }

  decide(
    entry: number,
    view: ClaudeTranscriptEntryView,
    inputs: ClaudeTranscriptDecisionInputs,
  ): ClaudeTranscriptDecision {
    const { up, parentTurn, nearest } = view;
    const kind = this.kind(entry);
    const promptKeyOf = (turn: number) => {
      const prompt = turn === NONE ? NONE : inputs.promptEntry(turn);
      return prompt === NONE ? 0 : this.index.promptKey(prompt);
    };
    const ownPrompt = this.index.promptKey(entry);
    const newPrompt = ownPrompt !== 0 && ownPrompt !== promptKeyOf(parentTurn);
    const endsTurn = (line: number) => {
      const turn = inputs.turnOf(line);
      const lineKind = this.kind(line);
      return (
        (lineKind === Kind.Assistant &&
          (this.is(line, Flag.TurnEnd) || this.is(line, Flag.Synthetic))) ||
        lineKind === Kind.TurnDuration ||
        this.isInterrupt(line) ||
        (turn !== NONE && inputs.openerKind(turn) === "command")
      );
    };

    let opens: ClaudeTranscriptOpener | undefined;
    let content = true;
    let item = true;
    let orphans = true;
    let provisional = false;
    switch (kind) {
      case Kind.User:
        if (this.is(entry, Flag.Meta)) {
          content = false;
          item = false;
          if (newPrompt && inputs.reachesReply(entry)) opens = "meta";
        } else if (this.is(entry, Flag.CompactSummary)) {
          content = false;
          item = false;
        } else if (
          !this.is(entry, Flag.ToolResult) &&
          !this.is(entry, Flag.Interrupt) &&
          !this.is(entry, Flag.Output)
        ) {
          if (this.is(entry, Flag.Visible) || newPrompt) opens = "prompt";
        }
        break;
      case Kind.Queued:
        if (parentTurn === NONE || nearest === NONE || endsTurn(nearest)) opens = "queued";
        break;
      case Kind.CommandInput: {
        const duplicate =
          up !== NONE &&
          parentTurn === up &&
          this.kind(up) === Kind.User &&
          this.is(entry, Flag.Visible) &&
          this.index.textHash(up) === this.index.textHash(entry);
        const onToolCall =
          parentTurn !== NONE &&
          nearest !== NONE &&
          this.kind(nearest) === Kind.Assistant &&
          this.is(nearest, Flag.ToolUse);
        // A call still waiting is taken to be running until a later prompt shows it died.
        const answered = onToolCall && inputs.hasResult(nearest);
        const waiting =
          onToolCall && !answered && !(inputs.latestPromptTime > this.index.timestamp(entry));
        if (duplicate) {
          content = false;
          item = false;
        } else if (answered || waiting) {
          provisional = waiting;
        } else {
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
      return {
        turn: parentTurn,
        opens,
        isItem: item && parentTurn !== NONE,
        isAnchor: content && parentTurn !== NONE,
        depth: up === NONE ? 0 : view.parentDepth + 1,
        promptEntry: NONE,
        provisional,
      };
    }
    const promptEntry =
      opens === "queued"
        ? parentTurn === NONE
          ? NONE
          : inputs.promptEntry(parentTurn)
        : opens === "command" || ownPrompt === 0
          ? NONE
          : entry;
    return { turn: entry, opens, isItem: true, isAnchor: true, depth: 0, promptEntry, provisional };
  }

  /** The prompt id a compaction's summary names, by its key; 0 for none or any other root. */
  summaryKey(
    root: number,
    eachChild: (entry: number, visit: (child: number) => void) => void,
  ): number {
    if (this.kind(root) !== Kind.CompactBoundary) return 0;
    let summary = NONE;
    eachChild(root, (child) => {
      if (!this.is(child, Flag.CompactSummary) || this.index.promptKey(child) === 0) return;
      if (summary === NONE || this.compareTurns(child, summary) < 0) summary = child;
    });
    return summary === NONE ? 0 : this.index.promptKey(summary);
  }

  /**
   * The turn a root filed by time joins: the latest eligible turn started at or before it that carries the summary's prompt id, when one is named and such a turn exists, else the latest eligible turn started at or before it. `byPromptKey` lists the turns carrying each prompt key and `candidates` every turn, both in turn order; `visit` counts each turn looked at.
   */
  hostFor(input: {
    readonly root: number;
    readonly summaryKey: number;
    readonly candidates: ReadonlyArray<number>;
    readonly byPromptKey: ReadonlyMap<number, ReadonlyArray<number>>;
    readonly eligible: (turn: number) => boolean;
    readonly visit: () => void;
  }): number {
    const named = input.summaryKey === 0 ? undefined : input.byPromptKey.get(input.summaryKey);
    const host = named === undefined ? NONE : this.latestEligible(input, named);
    return host === NONE ? this.latestEligible(input, input.candidates) : host;
  }

  /** The latest of `turns` (in turn order) started at or before `root` that `eligible` accepts. */
  latestEligible(
    input: {
      readonly root: number;
      readonly eligible: (turn: number) => boolean;
      readonly visit: () => void;
    },
    turns: ReadonlyArray<number>,
  ): number {
    const time = this.index.timestamp(input.root);
    let low = 0;
    let high = turns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareTimes(this.index.timestamp(at(turns, middle)), time) <= 0) low = middle + 1;
      else high = middle;
    }
    for (let position = low - 1; position >= 0; position--) {
      const turn = at(turns, position);
      input.visit();
      if (input.eligible(turn)) return turn;
    }
    return NONE;
  }

  /** Inserts `entry` into `list`, kept in turn order. */
  insertInTurnOrder(list: Array<number>, entry: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.compareTurns(at(list, middle), entry) < 0) low = middle + 1;
      else high = middle;
    }
    list.splice(low, 0, entry);
    return low;
  }

  /** Removes `entry` from `list`, kept in turn order; it must be there. */
  removeInTurnOrder(list: Array<number>, entry: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.compareTurns(at(list, middle), entry) < 0) low = middle + 1;
      else high = middle;
    }
    if (list[low] !== entry) throw new RangeError(`Entry ${entry} is not in its list.`);
    list.splice(low, 1);
    return low;
  }

  /** Item order within a turn: the opener first, then by time, depth and uuid. */
  compareLines(opener: number, left: number, leftDepth: number, right: number, rightDepth: number) {
    return (
      Number(left !== opener) - Number(right !== opener) ||
      compareTimes(this.index.timestamp(left), this.index.timestamp(right)) ||
      leftDepth - rightDepth ||
      compareStrings(this.index.uuid(left), this.index.uuid(right))
    );
  }

  /** Orders turns by opener: start time, then uuid. */
  compareTurns(left: number, right: number): number {
    return (
      compareTimes(this.index.timestamp(left), this.index.timestamp(right)) ||
      compareStrings(this.index.uuid(left), this.index.uuid(right))
    );
  }

  /** A later `turn_duration` line by time then uuid replaces an earlier one. */
  laterLine(left: number, right: number): boolean {
    return this.compareTurns(left, right) > 0;
  }

  /** One item line's share of its turn's digest; turns sum these, so lines add and leave cheaply. */
  lineShare(entry: number, depth: number): readonly [number, number] {
    const key = `${this.index.uuid(entry)}\u0000${this.index.lineHash(entry)}\u0000${this.index.timestamp(entry)}\u0000${depth}`;
    let first = 0x811c9dc5;
    let second = 0x01000193;
    for (let index = 0; index < key.length; index++) {
      const code = key.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x5bd1e995);
    }
    return [first >>> 0, (second ^ (second >>> 15)) >>> 0];
  }
}

/** What a turn's end, identity and digest are computed from. */
export interface ClaudeTranscriptTurnFacts {
  readonly opener: number;
  /** The opener's parent as the structure follows it: NONE for a root or a cut loop. */
  readonly up: number;
  readonly kind: ClaudeTranscriptOpener;
  readonly promptEntry: number;
  /** The opener's parent's turn, NONE when the opener is a root. */
  readonly parentTurn: number;
  /** The turn just before this one in turn order, NONE for the first. */
  readonly previous: number;
  readonly isLast: boolean;
  readonly latest: number;
  readonly interrupted: boolean;
  readonly replied: boolean;
  readonly duration: number;
  readonly lastAssistant: number;
  readonly shares: readonly [number, number];
}

const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));

/** A turn without its lines, and its digest; the lines are listed by whoever holds them. */
export function claudeTranscriptTurnIdentity(
  index: ClaudeTranscriptIndex,
  facts: ClaudeTranscriptTurnFacts,
) {
  const { opener } = facts;
  const start = finiteOr(index.timestamp(opener), 0);
  const reason: ClaudeTranscriptEndReason | undefined = facts.interrupted
    ? "interrupted"
    : facts.duration !== NONE
      ? "turn-duration"
      : facts.replied || facts.kind === "command"
        ? "turn-end"
        : facts.isLast
          ? undefined
          : "next-prompt";
  const identity = {
    id: index.uuid(opener),
    opener: facts.kind,
    parentUuid: index.parentUuid(opener),
    branchedFrom:
      facts.kind !== "command" &&
      facts.up !== NONE &&
      facts.parentTurn !== NONE &&
      facts.parentTurn !== facts.previous
        ? index.uuid(facts.up)
        : undefined,
    promptId: facts.promptEntry === NONE ? undefined : index.promptId(facts.promptEntry),
    startedAt: iso(start),
    end:
      reason === undefined
        ? undefined
        : {
            reason,
            at: iso(Math.max(start, finiteOr(facts.latest, start))),
            durationMs: facts.duration === NONE ? undefined : index.durationMs(facts.duration),
          },
    lastAssistantUuid: facts.lastAssistant === NONE ? undefined : index.uuid(facts.lastAssistant),
  };
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([identity, facts.shares[0], facts.shares[1]]))
    .digest("hex")
    .slice(0, 32);
  return { identity, digest };
}

/** Lines with a parent that loops back to them, cut at each loop's least uuid. */
export function claudeTranscriptCycleCuts(
  index: ClaudeTranscriptIndex,
  parentOf: (entry: number) => number,
  entries: Iterable<number>,
): Array<number> {
  const stamp = new Map<number, number>();
  const cuts: Array<number> = [];
  let run = 0;
  for (const start of entries) {
    if (stamp.has(start)) continue;
    run += 1;
    let entry = start;
    while (entry !== NONE && !stamp.has(entry)) {
      stamp.set(entry, run);
      entry = parentOf(entry);
    }
    if (entry === NONE || stamp.get(entry) !== run) continue;
    let least = entry;
    for (let member = parentOf(entry); member !== entry; member = parentOf(member)) {
      if (compareStrings(index.uuid(member), index.uuid(least)) < 0) least = member;
    }
    cuts.push(least);
  }
  return cuts;
}

/**
 * The complete turn structure of everything indexed, as a pure function of the index's entries; the definition every incremental result must equal. A line belongs to the turn of the nearest opener up its parent chain. A root whose parent is named but absent, or a compaction, is filed by time: roots are taken in order of time then uuid, and each is filed with the latest turn started at or before it among the turns of true roots' trees and earlier roots' trees, preferring one carrying the prompt id its compaction summary names. So a line written before its parent already sits where its parent will put it. File order decides only which copy of a uuid is the entry (the first well-formed one) and the session's titles and derivation (the latest line).
 */
export function claudeTranscriptStructure(index: ClaudeTranscriptIndex): ClaudeTranscriptStructure {
  const rules = new ClaudeTranscriptTurnRules(index);
  const count = index.entryCount;
  const parent = new Int32Array(count);
  for (let entry = 0; entry < count; entry++) parent[entry] = index.parent(entry);
  // Entries whose parents never reach a root sit on a loop, or below one.
  const reaches = new Uint8Array(count);
  const reachesRoot = (start: number) => {
    const path: Array<number> = [];
    let entry = start;
    const seen = new Set<number>();
    while (entry !== NONE && reaches[entry] === 0 && !seen.has(entry)) {
      seen.add(entry);
      path.push(entry);
      entry = at(parent, entry);
    }
    const rooted = entry === NONE || reaches[entry] === 1;
    if (rooted) for (const member of path) reaches[member] = 1;
    return rooted;
  };
  const looping: Array<number> = [];
  for (let entry = 0; entry < count; entry++) if (!reachesRoot(entry)) looping.push(entry);
  const cut = new Uint8Array(count);
  for (const entry of claudeTranscriptCycleCuts(index, (e) => at(parent, e), looping)) {
    cut[entry] = 1;
    parent[entry] = NONE;
  }

  const childStart = new Int32Array(count + 1);
  for (let entry = 0; entry < count; entry++) {
    const up = at(parent, entry);
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
  const detached = (entry: number) => cut[entry] === 0 && rules.isDetachedRoot(entry);

  // Parents before children: true roots and their trees, then each root filed by time with its
  // tree, in root order, since a root is filed among the turns of the trees before it.
  const order = new Int32Array(count);
  let tail = 0;
  const bfs = (roots: ReadonlyArray<number>) => {
    let head = tail;
    for (const root of roots) order[tail++] = root;
    while (head < tail) {
      eachChild(at(order, head++), (child) => {
        order[tail++] = child;
      });
    }
  };
  const trueRoots: Array<number> = [];
  const detachedRoots: Array<number> = [];
  for (let entry = 0; entry < count; entry++) {
    if (at(parent, entry) !== NONE) continue;
    (detached(entry) ? detachedRoots : trueRoots).push(entry);
  }
  bfs(trueRoots);
  const rootedCount = tail;
  detachedRoots.sort((left, right) => rules.compareTurns(left, right));
  for (const root of detachedRoots) bfs([root]);

  const reachesReply = new Uint8Array(count);
  const hasResult = new Uint8Array(count);
  for (let position = count - 1; position >= 0; position--) {
    const entry = at(order, position);
    eachChild(entry, (child) => {
      if (rules.repliesUp(child, reachesReply[child] === 1)) reachesReply[entry] = 1;
      if (rules.isToolResult(child)) hasResult[entry] = 1;
    });
  }
  let latestPromptTime = Number.NEGATIVE_INFINITY;
  for (let entry = 0; entry < count; entry++) {
    const time = index.timestamp(entry);
    if (rules.isPromptLike(entry) && !Number.isNaN(time) && time > latestPromptTime) {
      latestPromptTime = time;
    }
  }

  const turnOf = new Int32Array(count).fill(NONE);
  const anchor = new Int32Array(count).fill(NONE);
  const isAnchor = new Uint8Array(count);
  const isItem = new Uint8Array(count);
  const depth = new Int32Array(count);
  const openerKind = new Map<number, ClaudeTranscriptOpener>();
  const promptEntry = new Map<number, number>();
  const inputs: ClaudeTranscriptDecisionInputs = {
    reachesReply: (entry) => reachesReply[entry] === 1,
    hasResult: (entry) => hasResult[entry] === 1,
    turnOf: (entry) => at(turnOf, entry),
    openerKind: (turn) => openerKind.get(turn),
    promptEntry: (turn) => {
      const prompt = promptEntry.get(turn);
      if (prompt === undefined) throw new RangeError(`No turn ${turn}.`);
      return prompt;
    },
    latestPromptTime,
  };
  const kindOf = (opener: number) => {
    const kind = openerKind.get(opener);
    if (kind === undefined) throw new RangeError(`No turn ${opener}.`);
    return kind;
  };
  const openers: Array<number> = [];
  const byPromptKey = new Map<number, Array<number>>();
  const decideAt = (position: number, host: number) => {
    const entry = at(order, position);
    const up = at(parent, entry);
    const view: ClaudeTranscriptEntryView =
      up === NONE
        ? { up, parentTurn: host, nearest: NONE, parentDepth: -1 }
        : {
            up,
            parentTurn: at(turnOf, up),
            nearest: isAnchor[up] === 1 ? up : at(anchor, up),
            parentDepth: at(depth, up),
          };
    const decision = rules.decide(entry, view, inputs);
    turnOf[entry] = decision.turn;
    anchor[entry] = view.nearest;
    isAnchor[entry] = decision.isAnchor ? 1 : 0;
    isItem[entry] = decision.isItem ? 1 : 0;
    depth[entry] = decision.depth;
    if (decision.opens !== undefined) {
      openerKind.set(entry, decision.opens);
      promptEntry.set(entry, decision.promptEntry);
      rules.insertInTurnOrder(openers, entry);
      const key = decision.promptEntry === NONE ? 0 : index.promptKey(decision.promptEntry);
      if (key !== 0) {
        const list = byPromptKey.get(key) ?? [];
        rules.insertInTurnOrder(list, entry);
        byPromptKey.set(key, list);
      }
    }
  };
  for (let position = 0; position < rootedCount; position++) decideAt(position, NONE);
  let host = NONE;
  for (let position = rootedCount; position < count; position++) {
    const entry = at(order, position);
    if (at(parent, entry) === NONE) {
      host = rules.hostFor({
        root: entry,
        summaryKey: rules.summaryKey(entry, eachChild),
        candidates: openers,
        byPromptKey,
        eligible: () => true,
        visit: () => {},
      });
    }
    decideAt(position, host);
  }

  const realReplyBelow = new Uint8Array(count);
  for (let position = count - 1; position >= 0; position--) {
    const entry = at(order, position);
    eachChild(entry, (child) => {
      if (turnOf[child] !== turnOf[entry]) return;
      if (rules.isRealReply(child) || realReplyBelow[child] === 1) realReplyBelow[entry] = 1;
    });
  }

  interface Gathered {
    latest: number;
    interrupted: boolean;
    replied: boolean;
    duration: number;
    lines: Array<number>;
  }
  const gathered = new Map<number, Gathered>();
  for (const opener of openerKind.keys()) {
    gathered.set(opener, {
      latest: Number.NaN,
      interrupted: false,
      replied: false,
      duration: NONE,
      lines: [],
    });
  }
  for (let entry = 0; entry < count; entry++) {
    const turn = at(turnOf, entry);
    const facts = turn === NONE ? undefined : gathered.get(turn);
    if (facts === undefined) continue;
    const time = index.timestamp(entry);
    if (!Number.isNaN(time) && (Number.isNaN(facts.latest) || time > facts.latest))
      facts.latest = time;
    if (rules.isInterrupt(entry) && realReplyBelow[entry] === 0) facts.interrupted = true;
    if (rules.isEndingReply(entry) && realReplyBelow[entry] === 0) facts.replied = true;
    if (
      rules.kind(entry) === Kind.TurnDuration &&
      (facts.duration === NONE || rules.laterLine(entry, facts.duration))
    ) {
      facts.duration = entry;
    }
    if (isItem[entry] === 1) facts.lines.push(entry);
  }

  const sorted = [...openerKind.keys()].toSorted((left, right) => rules.compareTurns(left, right));
  const turns = sorted.map((opener, position): ClaudeTranscriptTurn => {
    const facts = gathered.get(opener);
    if (facts === undefined) throw new RangeError(`No turn ${opener}.`);
    const lines = facts.lines.toSorted((left, right) =>
      rules.compareLines(opener, left, at(depth, left), right, at(depth, right)),
    );
    let first = 0;
    let second = 0;
    for (const line of lines) {
      const [a, b] = rules.lineShare(line, at(depth, line));
      first = (first + a) >>> 0;
      second = (second + b) >>> 0;
    }
    const up = at(parent, opener);
    const { identity, digest } = claudeTranscriptTurnIdentity(index, {
      opener,
      up,
      kind: kindOf(opener),
      promptEntry: inputs.promptEntry(opener),
      parentTurn: up === NONE ? NONE : at(turnOf, up),
      previous: position === 0 ? NONE : at(sorted, position - 1),
      isLast: position === sorted.length - 1,
      latest: facts.latest,
      interrupted: facts.interrupted,
      replied: facts.replied,
      duration: facts.duration,
      lastAssistant: lines.findLast((line) => rules.kind(line) === Kind.Assistant) ?? NONE,
      shares: [first, second],
    });
    return { ...identity, lineUuids: lines.map((line) => index.uuid(line)), digest };
  });

  return {
    turns,
    aiTitle: index.aiTitle,
    customTitle: index.customTitle,
    derivedFrom: index.derivedFrom,
    forkedFromSessionId: sorted
      .map((opener) => index.forkSessionId(opener))
      .find((sessionId) => sessionId !== undefined),
  };
}
