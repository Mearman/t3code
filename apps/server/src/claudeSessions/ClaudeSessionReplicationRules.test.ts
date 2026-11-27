import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { claudeReplicationRuleMatches } from "./ClaudeSessionReplication.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-27T12:00:00.000Z"));
const DAY = 24 * 60 * 60 * 1000;
const rules = { pinned: false, activeWithinDays: 0, everything: false, reserveGiB: 20 };
const session = (daysAgo: number, pinned: boolean) => ({
  pinned,
  updatedAt: DateTime.makeUnsafe(NOW - daysAgo * DAY),
});

describe("claudeReplicationRuleMatches", () => {
  it("copies nothing when every rule is off", () => {
    expect(claudeReplicationRuleMatches(rules, session(0, true), NOW)).toBe(false);
  });

  it("copies pinned sessions under the pinned rule, whatever their age", () => {
    const pinnedOnly = { ...rules, pinned: true };
    expect(claudeReplicationRuleMatches(pinnedOnly, session(400, true), NOW)).toBe(true);
    expect(claudeReplicationRuleMatches(pinnedOnly, session(0, false), NOW)).toBe(false);
  });

  it("copies sessions changed within the set days, and none older", () => {
    const recent = { ...rules, activeWithinDays: 7 };
    expect(claudeReplicationRuleMatches(recent, session(7, false), NOW)).toBe(true);
    expect(claudeReplicationRuleMatches(recent, session(7.01, false), NOW)).toBe(false);
  });

  it("copies every session under the everything rule", () => {
    expect(
      claudeReplicationRuleMatches({ ...rules, everything: true }, session(1000, false), NOW),
    ).toBe(true);
  });
});
