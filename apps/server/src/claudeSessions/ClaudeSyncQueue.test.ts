import { describe, expect, it } from "@effect/vitest";

import { ClaudeSyncQueue, type ClaudeSyncLane } from "./ClaudeSyncQueue.ts";

type Request = { readonly key: string; readonly lane: ClaudeSyncLane };
const ask = (key: string, lane: ClaudeSyncLane): Request => ({ key, lane });

/** Takes up to `count` requests, re-asking for each in its lane as a step that has more does. */
const run = (queue: ClaudeSyncQueue<Request>, count: number, more: (key: string) => boolean) => {
  const taken: Array<string> = [];
  for (let step = 0; step < count; step++) {
    const next = queue.take(true);
    if (next === undefined) break;
    taken.push(next.key);
    if (more(next.key)) queue.add(next.key, next);
    else queue.finish(next.key);
  }
  return taken;
};

describe("ClaudeSyncQueue", () => {
  it("gives an opened load a step after every few live steps, however long live work lasts", () => {
    const queue = new ClaudeSyncQueue<Request>(2, 3);
    queue.add("live", ask("live", "live"));
    queue.add("opened", ask("opened", "open"));
    // The live session always has more; without a share the opened one would never run.
    expect(run(queue, 8, () => true)).toEqual([
      "live",
      "live",
      "live",
      "opened",
      "live",
      "live",
      "live",
      "opened",
    ]);
  });

  it("lets two opened sessions take turns while the next waits, and lets it in when one finishes", () => {
    const queue = new ClaudeSyncQueue<Request>(2, 3);
    for (const key of ["a", "b", "c"]) queue.add(key, ask(key, "open"));
    let left = new Map([
      ["a", 2],
      ["b", 3],
      ["c", 1],
    ]);
    const more = (key: string) => {
      const steps = (left.get(key) ?? 0) - 1;
      left = new Map(left).set(key, steps);
      return steps > 0;
    };
    expect(run(queue, 10, more)).toEqual(["a", "b", "a", "b", "c", "b"]);
  });

  it("gives back an interrupted step's turn and queues it again", () => {
    const queue = new ClaudeSyncQueue<Request>(2, 3);
    for (const key of ["a", "b", "c"]) queue.add(key, ask(key, "open"));
    const a = queue.take(true);
    const b = queue.take(true);
    expect([a?.key, b?.key]).toEqual(["a", "b"]);
    // Both steps are interrupted, as a settings change does.
    if (a !== undefined) queue.interrupted(a.key, a);
    if (b !== undefined) queue.interrupted(b.key, b);
    expect(run(queue, 10, () => false).toSorted()).toEqual(["a", "b", "c"]);
  });

  it("takes the fill only when allowed, and never before live or opened work", () => {
    const queue = new ClaudeSyncQueue<Request>(2, 3);
    queue.add("filled", ask("filled", "fill"));
    expect(queue.take(false)).toBeUndefined();
    expect(queue.hasFill).toBe(true);
    queue.add("opened", ask("opened", "open"));
    expect(queue.take(true)?.key).toBe("opened");
    expect(queue.take(true)?.key).toBe("filled");
  });

  it("moves a request to a more urgent lane, and keeps it there when asked for less urgently", () => {
    const queue = new ClaudeSyncQueue<Request>(2, 3);
    expect(queue.add("s", ask("s", "fill"))).toBe(true);
    expect(queue.add("s", ask("s", "live"))).toBe(true);
    expect(queue.add("s", ask("s", "open"))).toBe(false);
    expect(queue.take(false)).toEqual(ask("s", "live"));
    expect(queue.take(true)).toBeUndefined();
  });
});
