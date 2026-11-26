import * as Effect from "effect/Effect";

import {
  ClaudeTranscriptColumn,
  ClaudeTranscriptIndex,
  ClaudeTranscriptLineFlag as Flag,
  ClaudeTranscriptLineKind as Kind,
  syncClaudeTranscriptIndex,
} from "./ClaudeTranscriptIndex.ts";
import {
  NONE,
  claudeTranscriptCycleCuts,
  claudeTranscriptTurnIdentity,
  compareTimes,
  ClaudeTranscriptTurnRules,
  type ClaudeTranscriptDecision,
  type ClaudeTranscriptDecisionInputs,
  type ClaudeTranscriptEntryView,
  type ClaudeTranscriptOpener,
  type ClaudeTranscriptStructure,
  type ClaudeTranscriptTurn,
} from "./ClaudeTranscriptTurns.ts";

const OPENERS: ReadonlyArray<ClaudeTranscriptOpener> = [
  "prompt",
  "meta",
  "queued",
  "command",
  "orphan",
];
const openerCode = (opens: ClaudeTranscriptOpener | undefined) =>
  opens === undefined ? 0 : OPENERS.indexOf(opens) + 1;
function openerOf(code: number): ClaudeTranscriptOpener {
  const opener = OPENERS[code - 1];
  if (opener === undefined) throw new RangeError(`Entry opens no turn (${code}).`);
  return opener;
}

// Per-entry bits.
const IN_FOREST = 1;
const ITEM = 2;
const ANCHOR = 4;
const PROVISIONAL = 8;
const ROOTED = 16;
const CUT = 32;
const DETACHED = 64;
// Per-entry bottom-up flags.
const REACHES_REPLY = 1;
const HAS_RESULT = 2;
const REPLY_BELOW = 4;

const int32 = () => new ClaudeTranscriptColumn((length) => new Int32Array(length));
const makeEntryState = () => ({
  bits: new ClaudeTranscriptColumn((length) => new Uint8Array(length)),
  flags: new ClaudeTranscriptColumn((length) => new Uint8Array(length)),
  opens: new ClaudeTranscriptColumn((length) => new Uint8Array(length)),
  turn: int32(),
  anchor: int32(),
  depth: int32(),
  up: int32(),
  host: int32(),
  rootOf: int32(),
  promptEntry: int32(),
  branchParentTurn: int32(),
  shareFirst: new ClaudeTranscriptColumn((length) => new Uint32Array(length)),
  shareSecond: new ClaudeTranscriptColumn((length) => new Uint32Array(length)),
  // Children by parent uuid key, as a linked list stored one higher so zero means none.
  firstChild: int32(),
  nextSibling: int32(),
  queued: new ClaudeTranscriptColumn((length) => new Uint8Array(length)),
});

/** Where an entry hangs, and the facts about its tree its decision and bookkeeping need. */
interface Placement {
  readonly view: ClaudeTranscriptEntryView;
  readonly host: number;
  readonly rooted: boolean;
  readonly detached: boolean;
  readonly rootOf: number;
}

class TurnState {
  readonly opener: number;
  /** The opener's uuid, kept so a reset index cannot change the id a removal reports. */
  readonly id: string;
  open = true;
  readonly members = new Set<number>();
  latest = Number.NaN;
  staleLatest = false;
  interrupts = 0;
  endingReplies = 0;
  duration = NONE;
  staleDuration = false;
  lastAssistant = NONE;
  staleLastAssistant = false;
  shareFirst = 0;
  shareSecond = 0;
  digest: string | undefined = undefined;
  constructor(opener: number, id: string) {
    this.opener = opener;
    this.id = id;
  }
}

/** What one `update` changed, by opener uuid. */
export interface ClaudeTranscriptTurnUpdate {
  /** Turns that are new or whose digest changed. */
  readonly changedTurnIds: ReadonlyArray<string>;
  /** Turns that existed before and exist no longer. */
  readonly removedTurnIds: ReadonlyArray<string>;
  /** The titles or derivation lines changed. */
  readonly factsChanged: boolean;
  readonly malformedOffsets: ReadonlyArray<number>;
  /** Everything was recomputed: the index was reset, a line replaced, or a loop closed. */
  readonly rebuilt: boolean;
  /** Work done: entry decisions made and turn digests computed. */
  readonly decided: number;
  readonly digested: number;
  /** Roots filed by time looked at, and turns looked at to file them. */
  readonly hostVisits: number;
}

/** A turn that opened, closed, or changed prompt id or tree, with the prompt keys involved. */
interface HostCheck {
  readonly opener: number;
  readonly keys: ReadonlyArray<number>;
}

/**
 * The turn structure of a growing transcript, kept up to date as lines are indexed. Each update works on what the new lines change: their own decisions, the subtree below a late parent, the lines below a line whose tool result or reply arrived, and the turns those touch. It always equals `claudeTranscriptStructure` of its index. Replacing an unreadable line, resetting the index or closing a parent loop through earlier lines recomputes everything.
 */
