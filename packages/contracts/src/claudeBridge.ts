import * as Schema from "effect/Schema";

/**
 * The wire between T3 Code's server and the T3 bridge mod running inside a `claude` process on the
 * same host. The mod polls the server over loopback; Claude stays the only writer of the session.
 */
export const CLAUDE_BRIDGE_SCHEMA_VERSION = 1;

/**
 * Directory in each Claude home, mode 0700, holding one connection file per running T3 Code server
 * (mode 0600), named by that server's id. A server removes its own file when it stops.
 */
export const CLAUDE_BRIDGE_CONNECTION_DIRECTORY = "t3-code-bridge";

export const CLAUDE_BRIDGE_ROUTE_PREFIX = "/claude-bridge/v1";

/**
 * Response header carrying the server's proof, which only a reader of the connection file knows.
 */
export const CLAUDE_BRIDGE_PROOF_HEADER = "x-t3-bridge-proof";

/** The mod's name, which Claude shows on a prompt the mod submits that is not a person's. */
export const CLAUDE_BRIDGE_MOD_NAME = "t3-code-bridge";

/**
 * One server's connection: the mod presents `token` to `url`, and accepts only a response that
 * carries `proof`, which the server never sends anywhere else, so a process that later binds the
 * port cannot pose as the server.
 */
export const ClaudeBridgeConnection = Schema.Struct({
  schemaVersion: Schema.Literal(CLAUDE_BRIDGE_SCHEMA_VERSION),
  url: Schema.String,
  token: Schema.String,
  proof: Schema.String,
  /** The server's process, so a later server removes the file of one that did not stop cleanly. */
  pid: Schema.Int,
});
export type ClaudeBridgeConnection = typeof ClaudeBridgeConnection.Type;

/**
 * A prompt for the mod to submit, as the person's own words only when `asUser`. It stays queued
 * until the mod acknowledges it, and the mod submits it only into the session it names.
 */
export const ClaudeBridgeCommand = Schema.Struct({
  type: Schema.Literal("submit"),
  commandId: Schema.String,
  sessionId: Schema.String,
  text: Schema.String,
  asUser: Schema.Boolean,
});
export type ClaudeBridgeCommand = typeof ClaudeBridgeCommand.Type;

/**
 * Why a prompt handed to a terminal never reached its `claude`: no mod took it in time, the
 * terminal released the session or started another conversation, or its `claude` refused it.
 * A code, so each client words it in its reader's language.
 */
export const ClaudeBridgeFailureReason = Schema.Literals([
  "expired",
  "released",
  "anotherConversation",
  "refused",
]);
export type ClaudeBridgeFailureReason = typeof ClaudeBridgeFailureReason.Type;

/** The mod's report on a command it was handed: submitted, or why not. */
export const ClaudeBridgeAck = Schema.Struct({
  commandId: Schema.String,
  submitted: Schema.Boolean,
  reason: Schema.optional(ClaudeBridgeFailureReason),
});
export type ClaudeBridgeAck = typeof ClaudeBridgeAck.Type;

/**
 * The mod's poll: the session its `claude` runs, the key the server gave its first poll for that
 * session, and its reports on commands it was handed.
 */
export const ClaudeBridgePoll = Schema.Struct({
  schemaVersion: Schema.Literal(CLAUDE_BRIDGE_SCHEMA_VERSION),
  sessionId: Schema.String,
  pollerKey: Schema.optional(Schema.String),
  acks: Schema.Array(ClaudeBridgeAck),
});
export type ClaudeBridgePoll = typeof ClaudeBridgePoll.Type;

export const ClaudeBridgePollResult = Schema.Struct({
  pollerKey: Schema.String,
  commands: Schema.Array(ClaudeBridgeCommand),
});
export type ClaudeBridgePollResult = typeof ClaudeBridgePollResult.Type;

/** Whether Claude Code would read `text` as a slash command, which a mod cannot submit. */
export function claudeBridgeIsCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

// A word joiner (U+2060) is invisible, is not whitespace, and is not `/`, so Claude reads text.
const COMMAND_ESCAPE = String.fromCharCode(0x2060);

/**
 * Text for a prompt that is not a person's: one that would read as a slash command is escaped so
 * it arrives as text. A person's own slash command is refused before it reaches the bridge.
 */
export function claudeBridgePromptText(text: string): string {
  return claudeBridgeIsCommandText(text) ? `${COMMAND_ESCAPE}${text}` : text;
}
