import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { nextRunOrdinal } from "./Orchestrator.ts";

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
});
