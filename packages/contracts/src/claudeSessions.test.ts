import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { claudeBridgeSubmitsAsPerson, resolveClaudeHeldSessionSend } from "./claudeSessions.ts";
import { ScheduledTaskId } from "./baseSchemas.ts";
import { OrchestrationV2Run } from "./orchestrationV2.ts";
import { ServerSettings } from "./settings.ts";

describe("resolveClaudeHeldSessionSend", () => {
  it("takes the send's own choice over the configured one, whoever sent it", () => {
    for (const sentByPerson of [true, false]) {
      expect(
        resolveClaudeHeldSessionSend({
          chosen: "ask",
          sentByPerson,
          configured: "fork",
          terminalAccess: false,
        }),
      ).toBe("ask");
    }
  });

  it("gives the configured choice to a person's send only", () => {
    expect(
      resolveClaudeHeldSessionSend({
        chosen: undefined,
        sentByPerson: true,
        configured: "fork",
        terminalAccess: false,
      }),
    ).toBe("fork");
    expect(
      resolveClaudeHeldSessionSend({
        chosen: undefined,
        sentByPerson: false,
        configured: "fork",
        terminalAccess: false,
      }),
    ).toBe(undefined);
    expect(
      resolveClaudeHeldSessionSend({
        chosen: undefined,
        sentByPerson: true,
        configured: null,
        terminalAccess: false,
      }),
    ).toBe(undefined);
  });
});

describe("a held-session choice that acts on the other process", () => {
  it("stands only for a sender holding terminal:operate, whether chosen or configured", () => {
    for (const terminalAccess of [true, false]) {
      const expected = terminalAccess ? "takeOver" : "ask";
      expect(
        resolveClaudeHeldSessionSend({
          chosen: "takeOver",
          sentByPerson: true,
          configured: null,
          terminalAccess,
        }),
      ).toBe(expected);
      expect(
        resolveClaudeHeldSessionSend({
          chosen: undefined,
          sentByPerson: true,
          configured: "takeOver",
          terminalAccess,
        }),
      ).toBe(expected);
    }
  });
});

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeRunChoice = Schema.decodeUnknownSync(
  Schema.Struct({ heldSessionSend: OrchestrationV2Run.fields.heldSessionSend }),
);

describe("a held-session choice from a newer server", () => {
  const future = "someLaterChoice";

  it("reads as the default in settings, so the rest of the settings still decode", () => {
    const stored: unknown = { claudeSessionSync: { heldSessionSend: future } };
    const settings = decodeSettings(stored);
    expect(settings.claudeSessionSync.heldSessionSend).toBeNull();
  });

  it("drops from a run, so the run still decodes", () => {
    const unknownChoice: unknown = { heldSessionSend: future };
    const knownChoice: unknown = { heldSessionSend: "fork" };
    expect(decodeRunChoice(unknownChoice)).toEqual({});
    expect(decodeRunChoice(knownChoice)).toEqual({ heldSessionSend: "fork" });
  });
});

describe("claudeBridgeSubmitsAsPerson", () => {
  const person = { createdBy: "user" } as const;
  it("submits as the person only words a person sent from a client, whoever pressed resend", () => {
    expect(
      claudeBridgeSubmitsAsPerson({ choice: "adopt", terminalAccess: true, words: person }),
    ).toBe(true);
    for (const words of [
      { createdBy: "agent" },
      { createdBy: "system" },
      // A scheduled task's words go under the mod's name even when a person made the task.
      { createdBy: "user", scheduledTaskId: ScheduledTaskId.make("task-1") },
      // An agent's edit of a person's queued message, or an agent's answer to a question.
      { createdBy: "user", writtenByAgent: true },
    ] as const) {
      expect(claudeBridgeSubmitsAsPerson({ choice: "adopt", terminalAccess: true, words })).toBe(
        false,
      );
    }
    expect(
      claudeBridgeSubmitsAsPerson({ choice: "adopt", terminalAccess: false, words: person }),
    ).toBe(false);
    expect(
      claudeBridgeSubmitsAsPerson({ choice: undefined, terminalAccess: true, words: person }),
    ).toBe(false);
  });
});