export class ClaudeTranscriptTurnTracker {
  readonly index = new ClaudeTranscriptIndex();
  readonly #rules = new ClaudeTranscriptTurnRules(this.index);
  #generation = 0;
  #s = makeEntryState();
  #turns = new Map<number, TurnState>();
  #order: Array<number> = [];
  #detachedRoots: Array<number> = [];
  #provisional = new Set<number>();
  #latestPromptTime = Number.NEGATIVE_INFINITY;
  #forkTurns = 0;
  #dirty = new Set<number>();
  #changedEntries: Array<number> = [];
  // Times from which roots filed by time are checked again, and roots to check by name.
  #hostChecks: Array<HostCheck> = [];
  #rootChecks = new Set<number>();
  #byPromptKey = new Map<number, Array<number>>();
  #hostedBy = new Map<number, Set<number>>();
  #summaryKeys = new Map<number, number>();
  #summaryRoots = new Map<number, Set<number>>();
  #decided = 0;
  #digested = 0;
  #hostVisits = 0;
  readonly #inputs: ClaudeTranscriptDecisionInputs;

  constructor() {
    const tracker = this;
    this.#inputs = {
      reachesReply: (entry) => this.#flag(entry, REACHES_REPLY),
      hasResult: (entry) => this.#flag(entry, HAS_RESULT),
      turnOf: (entry) => this.#s.turn.get(entry),
      openerKind: (turn) => {
        const code = this.#s.opens.get(turn);
        return code === 0 ? undefined : openerOf(code);
      },
      promptEntry: (turn) => this.#s.promptEntry.get(turn),
      get latestPromptTime() {
        return tracker.#latestPromptTime;
      },
    };
  }

  #bit(entry: number, bit: number): boolean {
    return (this.#s.bits.read(entry, 0) & bit) !== 0;
  }
  #setBit(entry: number, bit: number, on: boolean): void {
    const bits = this.#s.bits.read(entry, 0);
    this.#s.bits.set(entry, on ? bits | bit : bits & ~bit);
  }
  #flag(entry: number, flag: number): boolean {
    return (this.#s.flags.read(entry, 0) & flag) !== 0;
  }
  #setFlag(entry: number, flag: number, on: boolean): boolean {
    const flags = this.#s.flags.read(entry, 0);
    const next = on ? flags | flag : flags & ~flag;
    this.#s.flags.set(entry, next);
    return next !== flags;
  }
  #inForest(entry: number): boolean {
    return this.#bit(entry, IN_FOREST);
  }
  #effectiveParent(entry: number): number {
    return this.#bit(entry, CUT) ? NONE : this.index.parent(entry);
  }
  #eachChild(entry: number, visit: (child: number) => void): void {
    const key = this.index.uuidKey(entry);
    for (let child = this.#s.firstChild.read(key, 0) - 1; child !== NONE;) {
      const next = this.#s.nextSibling.get(child) - 1;
      if (!this.#bit(child, CUT)) visit(child);
      child = next;
    }
  }
  #turnState(turn: number): TurnState {
    const state = this.#turns.get(turn);
    if (state === undefined) throw new RangeError(`No turn ${turn}.`);
    return state;
  }

  /** Whether a turn opened by this uuid exists. */
  hasTurn(id: string): boolean {
    const entry = this.index.entryOf(id);
    return entry !== undefined && this.#turns.get(entry)?.open === true;
  }

  /** Brings the turns up to date with every line indexed since the last update. */
  update(): ClaudeTranscriptTurnUpdate {
    this.#decided = 0;
    this.#digested = 0;
    this.#hostVisits = 0;
    const changes = this.index.takeChanges();
    const applied =
      changes.generation !== this.#generation || changes.replaced
        ? "rebuild"
        : this.#apply(changes.added, true);
    const result =
      applied === "rebuild" || applied === "loop"
        ? { ...this.#rebuild(changes.generation), factsChanged: true }
        : { ...applied, rebuilt: false, factsChanged: changes.factsChanged };
    return {
      ...result,
      malformedOffsets: changes.malformedOffsets,
      decided: this.#decided,
      digested: this.#digested,
      hostVisits: this.#hostVisits,
    };
  }

  #rebuild(generation: number) {
    const before = this.#order.map((opener) => this.#turnState(opener).id);
    this.#generation = generation;
    this.#s = makeEntryState();
    this.#turns = new Map();
    this.#order = [];
    this.#detachedRoots = [];
    this.#provisional = new Set();
    this.#hostChecks = [];
    this.#rootChecks = new Set();
    this.#byPromptKey = new Map();
    this.#hostedBy = new Map();
    this.#summaryKeys = new Map();
    this.#summaryRoots = new Map();
    this.#latestPromptTime = Number.NEGATIVE_INFINITY;
    this.#forkTurns = 0;
    const all = Array.from({ length: this.index.entryCount }, (_, entry) => entry);
    const applied = this.#apply(all, false);
    if (applied === "loop") throw new Error("A rebuild found a parent loop it could not cut.");
    const after = this.#order.map((opener) => this.index.uuid(opener));
    const present = new Set(after);
    return {
      changedTurnIds: after,
      removedTurnIds: before.filter((id) => !present.has(id)),
      rebuilt: true,
    };
  }

  #apply(added: ReadonlyArray<number>, incremental: boolean) {
    const roots: Array<number> = [];
    const forcedAnchors = new Set<number>();
    const rules = this.#rules;
    for (const entry of added) {
      const key = this.index.parentKey(entry);
      if (key >= 0) {
        this.#s.nextSibling.set(entry, this.#s.firstChild.read(key, 0));
        this.#s.firstChild.set(key, entry + 1);
      }
    }
    for (const entry of added) {
      this.#refreshFlags(entry, roots, forcedAnchors);
      const up = this.index.parent(entry);
      if (up !== NONE) this.#refreshFlagsUp(up, roots, forcedAnchors);
    }
    let latest = this.#latestPromptTime;
    for (const entry of added) {
      const time = this.index.timestamp(entry);
      if (rules.isPromptLike(entry) && !Number.isNaN(time) && time > latest) latest = time;
    }
    if (latest > this.#latestPromptTime) {
      this.#latestPromptTime = latest;
      for (const command of this.#provisional) {
        if (latest > this.index.timestamp(command)) roots.push(command);
      }
    }
    for (const entry of added) {
      if (incremental && this.#closesLoop(entry)) return "loop" as const;
      roots.push(entry);
      const up = this.index.parent(entry);
      if (
        up !== NONE &&
        this.#rules.isDetachedRoot(up) &&
        this.#rules.is(entry, Flag.CompactSummary)
      ) {
        this.#rootChecks.add(up);
      }
    }
    this.#propagate(roots, forcedAnchors);
    const left = added.filter((entry) => !this.#inForest(entry));
    if (left.length > 0) {
      const cuts = claudeTranscriptCycleCuts(this.index, (entry) => this.index.parent(entry), left);
      for (const cut of cuts) {
        const up = this.index.parent(cut);
        this.#setBit(cut, CUT, true);
        if (up !== NONE) this.#recomputeFlagsUp(up);
      }
      this.#propagate(cuts, forcedAnchors);
      if (added.some((entry) => !this.#inForest(entry))) {
        throw new Error("Transcript lines were left outside every tree.");
      }
    }
    this.#refileByTime(forcedAnchors);
    this.#refreshRepliesBelow();
    return this.#settleTurns();
  }

  // A late parent closes a loop when its own chain leads back into the trees waiting on it.
  #closesLoop(entry: number): boolean {
    const waiting = this.#s.firstChild.read(this.index.uuidKey(entry), 0) !== 0;
    if (!waiting) return false;
    const seen = new Set<number>([entry]);
    for (let up = this.index.parent(entry); up !== NONE;) {
      if (seen.has(up)) return up === entry || this.#inForest(up);
      seen.add(up);
      if (!this.#inForest(up)) {
        up = this.index.parent(up);
      } else if (this.#bit(up, ROOTED)) {
        return false;
      } else {
        const root = this.#s.rootOf.get(up);
        const above = this.index.parent(root);
        if (above === entry) return true;
        seen.add(root);
        up = above;
      }
    }
    return false;
  }

  // Recomputes an entry's bottom-up flags from its children; a flip may change a decision.
  #refreshFlags(entry: number, roots: Array<number>, forcedAnchors: Set<number>): boolean {
    let reaches = false;
    let result = false;
    this.#eachChild(entry, (child) => {
      if (this.#rules.repliesUp(child, this.#flag(child, REACHES_REPLY))) reaches = true;
      if (this.#rules.isToolResult(child)) result = true;
    });
    const reachesChanged = this.#setFlag(entry, REACHES_REPLY, reaches);
    const resultChanged = this.#setFlag(entry, HAS_RESULT, result);
    if (this.#inForest(entry)) {
      if (reachesChanged) roots.push(entry);
      if (resultChanged) {
        forcedAnchors.add(entry);
        roots.push(entry);
      }
    }
    return reachesChanged;
  }
  #refreshFlagsUp(start: number, roots: Array<number>, forcedAnchors: Set<number>): void {
    for (let entry = start; entry !== NONE; entry = this.#effectiveParent(entry)) {
      if (!this.#refreshFlags(entry, roots, forcedAnchors) || !this.#rules.passesThrough(entry))
        return;
    }
  }
  #recomputeFlagsUp(start: number): void {
    this.#refreshFlagsUp(start, [], new Set());
  }

  #keyOf(promptEntry: number): number {
    return promptEntry === NONE ? 0 : this.index.promptKey(promptEntry);
  }
  #summaryKeyOf(root: number): number {
    return this.#rules.summaryKey(root, (entry, visit) => this.#eachChild(entry, visit));
  }

  // A root filed by time may join any turn of a true root's tree or an earlier root's tree.
  #hostFor(root: number): number {
    return this.#rules.hostFor({
      root,
      summaryKey: this.#summaryKeyOf(root),
      candidates: this.#order,
      byPromptKey: this.#byPromptKey,
      eligible: (turn) => {
        const other = this.#s.rootOf.get(turn);
        return other === NONE || this.#rules.compareTurns(other, root) < 0;
      },
      visit: () => {
        this.#hostVisits += 1;
      },
    });
  }

  // Which roots name each prompt key in their summary, so a turn carrying it finds them.
  #refreshSummaryKey(root: number): void {
    const before = this.#summaryKeys.get(root) ?? 0;
    const after = this.#bit(root, DETACHED) ? this.#summaryKeyOf(root) : 0;
    if (before === after) return;
    this.#summaryRoots.get(before)?.delete(root);
    if (after === 0) {
      this.#summaryKeys.delete(root);
      return;
    }
    this.#summaryKeys.set(root, after);
    const roots = this.#summaryRoots.get(after) ?? new Set<number>();
    roots.add(root);
    this.#summaryRoots.set(after, roots);
  }

  #inList(map: Map<number, Array<number>>, key: number, entry: number, present: boolean): void {
    const list = map.get(key) ?? [];
    if (present) this.#rules.insertInTurnOrder(list, entry);
    else this.#rules.removeInTurnOrder(list, entry);
    if (list.length === 0) map.delete(key);
    else map.set(key, list);
  }

  #place(entry: number): Placement | undefined {
    const up = this.#effectiveParent(entry);
    if (up === NONE) {
      const detached = !this.#bit(entry, CUT) && this.#rules.isDetachedRoot(entry);
      const host = detached ? this.#hostFor(entry) : NONE;
      const view: ClaudeTranscriptEntryView = {
        up,
        parentTurn: host,
        nearest: NONE,
        parentDepth: -1,
      };
      return { view, host, rooted: !detached, detached, rootOf: detached ? entry : NONE };
    }
    if (!this.#inForest(up)) return undefined;
    const rooted = this.#bit(up, ROOTED);
    const view: ClaudeTranscriptEntryView = {
      up,
      parentTurn: this.#s.turn.get(up),
      nearest: this.#bit(up, ANCHOR) ? up : this.#s.anchor.get(up),
      parentDepth: this.#s.depth.get(up),
    };
    return {
      view,
      host: NONE,
      rooted,
      detached: false,
      rootOf: rooted ? NONE : this.#s.rootOf.get(up),
    };
  }

  #propagate(roots: ReadonlyArray<number>, forcedAnchors: ReadonlySet<number>): void {
    const queue: Array<number> = [];
    const enqueue = (entry: number) => {
      if (this.#s.queued.read(entry, 0) === 1) return;
      this.#s.queued.set(entry, 1);
      queue.push(entry);
    };
    for (const root of roots) enqueue(root);
    for (let head = 0; head < queue.length; head++) {
      const entry = queue[head];
      if (entry === undefined) break;
      this.#s.queued.set(entry, 0);
      const placed = this.#place(entry);
      if (placed === undefined) continue;
      const decision = this.#rules.decide(entry, placed.view, this.#inputs);
      this.#decided += 1;
      const before =
        this.#inForest(entry) && this.#s.opens.get(entry) !== 0
          ? this.#s.promptEntry.get(entry)
          : undefined;
      const changed = this.#record(entry, placed, decision);
      // Every line whose parent is in this turn reads its prompt id, whatever its depth, and so
      // does every root filed with it by time.
      if (decision.opens !== undefined && before !== undefined && before !== decision.promptEntry) {
        for (const member of this.#turnState(entry).members) {
          enqueue(member);
          this.#eachChild(member, enqueue);
        }
        for (const root of this.#hostedBy.get(entry) ?? []) enqueue(root);
      }
      const anchor = this.#s.anchor.get(entry);
      if (
        changed ||
        forcedAnchors.has(entry) ||
        (!this.#bit(entry, ANCHOR) && forcedAnchors.has(anchor))
      ) {
        this.#eachChild(entry, enqueue);
      }
    }
  }

  #record(entry: number, placed: Placement, decision: ClaudeTranscriptDecision): boolean {
    const s = this.#s;
    const { view } = placed;
    const was = this.#inForest(entry);
    const old = was
      ? {
          turn: s.turn.get(entry),
          opens: s.opens.get(entry),
          item: this.#bit(entry, ITEM),
          anchorBit: this.#bit(entry, ANCHOR),
          depth: s.depth.get(entry),
          anchor: s.anchor.get(entry),
          promptEntry: s.promptEntry.get(entry),
          rooted: this.#bit(entry, ROOTED),
          rootOf: s.rootOf.get(entry),
          up: s.up.get(entry),
          host: s.host.get(entry),
          branchParentTurn: s.branchParentTurn.get(entry),
          provisional: this.#bit(entry, PROVISIONAL),
          detached: this.#bit(entry, DETACHED),
        }
      : undefined;
    const opens = openerCode(decision.opens);
    const branchParentTurn = view.up === NONE ? NONE : view.parentTurn;
    const moved =
      old === undefined ||
      old.turn !== decision.turn ||
      old.item !== decision.isItem ||
      old.depth !== decision.depth;
    if (old !== undefined && moved) this.#removeMember(old.turn, entry);
    if (old !== undefined && old.opens !== 0 && opens === 0) this.#closeTurn(entry);

    this.#setBit(entry, IN_FOREST, true);
    this.#setBit(entry, ITEM, decision.isItem);
    this.#setBit(entry, ANCHOR, decision.isAnchor);
    this.#setBit(entry, ROOTED, placed.rooted);
    this.#setBit(entry, PROVISIONAL, decision.provisional);
    this.#setBit(entry, DETACHED, placed.detached);
    s.turn.set(entry, decision.turn);
    s.opens.set(entry, opens);
    s.depth.set(entry, decision.depth);
    s.anchor.set(entry, view.nearest);
    s.promptEntry.set(entry, decision.promptEntry);
    s.rootOf.set(entry, placed.rootOf);
    s.up.set(entry, view.up);
    s.host.set(entry, placed.host);
    s.branchParentTurn.set(entry, branchParentTurn);

    if (opens !== 0 && (old === undefined || old.opens === 0)) this.#openTurn(entry);
    this.#refileIndexes(entry, old, opens !== 0, decision.promptEntry, placed);
    if (moved) this.#addMember(decision.turn, entry);
    if (
      opens !== 0 &&
      (old === undefined ||
        old.opens !== opens ||
        old.promptEntry !== decision.promptEntry ||
        old.branchParentTurn !== branchParentTurn ||
        old.up !== view.up)
    ) {
      this.#dirty.add(entry);
    }
    if (decision.provisional) this.#provisional.add(entry);
    else this.#provisional.delete(entry);
    if ((old?.detached ?? false) !== placed.detached) {
      if (placed.detached) this.#insertSorted(this.#detachedRoots, entry);
      else this.#removeSorted(this.#detachedRoots, entry);
    }
    if (placed.detached || old?.detached === true) this.#refreshSummaryKey(entry);
    const changed =
      old === undefined ||
      moved ||
      old.opens !== opens ||
      old.anchor !== view.nearest ||
      old.anchorBit !== decision.isAnchor ||
      old.promptEntry !== decision.promptEntry ||
      old.rooted !== placed.rooted ||
      old.rootOf !== placed.rootOf ||
      old.host !== placed.host ||
      old.up !== view.up;
    if (changed) this.#changedEntries.push(entry);
    return changed;
  }

  #insertSorted(list: Array<number>, entry: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = list[middle];
      if (other === undefined) throw new RangeError(`No slot ${middle}.`);
      if (this.#rules.compareTurns(other, entry) < 0) low = middle + 1;
      else high = middle;
    }
    list.splice(low, 0, entry);
    return low;
  }
  #removeSorted(list: Array<number>, entry: number): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = list[middle];
      if (other === undefined) throw new RangeError(`No slot ${middle}.`);
      if (this.#rules.compareTurns(other, entry) < 0) low = middle + 1;
      else high = middle;
    }
    if (list[low] !== entry) throw new RangeError(`Entry ${entry} is not in its list.`);
    list.splice(low, 1);
    return low;
  }
  // A turn's branch depends on the turn before it, and its end on whether it is last.
  #markInserted(position: number): void {
    const next = this.#order[position + 1];
    if (next !== undefined) this.#dirty.add(next);
    const before = this.#order[position - 1];
    if (before !== undefined && position === this.#order.length - 1) this.#dirty.add(before);
  }
  #markRemoved(position: number): void {
    const next = this.#order[position];
    if (next !== undefined) this.#dirty.add(next);
    const last = this.#order.at(-1);
    if (last !== undefined && position === this.#order.length) this.#dirty.add(last);
  }

  // Keeps the lists filing by time reads, and records what a change there can move.
  #refileIndexes(
    entry: number,
    old:
      | {
          readonly opens: number;
          readonly promptEntry: number;
          readonly rootOf: number;
          readonly host: number;
          readonly detached: boolean;
        }
      | undefined,
    isOpener: boolean,
    promptEntry: number,
    placed: Placement,
  ): void {
    const wasOpener = old !== undefined && old.opens !== 0;
    const oldKey = wasOpener ? this.#keyOf(old.promptEntry) : 0;
    const newKey = isOpener ? this.#keyOf(promptEntry) : 0;
    if (wasOpener && oldKey !== 0 && (!isOpener || oldKey !== newKey)) {
      this.#inList(this.#byPromptKey, oldKey, entry, false);
    }
    if (isOpener && newKey !== 0 && (!wasOpener || oldKey !== newKey)) {
      this.#inList(this.#byPromptKey, newKey, entry, true);
    }
    if (
      wasOpener !== isOpener ||
      oldKey !== newKey ||
      (isOpener && old !== undefined && old.rootOf !== placed.rootOf)
    ) {
      this.#hostChecks.push({ opener: entry, keys: [oldKey, newKey] });
    }
    const oldHost = old?.detached === true ? old.host : NONE;
    const newHost = placed.detached ? placed.host : NONE;
    if (oldHost !== newHost) {
      this.#hostedBy.get(oldHost)?.delete(entry);
      if (newHost !== NONE) {
        const hosted = this.#hostedBy.get(newHost) ?? new Set<number>();
        hosted.add(entry);
        this.#hostedBy.set(newHost, hosted);
      }
    }
  }

  #openTurn(entry: number): void {
    const state = this.#turns.get(entry) ?? new TurnState(entry, this.index.uuid(entry));
    state.open = true;
    this.#turns.set(entry, state);
    this.#markInserted(this.#insertSorted(this.#order, entry));
    this.#dirty.add(entry);
    if (this.index.forkSessionId(entry) !== undefined) this.#forkTurns += 1;
  }
  #closeTurn(entry: number): void {
    this.#turnState(entry).open = false;
    this.#markRemoved(this.#removeSorted(this.#order, entry));
    this.#dirty.add(entry);
    if (this.index.forkSessionId(entry) !== undefined) this.#forkTurns -= 1;
  }

  #addMember(turn: number, entry: number): void {
    if (turn === NONE) return;
    const state = this.#turnState(turn);
    const rules = this.#rules;
    state.members.add(entry);
    this.#dirty.add(turn);
    const time = this.index.timestamp(entry);
    if (!Number.isNaN(time) && (Number.isNaN(state.latest) || time > state.latest))
      state.latest = time;
    const below = this.#flag(entry, REPLY_BELOW);
    if (rules.isInterrupt(entry) && !below) state.interrupts += 1;
    if (rules.isEndingReply(entry) && !below) state.endingReplies += 1;
    if (
      rules.kind(entry) === Kind.TurnDuration &&
      (state.duration === NONE || rules.laterLine(entry, state.duration))
    ) {
      state.duration = entry;
    }
    if (!this.#bit(entry, ITEM)) return;
    const depth = this.#s.depth.get(entry);
    const [first, second] = rules.lineShare(entry, depth);
    this.#s.shareFirst.set(entry, first);
    this.#s.shareSecond.set(entry, second);
    state.shareFirst = (state.shareFirst + first) >>> 0;
    state.shareSecond = (state.shareSecond + second) >>> 0;
    if (
      rules.kind(entry) === Kind.Assistant &&
      !state.staleLastAssistant &&
      this.#laterAssistant(turn, entry, state.lastAssistant)
    ) {
      state.lastAssistant = entry;
    }
  }
  #laterAssistant(turn: number, entry: number, than: number): boolean {
    return (
      than === NONE ||
      this.#rules.compareLines(
        turn,
        entry,
        this.#s.depth.get(entry),
        than,
        this.#s.depth.get(than),
      ) > 0
    );
  }
  #removeMember(turn: number, entry: number): void {
    if (turn === NONE) return;
    const state = this.#turnState(turn);
    const rules = this.#rules;
    state.members.delete(entry);
    this.#dirty.add(turn);
    if (this.index.timestamp(entry) === state.latest) state.staleLatest = true;
    const below = this.#flag(entry, REPLY_BELOW);
    if (rules.isInterrupt(entry) && !below) state.interrupts -= 1;
    if (rules.isEndingReply(entry) && !below) state.endingReplies -= 1;
    if (state.duration === entry) state.staleDuration = true;
    if (!this.#bit(entry, ITEM)) return;
    state.shareFirst = (state.shareFirst - this.#s.shareFirst.get(entry)) >>> 0;
    state.shareSecond = (state.shareSecond - this.#s.shareSecond.get(entry)) >>> 0;
    if (state.lastAssistant === entry) state.staleLastAssistant = true;
  }

  // Roots filed by time move when a turn starts, stops, or changes prompt id or tree at or before
  // them, up to the next turn every root may join, or when the summary they name arrives; a move
  // can open or close turns that move later roots in turn. Roots with no readable time sort after
  // every turn, so any change may move them.
  #refileByTime(forcedAnchors: ReadonlySet<number>): void {
    while (this.#hostChecks.length > 0 || this.#rootChecks.size > 0) {
      const candidates = new Set<number>();
      for (const root of this.#rootChecks) {
        this.#refreshSummaryKey(root);
        candidates.add(root);
      }
      this.#rootChecks = new Set();
      const checks = this.#hostChecks;
      this.#hostChecks = [];
      for (const check of checks) this.#rootsAfter(check.opener, candidates);
      for (const check of checks) {
        for (let position = this.#detachedRoots.length - 1; position >= 0; position--) {
          const root = this.#detachedRoots[position];
          if (root === undefined || !Number.isNaN(this.index.timestamp(root))) break;
          this.#hostVisits += 1;
          candidates.add(root);
        }
        const time = this.index.timestamp(check.opener);
        for (const key of check.keys) {
          for (const root of this.#summaryRoots.get(key) ?? []) {
            if (compareTimes(this.index.timestamp(root), time) < 0) continue;
            this.#hostVisits += 1;
            candidates.add(root);
          }
        }
      }
      const roots = [...candidates].filter(
        (root) => this.#bit(root, DETACHED) && this.#hostFor(root) !== this.#s.host.get(root),
      );
      this.#propagate(roots, forcedAnchors);
    }
  }

  // The roots whose latest eligible turn by time can be `opener`: those at or after it, up to the
  // first that a later turn it may join already sits before. A turn under a root is eligible for
  // every later root, so once one is passed every later root stops too.
  #rootsAfter(opener: number, candidates: Set<number>): void {
    const roots = this.#detachedRoots;
    let low = 0;
    let high = this.#order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = this.#order[middle];
      if (other === undefined) throw new RangeError(`No slot ${middle}.`);
      if (this.#rules.compareTurns(other, opener) <= 0) low = middle + 1;
      else high = middle;
    }
    let cursor = low;
    // The earliest-ranked tree among the turns passed; NONE once a true root's turn is passed.
    let least: number | undefined;
    const passed = (root: number) =>
      least !== undefined && (least === NONE || this.#rules.compareTurns(least, root) < 0);
    for (
      let position = this.#firstAfter(roots, this.index.timestamp(opener), true);
      position < roots.length;
      position++
    ) {
      const root = roots[position];
      if (root === undefined) break;
      const time = this.index.timestamp(root);
      for (
        let turn = this.#order[cursor];
        turn !== undefined && !passed(root);
        turn = this.#order[cursor]
      ) {
        if (compareTimes(this.index.timestamp(turn), time) > 0) break;
        this.#hostVisits += 1;
        const under = this.#s.rootOf.get(turn);
        if (
          under === NONE ||
          least === undefined ||
          (least !== NONE && this.#rules.compareTurns(under, least) < 0)
        ) {
          least = under;
        }
        cursor += 1;
      }
      if (passed(root)) break;
      this.#hostVisits += 1;
      candidates.add(root);
    }
  }

  // The first position whose time is after `time`, or at or after it when `inclusive`.
  #firstAfter(list: ReadonlyArray<number>, time: number, inclusive: boolean): number {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = list[middle];
      if (other === undefined) throw new RangeError(`No slot ${middle}.`);
      const order = compareTimes(this.index.timestamp(other), time);
      if (inclusive ? order < 0 : order <= 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  #refreshRepliesBelow(): void {
    const changed = this.#changedEntries;
    this.#changedEntries = [];
    for (const entry of changed) {
      this.#refreshReplyBelow(entry);
      for (let up = this.#s.up.get(entry); up !== NONE; up = this.#s.up.get(up)) {
        if (!this.#refreshReplyBelow(up)) break;
      }
    }
  }
  #refreshReplyBelow(entry: number): boolean {
    const turn = this.#s.turn.get(entry);
    let below = false;
    this.#eachChild(entry, (child) => {
      if (!this.#inForest(child) || this.#s.turn.get(child) !== turn) return;
      if (this.#rules.isRealReply(child) || this.#flag(child, REPLY_BELOW)) below = true;
    });
    if (!this.#setFlag(entry, REPLY_BELOW, below)) return false;
    if (turn !== NONE) {
      const state = this.#turnState(turn);
      const step = below ? -1 : 1;
      if (this.#rules.isInterrupt(entry)) state.interrupts += step;
      if (this.#rules.isEndingReply(entry)) state.endingReplies += step;
      this.#dirty.add(turn);
    }
    return true;
  }

  #restale(state: TurnState): void {
    const rules = this.#rules;
    if (state.staleLatest) {
      state.latest = Number.NaN;
      for (const entry of state.members) {
        const time = this.index.timestamp(entry);
        if (!Number.isNaN(time) && (Number.isNaN(state.latest) || time > state.latest))
          state.latest = time;
      }
      state.staleLatest = false;
    }
    if (state.staleDuration) {
      state.duration = NONE;
      for (const entry of state.members) {
        if (
          rules.kind(entry) === Kind.TurnDuration &&
          (state.duration === NONE || rules.laterLine(entry, state.duration))
        ) {
          state.duration = entry;
        }
      }
      state.staleDuration = false;
    }
    if (state.staleLastAssistant) {
      state.lastAssistant = NONE;
      for (const entry of state.members) {
        if (
          rules.kind(entry) === Kind.Assistant &&
          this.#bit(entry, ITEM) &&
          this.#laterAssistant(state.opener, entry, state.lastAssistant)
        ) {
          state.lastAssistant = entry;
        }
      }
      state.staleLastAssistant = false;
    }
  }

  #facts(state: TurnState, position: number) {
    const opener = state.opener;
    const up = this.#s.up.get(opener);
    return {
      opener,
      up,
      kind: openerOf(this.#s.opens.get(opener)),
      promptEntry: this.#s.promptEntry.get(opener),
      parentTurn: up === NONE ? NONE : this.#s.turn.get(up),
      previous: position === 0 ? NONE : (this.#order[position - 1] ?? NONE),
      isLast: position === this.#order.length - 1,
      latest: state.latest,
      interrupted: state.interrupts > 0,
      replied: state.endingReplies > 0,
      duration: state.duration,
      lastAssistant: state.lastAssistant,
      shares: [state.shareFirst, state.shareSecond] as const,
    };
  }

  #position(opener: number): number {
    let low = 0;
    let high = this.#order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = this.#order[middle];
      if (other === undefined) throw new RangeError(`No slot ${middle}.`);
      if (this.#rules.compareTurns(other, opener) < 0) low = middle + 1;
      else high = middle;
    }
    if (this.#order[low] !== opener) throw new RangeError(`Turn ${opener} is not in order.`);
    return low;
  }

  #settleTurns() {
    const changedTurnIds: Array<string> = [];
    const removedTurnIds: Array<string> = [];
    for (const opener of this.#dirty) {
      const state = this.#turns.get(opener);
      if (state === undefined) continue;
      if (!state.open) {
        if (state.members.size > 0)
          throw new Error(`A closed turn still holds ${state.members.size} lines.`);
        if (state.digest !== undefined) removedTurnIds.push(state.id);
        this.#turns.delete(opener);
        continue;
      }
      this.#restale(state);
      this.#digested += 1;
      const { digest } = claudeTranscriptTurnIdentity(
        this.index,
        this.#facts(state, this.#position(opener)),
      );
      if (digest !== state.digest) {
        state.digest = digest;
        changedTurnIds.push(this.index.uuid(opener));
      }
    }
    this.#dirty = new Set();
    return { changedTurnIds, removedTurnIds };
  }

  /** The turn this uuid opened, with its lines in item order. */
  turn(id: string): ClaudeTranscriptTurn | undefined {
    const opener = this.index.entryOf(id);
    if (opener === undefined || this.#turns.get(opener)?.open !== true) return undefined;
    return this.#materialise(opener, this.#position(opener));
  }

  #materialise(opener: number, position: number): ClaudeTranscriptTurn {
    const state = this.#turnState(opener);
    const depth = (entry: number) => this.#s.depth.get(entry);
    const lines = [...state.members]
      .filter((entry) => this.#bit(entry, ITEM))
      .toSorted((left, right) =>
        this.#rules.compareLines(opener, left, depth(left), right, depth(right)),
      );
    const { identity, digest } = claudeTranscriptTurnIdentity(
      this.index,
      this.#facts(state, position),
    );
    return { ...identity, lineUuids: lines.map((entry) => this.index.uuid(entry)), digest };
  }

  /** Turn ids in turn order. */
  turnIds(): ReadonlyArray<string> {
    return this.#order.map((opener) => this.index.uuid(opener));
  }

  /** The session's titles, derivation and fork source. */
  facts(): Omit<ClaudeTranscriptStructure, "turns"> {
    const forked =
      this.#forkTurns === 0
        ? undefined
        : this.#order
            .map((opener) => this.index.forkSessionId(opener))
            .find((id) => id !== undefined);
    return {
      aiTitle: this.index.aiTitle,
      customTitle: this.index.customTitle,
      derivedFrom: this.index.derivedFrom,
      forkedFromSessionId: forked,
    };
  }

  /** Every turn, materialised; work is linear in the transcript, so it is for checks, not syncs. */
  structure(): ClaudeTranscriptStructure {
    return {
      turns: this.#order.map((opener, position) => this.#materialise(opener, position)),
      ...this.facts(),
    };
  }
}

export interface ClaudeTranscriptSyncResult {
  /** The file was replaced, truncated or rewritten, so it was read again from the top. */
  readonly rewritten: boolean;
  /** The tracker recomputed every turn; see `ClaudeTranscriptTurnUpdate.rebuilt`. */
  readonly rebuilt: boolean;
  readonly linesRead: number;
  readonly bytesRead: number;
  readonly changedTurnIds: ReadonlyArray<string>;
  readonly removedTurnIds: ReadonlyArray<string>;
  readonly factsChanged: boolean;
  readonly malformedOffsets: ReadonlyArray<number>;
  /** Work done across the sync's updates: see `ClaudeTranscriptTurnUpdate`. */
  readonly decided: number;
  readonly digested: number;
  readonly hostVisits: number;
}

/**
 * Reads what was appended to the transcript into the tracker, updating its turns after each read chunk and yielding between chunks, so no step holds the event loop for more than one chunk's work. Reports the turns that are new or changed and those that no longer exist.
 */
export const syncClaudeTranscript = Effect.fn("syncClaudeTranscript")(function* (input: {
  readonly filePath: string;
  readonly tracker: ClaudeTranscriptTurnTracker;
}) {
  const { tracker } = input;
  const changed = new Set<string>();
  const removed = new Set<string>();
  const malformedOffsets: Array<number> = [];
  let factsChanged = false;
  let rebuilt = false;
  let decided = 0;
  let digested = 0;
  let hostVisits = 0;
  const collect = () => {
    const update = tracker.update();
    for (const id of update.changedTurnIds) changed.add(id);
    for (const id of update.removedTurnIds) removed.add(id);
    malformedOffsets.push(...update.malformedOffsets);
    factsChanged ||= update.factsChanged;
    rebuilt ||= update.rebuilt;
    decided += update.decided;
    digested += update.digested;
    hostVisits += update.hostVisits;
  };
  const read = yield* syncClaudeTranscriptIndex({
    filePath: input.filePath,
    index: tracker.index,
    afterChunk: Effect.suspend(() => {
      collect();
      return Effect.yieldNow;
    }),
  });
  collect();
  const result: ClaudeTranscriptSyncResult = {
    rewritten: read.rebuilt,
    rebuilt,
    linesRead: read.linesRead,
    bytesRead: read.bytesRead,
    changedTurnIds: [...changed].filter((id) => tracker.hasTurn(id)),
    removedTurnIds: [...removed].filter((id) => !tracker.hasTurn(id)),
    factsChanged,
    malformedOffsets,
    decided,
    digested,
    hostVisits,
  };
  return result;
});
