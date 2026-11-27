import { describe, expect, it } from "vite-plus/test";

import { isClaudeHistoryNoticeId } from "./claudeSyncNotice.ts";

describe("isClaudeHistoryNoticeId", () => {
  it("matches the history notice of a synced session and of a forked one", () => {
    expect(isClaudeHistoryNoticeId("x:5b1e0c1a-0000-4000-8000-000000000001:history")).toBe(true);
    expect(isClaudeHistoryNoticeId("x:thread:fork:session:history")).toBe(true);
  });

  it("leaves the other notices and lines of a synced session alone", () => {
    expect(isClaudeHistoryNoticeId("x:session:disk")).toBe(false);
    expect(isClaudeHistoryNoticeId("x:session:forked-from")).toBe(false);
    expect(isClaudeHistoryNoticeId("x:session:5b1e0c1a-0000-4000-8000-000000000001")).toBe(false);
    expect(isClaudeHistoryNoticeId("history")).toBe(false);
    expect(isClaudeHistoryNoticeId("item:history")).toBe(false);
  });
});
