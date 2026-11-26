import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { nextRunOrdinal } from "./Orchestrator.ts";

const now = DateTime.makeUnsafe("2026-11-26T12:00:00.000Z");
const second = Math.floor(DateTime.toEpochMillis(now) / 1000);
const runs = (ordinals: ReadonlyArray<number>) => ordinals.map((ordinal) => ({ ordinal }));
// A run the session sync read back from a transcript.
const nativeRun = (ordinal: number) => ({
  ordinal,
  nativeOrigin: {
    kind: "claude_transcript" as const,
    nativeSessionId: "session",
    promptUuid: `prompt-${ordinal}`,
  },
});
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

  it("takes at least the current second on a thread the session sync writes into", () => {
    const claude = [providerThread("claudeAgent")];
    // An entry whose history is not loaded yet: the run still sorts after every turn before it.
    expect(nextRunOrdinal({ runs: [], providerThreads: claude }, now)).toBe(second);
    // A thread holding a native run, written for a turn after the clock's second.
    const native = [nativeRun(second + 5)];
    expect(nextRunOrdinal({ runs: native, providerThreads: claude }, now)).toBe(second + 6);
    expect(
      nextRunOrdinal({ runs: [...runs([1]), nativeRun(2)], providerThreads: claude }, now),
    ).toBe(second);
  });

  it("takes the next ordinal on a Claude thread with runs of T3 Code's only, as a delegated child has", () => {
    expect(
      nextRunOrdinal({ runs: runs([1]), providerThreads: [providerThread("claudeAgent")] }, now),
    ).toBe(2);
  });
});
