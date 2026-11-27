import {
  CLAUDE_BRIDGE_CONNECTION_FILE,
  CLAUDE_BRIDGE_MOD_NAME,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
} from "@t3tools/contracts";

/** The local marketplace T3 Code installs the bridge mod from, and the plugin id it installs. */
export const CLAUDE_BRIDGE_MARKETPLACE = "t3-code";
export const CLAUDE_BRIDGE_PLUGIN_ID = `${CLAUDE_BRIDGE_MOD_NAME}@${CLAUDE_BRIDGE_MARKETPLACE}`;

// Claude Code 2.1.287 released mods with `$.prompt.submit({ asUser })`; older builds lack the API.
export const CLAUDE_BRIDGE_MIN_CLAUDE_VERSION = "2.1.287";

/**
 * The mod's hooks module. It runs only in an interactive session (so never in T3 Code's own Agent SDK sessions or a `-p` run), finds the server through the connection file in its Claude home, and polls it over loopback for prompts to submit. Claude remains the only writer.
 */
const REGISTER_SOURCE = `import type { EngineInterface, Register } from "claude-code";

const CONNECTION_FILE = ${JSON.stringify(CLAUDE_BRIDGE_CONNECTION_FILE)};
const SCHEMA_VERSION = ${CLAUDE_BRIDGE_SCHEMA_VERSION};
// After a failed poll the mod waits this long, so a stopped server costs one request a minute.
const RETRY_MS = 60_000;

export const register: Register = (on) => {
  let busy = false;
  let released = false;
  let polling = false;

  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) busy = true;
    return next(e);
  });
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) busy = false;
    return next(e);
  });

  // One variable by name, never the whole environment, which holds the session's credentials.
  const env = async ($: EngineInterface, name: string) => {
    const { exitCode, stdout } = await $.process.run(["/usr/bin/printenv", name]);
    return exitCode === 0 ? stdout.trim() : undefined;
  };

  const connection = async ($: EngineInterface) => {
    const home = (await env($, "CLAUDE_CONFIG_DIR")) ?? (await env($, "HOME")) + "/.claude";
    const parsed = JSON.parse(await $.fs.read(home + "/" + CONNECTION_FILE));
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("T3 Code bridge schema " + parsed.schemaVersion + " is not supported");
    }
    return parsed;
  };

  const loop = async ($: EngineInterface) => {
    if (polling) return;
    polling = true;
    const sessionId = await $.session.id();
    $.ui.status("T3 Code bridge");
    while (!released) {
      try {
        const { url, token } = await connection($);
        const response = await $.http.fetch(url + "/poll", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId, busy }),
        });
        if (!response.ok) throw new Error("T3 Code bridge poll answered " + response.status);
        for (const command of JSON.parse(response.text).commands) {
          if (released || command.type !== "submit") continue;
          await $.prompt.submit(
            command.asUser === true ? { text: command.text, asUser: true } : { text: command.text },
          );
        }
      } catch {
        await $.clock.sleep(RETRY_MS);
      }
    }
    polling = false;
    $.ui.status(undefined);
  };

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (e.isInteractive) {
      await $.command.register({
        name: "t3-bridge",
        description: "release: stop T3 Code sending to this session; resume: let it again",
      });
      void loop($);
    }
    return result;
  });

  on("command.run", { command: "t3-bridge" }, ($, e, next) => {
    const argument = e.args.trim();
    if (argument === "release") {
      released = true;
      return { text: "T3 Code no longer sends to this session." };
    }
    if (argument === "resume") {
      released = false;
      void loop($);
      return { text: "T3 Code can send to this session again." };
    }
    return next(e);
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
      }),
    ],
    [`${CLAUDE_BRIDGE_MOD_NAME}/hooks/hooks.json`, json({ modules: ["./register.ts"] })],
    [`${CLAUDE_BRIDGE_MOD_NAME}/hooks/register.ts`, REGISTER_SOURCE],
  ]);
}
