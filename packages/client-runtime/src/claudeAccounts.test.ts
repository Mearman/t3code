import { describe, expect, it } from "vite-plus/test";

import { claudeShareSource } from "./claudeAccounts.ts";

describe("claudeShareSource", () => {
  const personal = { instanceId: "claudeAgent" };
  const work = { instanceId: "claudeAgent_work" };

  it("defaults to the first account, even one that loads after the form opened", () => {
    expect(claudeShareSource([], undefined)).toBeUndefined();
    expect(claudeShareSource([personal, work], undefined)).toBe(personal);
  });

  it("keeps a choice to share with another account or to keep history separate", () => {
    expect(claudeShareSource([personal, work], "claudeAgent_work")).toBe(work);
    expect(claudeShareSource([personal, work], "")).toBeUndefined();
  });
});
