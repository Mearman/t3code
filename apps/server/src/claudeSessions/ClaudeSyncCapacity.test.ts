import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { LiveStreamProgress } from "../orchestration-v2/LiveStreamBudget.ts";
import { waitForLiveSubscribers } from "./ClaudeSyncCapacity.ts";

/** A subscriber holding `fullness` of its budget, which releases `perTick` items each time it is read. */
const subscriber = (fullness: number, perTick: number) => {
  let released = 0;
  let full = fullness;
  const progress: LiveStreamProgress = {
    fullness: () => full,
    released: () => released,
  };
  return {
    progress,
    tick: () => {
      released += perTick;
      if (perTick > 0) full = Math.max(0, full - 0.1);
    },
  };
};

describe("waitForLiveSubscribers", () => {
  it.effect("goes on past a subscriber that acknowledges nothing, and stays passed it", () =>
    Effect.gen(function* () {
      const stalled = subscriber(0.9, 0);
      const wait = waitForLiveSubscribers(() => [stalled.progress]);
      const first = yield* Effect.forkChild(wait);
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(first);
      // Already found stalled, it holds no later step back: under the test clock a sleep never ends.
      yield* wait;
    }),
  );

  it.effect("waits for a subscriber that is still reading until it falls below the bound", () =>
    Effect.gen(function* () {
      const reading = subscriber(0.5, 1);
      let done = false;
      const fiber = yield* Effect.forkChild(
        waitForLiveSubscribers(() => [reading.progress]).pipe(
          Effect.ensuring(Effect.sync(() => (done = true))),
        ),
      );
      // The wait takes its first reading before the subscriber acknowledges anything.
      yield* Effect.yieldNow;
      // It acknowledges between each check and drops 0.1 each time: 0.5, 0.4, 0.3, 0.2.
      for (let check = 0; check < 2; check++) {
        reading.tick();
        yield* TestClock.adjust("50 millis");
        expect(done).toBe(false);
      }
      reading.tick();
      yield* TestClock.adjust("50 millis");
      yield* Fiber.join(fiber);
      expect(done).toBe(true);
    }),
  );
});
