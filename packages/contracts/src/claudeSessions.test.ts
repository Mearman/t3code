import { describe, expect, it } from "vite-plus/test";

import { resolveClaudeHeldSessionSend } from "./claudeSessions.ts";

describe("resolveClaudeHeldSessionSend", () => {
  it("takes the send's own choice over the configured one, whoever sent it", () => {
    for (const sentByPerson of [true, false]) {
      expect(
        resolveClaudeHeldSessionSend({ chosen: "ask", sentByPerson, configured: "fork" }),
      ).toBe("ask");
    }
  });

  it("gives the configured choice to a person's send only", () => {
    expect(
      resolveClaudeHeldSessionSend({ chosen: undefined, sentByPerson: true, configured: "fork" }),
    ).toBe("fork");
    expect(
      resolveClaudeHeldSessionSend({ chosen: undefined, sentByPerson: false, configured: "fork" }),
    ).toBe(undefined);
    expect(
      resolveClaudeHeldSessionSend({ chosen: undefined, sentByPerson: true, configured: null }),
    ).toBe(undefined);
  });
});
