import * as Schema from "effect/Schema";

/**
 * What a send does when another Claude Code process holds the session: `ask` sends nothing and
 * offers the choices; `adopt` hands the prompt to the holder through the T3 bridge mod, so Claude
 * stays the only writer; `fork` continues in a new thread forked from what T3 Code recorded;
 * `send` writes beside an idle holder, which can branch the session; `takeOver` stops the holder
 * with SIGTERM once it is idle, waiting while it is busy, then sends.
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
