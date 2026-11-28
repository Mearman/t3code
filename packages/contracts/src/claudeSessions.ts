import * as Schema from "effect/Schema";

/**
 * What a send does when another Claude Code process holds the session: `ask` sends nothing;
 * `adopt` hands the prompt to the holder's T3 bridge mod; `fork` continues in a forked thread;
 * `send` writes beside an idle holder, which can branch the session; `takeOver` stops an idle
 * holder with SIGTERM, waiting while it is busy, then sends.
 */
export const ClaudeHeldSessionSend = Schema.Literals(["ask", "adopt", "fork", "send", "takeOver"]);
export type ClaudeHeldSessionSend = typeof ClaudeHeldSessionSend.Type;

/** The choices an agent's or a CLI send may name: neither acts on the other process. */
export const ClaudeHeldSessionAgentSend = Schema.Literals(["ask", "fork"]);

/** Choices that act on the other process, so they need the sender to hold `terminal:operate`. */
export const CLAUDE_HELD_SESSION_TERMINAL_CHOICES: ReadonlySet<ClaudeHeldSessionSend> = new Set([
  "adopt",
  "send",
  "takeOver",
]);

/**
 * Whether the bridge submits a held session's prompt as the person's own words: only for `adopt`
 * with terminal access and words a person sent from a client, never a scheduled task's or an
 * agent's (`writtenByAgent`). On a resend the words are the refused message's.
 */
export function claudeBridgeSubmitsAsPerson(input: {
  readonly choice: ClaudeHeldSessionSend | undefined;
  readonly terminalAccess: boolean;
  readonly words: {
    readonly createdBy: "user" | "agent" | "system";
    readonly scheduledTaskId?: string | undefined;
    readonly writtenByAgent?: true | undefined;
  };
}): boolean {
  return (
    input.choice === "adopt" &&
    input.terminalAccess &&
    input.words.createdBy === "user" &&
    input.words.scheduledTaskId === undefined &&
    input.words.writtenByAgent !== true
  );
}

/**
 * The choice a send to a held session takes when neither it nor the settings name one: `adopt`
 * where the holder runs the T3 bridge mod and the sender may act on its terminal, else `ask`.
 */
export function defaultClaudeHeldSessionSend(bridgeAttached: boolean): ClaudeHeldSessionSend {
  return bridgeAttached ? "adopt" : "ask";
}

/**
 * What a send to a held session does: the choice it carries, else for a person's send the
 * configured one. An agent's or a scheduled task's send never takes the configured choice, which a
 * person set for their own sends. A choice that acts on the other process becomes `ask` unless the
 * sender held `terminal:operate`. Undefined leaves the default to the gate.
 */
export function resolveClaudeHeldSessionSend(input: {
  readonly chosen: ClaudeHeldSessionSend | undefined;
  readonly sentByPerson: boolean;
  readonly configured: ClaudeHeldSessionSend | null;
  readonly terminalAccess: boolean;
}): ClaudeHeldSessionSend | undefined {
  const choice =
    input.chosen ??
    (input.sentByPerson && input.configured !== null ? input.configured : undefined);
  return choice !== undefined &&
    CLAUDE_HELD_SESSION_TERMINAL_CHOICES.has(choice) &&
    !input.terminalAccess
    ? "ask"
    : choice;
}
