import * as Schema from "effect/Schema";

/**
 * The wire between T3 Code's server and the T3 bridge mod running inside a `claude` process on the same host. The mod polls the server over loopback; Claude stays the only writer of the session.
 */
export const CLAUDE_BRIDGE_SCHEMA_VERSION = 1;

/** File in each Claude home, mode 0600, naming the server's loopback URL and the bridge token. */
export const CLAUDE_BRIDGE_CONNECTION_FILE = "t3-code-bridge.json";

export const CLAUDE_BRIDGE_ROUTE_PREFIX = "/claude-bridge/v1";

/** The mod's name, which Claude shows on a prompt the mod submits that is not a person's. */
export const CLAUDE_BRIDGE_MOD_NAME = "t3-code-bridge";

export const ClaudeBridgeConnection = Schema.Struct({
  schemaVersion: Schema.Literal(CLAUDE_BRIDGE_SCHEMA_VERSION),
  url: Schema.String,
  token: Schema.String,
});
export type ClaudeBridgeConnection = typeof ClaudeBridgeConnection.Type;

/**
 * What the mod does next: submit a prompt, as the person's own words only when `asUser`. A person releases the session from the terminal with `/t3-bridge release`.
 */
export const ClaudeBridgeCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("submit"),
    commandId: Schema.String,
    text: Schema.String,
    asUser: Schema.Boolean,
  }),
]);
export type ClaudeBridgeCommand = typeof ClaudeBridgeCommand.Type;

/** The mod's poll, naming the session its `claude` runs. */
export const ClaudeBridgePoll = Schema.Struct({
  schemaVersion: Schema.Literal(CLAUDE_BRIDGE_SCHEMA_VERSION),
  sessionId: Schema.String,
});
export type ClaudeBridgePoll = typeof ClaudeBridgePoll.Type;

export const ClaudeBridgePollResult = Schema.Struct({
  commands: Schema.Array(ClaudeBridgeCommand),
});
export type ClaudeBridgePollResult = typeof ClaudeBridgePollResult.Type;

// A word joiner is invisible and is not `/`, so Claude reads the text and runs no command.
const COMMAND_ESCAPE = "⁠";

/**
 * Text a prompt that is not a person's carries: a leading `/` would run a slash command in the holder, so it is escaped. A person's own prompt goes as typed.
 */
export function claudeBridgePromptText(text: string, asUser: boolean): string {
  return !asUser && text.startsWith("/") ? `${COMMAND_ESCAPE}${text}` : text;
}
