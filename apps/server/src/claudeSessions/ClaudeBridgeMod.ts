import {
  CLAUDE_BRIDGE_CONNECTION_DIRECTORY,
  CLAUDE_BRIDGE_MOD_NAME,
  CLAUDE_BRIDGE_PROOF_HEADER,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
} from "@t3tools/contracts";

/** The local marketplace T3 Code installs the bridge mod from, and the plugin id it installs. */
export const CLAUDE_BRIDGE_MARKETPLACE = "t3-code";
export const CLAUDE_BRIDGE_PLUGIN_ID = `${CLAUDE_BRIDGE_MOD_NAME}@${CLAUDE_BRIDGE_MARKETPLACE}`;

// Claude Code 2.1.287 released mods with `$.prompt.submit({ asUser })`; older builds lack the API.
export const CLAUDE_BRIDGE_MIN_CLAUDE_VERSION = "2.1.287";

/**
 * The mod's hooks module, inert outside an interactive session (so in T3 Code's own SDK sessions
 * and `-p` runs). A timer polls each server in the Claude home's connection directory, checks the
 * proof, submits a prompt only into the session it names and acknowledges it. Claude stays the
 * only writer of the session.
 */
const REGISTER_SOURCE = `import type { EngineInterface, Register } from "claude-code";

const DIRECTORY = ${JSON.stringify(CLAUDE_BRIDGE_CONNECTION_DIRECTORY)};
const SCHEMA_VERSION = ${CLAUDE_BRIDGE_SCHEMA_VERSION};
const PROOF_HEADER = ${JSON.stringify(CLAUDE_BRIDGE_PROOF_HEADER)};
const POLL_MS = 1_000;
// A server that failed is asked again after this long, so a stopped one costs little.
const RETRY_MS = 30_000;
// Commands already submitted, remembered so one handed out twice is submitted once.
const REMEMBERED = 256;

type Connection = { url: string; token: string; proof: string };
type Ack = {
  commandId: string;
  submitted: boolean;
  reason?: "released" | "anotherConversation" | "refused";
};
type Command = { commandId: string; sessionId: string; text: string; asUser: boolean };
type Server = { pollerKey?: string; acks: Ack[]; retryAt: number };

// A reload runs the module again, so these start over with the new code.
let sessionId: string | undefined;
let released = false;
let polling = false;
let started = false;
let problem: string | undefined;
const servers = new Map<string, Server>();
const submitted: string[] = [];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConnection(value: unknown): value is Connection & { schemaVersion: number } {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return (
    fields.schemaVersion === SCHEMA_VERSION &&
    typeof fields.url === "string" &&
    typeof fields.token === "string" &&
    typeof fields.proof === "string"
  );
}

async function connections($: EngineInterface): Promise<Map<string, Connection>> {
  const configured = await $.env.get("CLAUDE_CONFIG_DIR");
  const home = configured ?? (await $.env.get("HOME")) + "/.claude";
  const directory = home + "/" + DIRECTORY;
  const found = new Map<string, Connection>();
  if (!(await $.fs.exists(directory))) return found;
  for (const entry of await $.fs.list(directory)) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(directory + "/" + entry.name));
      if (isConnection(parsed)) found.set(entry.name, parsed);
    } catch (error) {
      $.ui.log("T3 Code bridge: unreadable " + entry.name + ": " + describe(error), { to: "debug" });
    }
  }
  return found;
}

async function take($: EngineInterface, command: Command): Promise<Ack> {
  const { commandId } = command;
  if (submitted.includes(commandId)) return { commandId, submitted: true };
  if (released) return { commandId, submitted: false, reason: "released" };
  if (command.sessionId !== sessionId) {
    return { commandId, submitted: false, reason: "anotherConversation" };
  }
  try {
    const result = await $.prompt.submit(
      command.asUser ? { text: command.text, asUser: true } : { text: command.text },
    );
    if (result.drop !== undefined) {
      $.ui.log("T3 Code bridge: prompt dropped: " + result.drop, { to: "debug" });
      return { commandId, submitted: false, reason: "refused" };
    }
  } catch (error) {
    $.ui.log("T3 Code bridge: prompt refused: " + describe(error), { to: "debug" });
    return { commandId, submitted: false, reason: "refused" };
  }
  submitted.push(commandId);
  if (submitted.length > REMEMBERED) submitted.shift();
  return { commandId, submitted: true };
}

async function pollServer($: EngineInterface, name: string, connection: Connection, now: number) {
  const server = servers.get(name) ?? { acks: [], retryAt: 0 };
  servers.set(name, server);
  if (now < server.retryAt) return;
  const acks = server.acks;
  server.acks = [];
  try {
    const response = await $.http.fetch(connection.url + "/poll", {
      method: "POST",
      headers: { authorization: "Bearer " + connection.token, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        sessionId,
        ...(server.pollerKey === undefined ? {} : { pollerKey: server.pollerKey }),
        acks,
      }),
    });
    // Only the server that wrote the file knows its proof; anything else at that address is
    // ignored.
    if (response.headers[PROOF_HEADER] !== connection.proof) {
      throw new Error("the answer did not come from T3 Code");
    }
    if (!response.ok) throw new Error("T3 Code answered " + response.status);
    const answer = JSON.parse(response.text) as { pollerKey: string; commands: Command[] };
    server.pollerKey = answer.pollerKey;
    for (const command of answer.commands) server.acks.push(await take($, command));
    problem = undefined;
  } catch (error) {
    server.acks = [...acks, ...server.acks];
    server.retryAt = now + RETRY_MS;
    problem = describe(error);
    $.ui.log("T3 Code bridge: " + problem, { to: "debug" });
  }
}

async function tick($: EngineInterface): Promise<void> {
  // A released session keeps polling only to refuse what is handed to it, so T3 Code says so.
  if (polling || sessionId === undefined) return;
  polling = true;
  try {
    const now = await $.clock.now();
    const found = await connections($);
    for (const name of [...servers.keys()]) if (!found.has(name)) servers.delete(name);
    for (const [name, connection] of found) await pollServer($, name, connection, now);
    $.ui.status(
      found.size === 0
        ? "T3 Code bridge: no T3 Code running"
        : problem === undefined
          ? "T3 Code bridge"
          : "T3 Code bridge: " + problem,
    );
  } finally {
    polling = false;
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (!e.isInteractive) return result;
    // A new conversation (a clear, a resume) gets new keys; nothing queued for the old one lands.
    sessionId = await $.session.id();
    servers.clear();
    if (!started) {
      started = true;
      await $.command.register({
        name: "t3-bridge",
        description: "release: stop T3 Code sending to this session; resume: let it again",
      });
      $.clock.every(POLL_MS, () => void tick($));
    }
    return result;
  });

  // Answers its own command whole, so a bare or unknown argument gets the usage, not another hook.
  on("command.run", { command: "t3-bridge" }, ($, e) => {
    const argument = e.args.trim();
    if (argument === "release") {
      released = true;
      $.ui.status("T3 Code bridge: released");
      return { text: "T3 Code no longer sends to this session." };
    }
    if (argument === "resume") {
      released = false;
      return { text: "T3 Code can send to this session again." };
    }
    return { text: "Usage: /t3-bridge release, or /t3-bridge resume." };
  });
};
`;

/** The files of the bridge mod's local marketplace, by path relative to its root. */
export function claudeBridgeMarketplaceFiles(version: string): ReadonlyMap<string, string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return new Map([
    [
      ".claude-plugin/marketplace.json",
      json({
        name: CLAUDE_BRIDGE_MARKETPLACE,
        description: "The T3 bridge mod, installed by T3 Code.",
        owner: { name: "T3 Code" },
        plugins: [{ name: CLAUDE_BRIDGE_MOD_NAME, source: `./${CLAUDE_BRIDGE_MOD_NAME}` }],
      }),
    ],
    [
      `${CLAUDE_BRIDGE_MOD_NAME}/.claude-plugin/plugin.json`,
      json({
        name: CLAUDE_BRIDGE_MOD_NAME,
        version,
        description: "Lets T3 Code send prompts to this session while this terminal holds it.",
        author: { name: "T3 Code" },
        license: "MIT",
      }),
    ],
    [`${CLAUDE_BRIDGE_MOD_NAME}/hooks/hooks.json`, json({ modules: ["./register.ts"] })],
    [`${CLAUDE_BRIDGE_MOD_NAME}/hooks/register.ts`, REGISTER_SOURCE],
  ]);
}
