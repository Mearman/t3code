import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { resolveClaudeHeldSessionSend } from "./claudeSessions.ts";
import { OrchestrationV2Run } from "./orchestrationV2.ts";
import { ServerSettings } from "./settings.ts";

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

describe("a held-session choice from a newer server", () => {
  const future = "someLaterChoice";

  it("reads as the default in settings, so the rest of the settings still decode", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      claudeSessionSync: { heldSessionSend: future },
    });
    expect(settings.claudeSessionSync.heldSessionSend).toBeNull();
  });

  it("drops from a run, so the run still decodes", () => {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({ heldSessionSend: OrchestrationV2Run.fields.heldSessionSend }),
    );
    expect(decode({ heldSessionSend: future })).toEqual({});
    expect(decode({ heldSessionSend: "fork" })).toEqual({ heldSessionSend: "fork" });
  });
});
