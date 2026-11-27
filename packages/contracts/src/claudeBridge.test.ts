import { describe, expect, it } from "vite-plus/test";

import { claudeBridgeIsCommandText, claudeBridgePromptText } from "./claudeBridge.ts";

describe("claudeBridgePromptText", () => {
  it("escapes text Claude Code would read as a slash command, leading spaces included", () => {
    for (const text of ["/clear the cache", "  /clear", "\n\t/compact"]) {
      const escaped = claudeBridgePromptText(text);
      // Claude Code refuses a submitted prompt whose trimmed start is a slash.
      expect(claudeBridgeIsCommandText(escaped)).toBe(false);
      expect(escaped.endsWith(text)).toBe(true);
    }
  });

  it("sends any other text as written", () => {
    expect(claudeBridgePromptText("run /clear later")).toBe("run /clear later");
  });
});
