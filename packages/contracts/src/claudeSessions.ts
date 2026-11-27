import * as Schema from "effect/Schema";

/**
 * What a send does when another Claude Code process holds the session: `ask` sends nothing and
 * offers the choices; `fork` continues in a new thread forked from what T3 Code recorded.
 */
export const ClaudeHeldSessionSend = Schema.Literals(["ask", "fork"]);
export type ClaudeHeldSessionSend = typeof ClaudeHeldSessionSend.Type;

/** The choices an agent's or a CLI send may name: neither acts on the other process. */
export const ClaudeHeldSessionAgentSend = Schema.Literals(["ask", "fork"]);

/** The choice a send to a held session takes when neither it nor the settings name one. */
export const DEFAULT_CLAUDE_HELD_SESSION_SEND: ClaudeHeldSessionSend = "ask";

/**
 * What a send to a held session does: the choice it carries, else for a person's send the
 * configured one. An agent's or a scheduled task's send never takes the configured choice, which a
 * person set for their own sends. Undefined leaves `DEFAULT_CLAUDE_HELD_SESSION_SEND` to the gate.
 */
export function resolveClaudeHeldSessionSend(input: {
  readonly chosen: ClaudeHeldSessionSend | undefined;
  readonly sentByPerson: boolean;
  readonly configured: ClaudeHeldSessionSend | null;
}): ClaudeHeldSessionSend | undefined {
  if (input.chosen !== undefined) return input.chosen;
  return input.sentByPerson && input.configured !== null ? input.configured : undefined;
}
