import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { nextRunOrdinal } from "./Orchestrator.ts";
import {
  MAX_NATIVE_RUN_ORDINAL,
  MAX_RUN_ORDINAL,
  TURN_ITEM_POSITIONS_PER_RUN,
} from "./TurnItemPositionStore.ts";

const now = DateTime.makeUnsafe("2026-11-26T12:00:00.000Z");
const second = Math.floor(DateTime.toEpochMillis(now) / 1000);
const runs = (ordinals: ReadonlyArray<number>) => ordinals.map((ordinal) => ({ ordinal }));

describe("nextRunOrdinal", () => {
  it("takes the next ordinal on a thread whose history T3 Code holds itself", () => {
    expect(nextRunOrdinal({ thread: {}, runs: runs([1, 2]) }, now)).toBe(3);
    expect(nextRunOrdinal({ thread: { historyOrigin: "v1_import" }, runs: [] }, now)).toBe(1);
  });

  it("takes at least the current second on a thread read back from a native transcript", () => {
    const thread = { historyOrigin: "native" as const };
    // No history loaded yet: the run still sorts after every turn that happened before it.
    expect(nextRunOrdinal({ thread, runs: [] }, now)).toBe(second);
    expect(nextRunOrdinal({ thread, runs: runs([1, 2]) }, now)).toBe(second);
    // A run written for a turn after the clock's second keeps a new one after it.
    expect(nextRunOrdinal({ thread, runs: runs([second + 5]) }, now)).toBe(second + 6);
  });

  it("takes the next ordinal on a Claude thread with runs of T3 Code's only, as a delegated child has", () => {
    // The sync never marks a delegated child native, so its queued run keeps the next ordinal.
    expect(nextRunOrdinal({ thread: {}, runs: runs([1]) }, now)).toBe(2);
  });

  it("leaves every item position safe for sends after a native run at the highest ordinal", () => {
    const thread = { historyOrigin: "native" as const };
    const ordinals = [MAX_NATIVE_RUN_ORDINAL];
    // Two sends in a row after the clamped native run, and a clock far ahead of it.
    for (let send = 0; send < 2; send++) {
      ordinals.push(
        nextRunOrdinal(
          { thread, runs: runs(ordinals) },
          DateTime.makeUnsafe("2400-01-01T00:00:00.000Z"),
        ),
      );
    }
    expect(ordinals.slice(1)).toEqual([MAX_NATIVE_RUN_ORDINAL + 1, MAX_NATIVE_RUN_ORDINAL + 2]);
    for (const ordinal of ordinals) {
      expect(ordinal).toBeLessThanOrEqual(MAX_RUN_ORDINAL);
      expect(Number.isSafeInteger((ordinal + 1) * TURN_ITEM_POSITIONS_PER_RUN - 1)).toBe(true);
    }
  });
});
