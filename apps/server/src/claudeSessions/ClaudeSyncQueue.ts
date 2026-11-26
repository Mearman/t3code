/**
 * `live` is a session a terminal is running; `open` is one a person opened, one T3 Code drives, a read after a T3 Code run, or a load to resume; `fill` is background work. Only the fill waits on host load.
 */
export type ClaudeSyncLane = "live" | "open" | "fill";

// Lower is more urgent; a session asked for in two lanes is queued in the more urgent one.
const LANE_RANK: Readonly<Record<ClaudeSyncLane, number>> = { live: 0, open: 1, fill: 2 };

/** A first-in, first-out queue with constant-time take, so a long fill backlog costs nothing per step. */
class Fifo<A> {
  private items: Array<A | undefined> = [];
  private head = 0;
  get size(): number {
    return this.items.length - this.head;
  }
  push(item: A) {
    this.items.push(item);
  }
  shift(): A | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}

/**
 * The sync's requests, one per session key, each in the most urgent lane asked for. Live steps go first, but every `liveStepsPerOpen` live steps in a row give way to one opened step, so opened and resumed loads always progress and a live session waits at most one bounded step. At most `loadsAtOnce` opened sessions take turns; the rest wait in order, so each finishes early. A lane holds keys that moved to a more urgent lane; those are skipped when taken.
 */
export class ClaudeSyncQueue<Request extends { readonly lane: ClaudeSyncLane }> {
  readonly #queued = new Map<string, Request>();
  readonly #lanes = {
    live: new Fifo<string>(),
    open: new Fifo<string>(),
    waiting: new Fifo<string>(),
    fill: new Fifo<string>(),
  };
  readonly #loading = new Set<string>();
  #liveInARow = 0;
  readonly loadsAtOnce: number;
  readonly liveStepsPerOpen: number;

  constructor(loadsAtOnce: number, liveStepsPerOpen: number) {
    this.loadsAtOnce = loadsAtOnce;
    this.liveStepsPerOpen = liveStepsPerOpen;
  }

  get(key: string): Request | undefined {
    return this.#queued.get(key);
  }

  /** Whether the key holds one of the opened sessions' load turns. */
  isLoading(key: string): boolean {
    return this.#loading.has(key);
  }

  /** Queues the request; returns false when one as urgent is already queued for the key. */
  add(key: string, request: Request): boolean {
    const known = this.#queued.get(key);
    if (known !== undefined && LANE_RANK[known.lane] <= LANE_RANK[request.lane]) return false;
    this.#queued.set(key, request);
    if (request.lane !== "open") {
      this.#lanes[request.lane].push(key);
    } else if (this.#loading.has(key) || this.#loading.size < this.loadsAtOnce) {
      this.#loading.add(key);
      this.#lanes.open.push(key);
    } else {
      this.#lanes.waiting.push(key);
    }
    return true;
  }

  #takeFrom(lane: ClaudeSyncLane): Request | undefined {
    const fifo = this.#lanes[lane];
    for (let key = fifo.shift(); key !== undefined; key = fifo.shift()) {
      const next = this.#queued.get(key);
      if (next !== undefined && next.lane === lane) {
        this.#queued.delete(key);
        return next;
      }
    }
    return undefined;
  }

  /** The next request to step, or undefined; a fill request only when `fill` allows one. */
  take(fill: boolean): Request | undefined {
    if (this.#liveInARow >= this.liveStepsPerOpen) {
      const opened = this.#takeFrom("open");
      this.#liveInARow = 0;
      if (opened !== undefined) return opened;
    }
    const live = this.#takeFrom("live");
    if (live !== undefined) {
      this.#liveInARow += 1;
      return live;
    }
    this.#liveInARow = 0;
    return this.#takeFrom("open") ?? (fill ? this.#takeFrom("fill") : undefined);
  }

  /** Whether a fill request waits, so the worker looks again once the host may have quietened. */
  get hasFill(): boolean {
    return this.#lanes.fill.size > 0;
  }

  /** Ends the key's load turn, after a step that left nothing more or failed, and lets the next waiting session in. */
  finish(key: string): void {
    this.#loading.delete(key);
    while (this.#loading.size < this.loadsAtOnce) {
      const next = this.#lanes.waiting.shift();
      if (next === undefined) return;
      if (this.#queued.get(next)?.lane !== "open") continue;
      this.#loading.add(next);
      this.#lanes.open.push(next);
    }
  }

  /** Gives back a request whose step was interrupted, as a settings change does: its turn ends and it is queued again. */
  interrupted(key: string, request: Request): void {
    this.finish(key);
    this.add(key, request);
  }
}
