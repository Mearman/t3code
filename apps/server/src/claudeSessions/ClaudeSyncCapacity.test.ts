import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { LiveStreamProgress } from "../orchestration-v2/LiveStreamBudget.ts";
import { waitForLiveSubscribers } from "./ClaudeSyncCapacity.ts";

/** A subscriber holding `fullness` of its budget; each `ack` releases one item and frees 0.1. */
const subscriber = (fullness: number) => {
  let released = 0;
  let full = fullness;
  const progress: LiveStreamProgress = { fullness: () => full, released: () => released };
  return {
    progress,
    ack: () => {
      released += 1;
      full = Math.max(0, full - 0.1);
    },
  };
};

describe("waitForLiveSubscribers", () => {
  it.effect("waits for a slow subscriber that acknowledges every few seconds", () =>
    Effect.gen(function* () {
      const slow = subscriber(0.5);
      let done = false;
      const fiber = yield* Effect.forkChild(
        waitForLiveSubscribers(() => [slow.progress]).pipe(
          Effect.ensuring(Effect.sync(() => (done = true))),
        ),
      );
      // One acknowledgement every 3 seconds, far slower than the 50 ms the wait checks at: 0.4, 0.3, then 0.2.
      for (let ack = 0; ack < 2; ack++) {
        yield* TestClock.adjust("3 seconds");
        expect(done).toBe(false);
        slow.ack();
      }
      yield* TestClock.adjust("3 seconds");
      expect(done).toBe(false);
      slow.ack();
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(fiber);
      expect(done).toBe(true);
    }),
  );

  it.effect(
    "passes over a subscriber that acknowledges nothing for the stall window, then keeps passing it",
    () =>
      Effect.gen(function* () {
        const stuck = subscriber(0.9);
        const wait = waitForLiveSubscribers(() => [stuck.progress]);
        let done = false;
        const first = yield* Effect.forkChild(
          wait.pipe(Effect.ensuring(Effect.sync(() => (done = true)))),
        );
        yield* TestClock.adjust("9 seconds");
        expect(done).toBe(false);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(first);
        // Judged stalled, it holds no later step back: under the test clock a sleep would never end.
        yield* wait;
        // Once it acknowledges again it is waited for again.
        stuck.ack();
        let again = false;
        yield* Effect.forkChild(wait.pipe(Effect.ensuring(Effect.sync(() => (again = true)))));
        yield* TestClock.adjust("1 second");
        expect(again).toBe(false);
      }),
  );
});
