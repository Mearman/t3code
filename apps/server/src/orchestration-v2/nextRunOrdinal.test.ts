import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { nextRunOrdinal } from "./Orchestrator.ts";

const now = DateTime.makeUnsafe("2026-11-26T12:00:00.000Z");
const second = Math.floor(DateTime.toEpochMillis(now) / 1000);
const runs = (ordinals: ReadonlyArray<number>) => ordinals.map((ordinal) => ({ ordinal }));
const providerThread = (driver: string) => ({
  nativeThreadRef: {
    driver: ProviderDriverKind.make(driver),
    nativeId: "session",
    strength: "strong" as const,
  },
});

describe("nextRunOrdinal", () => {
  it("takes the next ordinal on a thread that shows no Claude session", () => {
    expect(
      nextRunOrdinal({ runs: runs([1, 2]), providerThreads: [providerThread("codex")] }, now),
    ).toBe(3);
  });

  it("takes at least the current second on a thread that shows a Claude session", () => {
    const claude = [providerThread("claudeAgent")];
    // No history loaded yet: the run still sorts after every turn that happened before it.
    expect(nextRunOrdinal({ runs: [], providerThreads: claude }, now)).toBe(second);
    // A native run written for a later turn keeps it after that run.
    expect(nextRunOrdinal({ runs: runs([second + 5]), providerThreads: claude }, now)).toBe(
      second + 6,
    );
  });
});
