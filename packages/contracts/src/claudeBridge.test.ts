import { describe, expect, it } from "vite-plus/test";

import { claudeBridgePromptText } from "./claudeBridge.ts";

describe("claudeBridgePromptText", () => {
  it("escapes a leading slash in text that is not a person's, so it runs no command", () => {
    const escaped = claudeBridgePromptText("/clear the cache", false);
    expect(escaped.startsWith("/")).toBe(false);
    expect(escaped.endsWith("/clear the cache")).toBe(true);
  });

  it("sends a person's own words, and any text not starting with a slash, as written", () => {
    expect(claudeBridgePromptText("/compact", true)).toBe("/compact");
    expect(claudeBridgePromptText("run /clear later", false)).toBe("run /clear later");
  });
});
