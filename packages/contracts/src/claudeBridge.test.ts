import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import {
  ClaudeBridgeAck,
  claudeBridgeIsCommandText,
  claudeBridgePromptText,
} from "./claudeBridge.ts";

const decodeAck = Schema.decodeUnknownSync(ClaudeBridgeAck);

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

describe("ClaudeBridgeAck", () => {
  it("reads a reason it does not know as a plain refusal, so a newer mod's poll still decodes", () => {
    expect(decodeAck({ commandId: "c1", submitted: false, reason: "released" })).toEqual({
      commandId: "c1",
      submitted: false,
      reason: "released",
    });
    for (const reason of ["aCodeFromALaterBuild", "the terminal released the session", 7]) {
      expect(decodeAck({ commandId: "c1", submitted: false, reason })).toEqual({
        commandId: "c1",
        submitted: false,
      });
    }
  });
});
