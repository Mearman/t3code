// @effect-diagnostics nodeBuiltinImport:off - a maintenance script that writes a folder and runs claude.
/**
 * Runs the T3 bridge mod's own tests in Claude Code's mod test kit (`claude plugin test`), against
 * the exact files `t3 claude bridge install` writes. Needs a `claude` of the bridge's minimum
 * version on PATH, or its path in CLAUDE_BIN; CI has none, so run it where Claude Code is installed.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CLAUDE_BRIDGE_MOD_NAME } from "@t3tools/contracts";

import { claudeBridgeMarketplaceFiles } from "../src/claudeSessions/ClaudeBridgeMod.ts";

const MOD_TEST = `import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/user/.claude";
const PROOF = "proof-a";
const connection = { schemaVersion: 1, url: "http://127.0.0.1:3774/claude-bridge/v1", token: "t", proof: PROOF };

type Command = { type: "submit"; commandId: string; sessionId: string; text: string; asUser: boolean };

function world(on, options: { proof?: string; commands?: (poll: any) => Command[] } = {}) {
  const clock = mock.clock(on);
  mock.env(on, { CLAUDE_CONFIG_DIR: HOME });
  const state = { session: "s1", polls: [] as any[], submitted: [] as any[], fetched: 0 };
  on("fs.exists", () => true);
  on("fs.list", () => [{ name: "server-a.json", kind: "file", size: 1, mtimeMs: 0, isLink: false }]);
  on("fs.read", () => JSON.stringify(connection));
  on("session.id", () => state.session);
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("command.register", (_, e) => ({ command: e.name }));
  on("ui.status", () => undefined);
  on("ui.log", () => undefined);
  on("http.fetch", (_, e) => {
    state.fetched += 1;
    const poll = JSON.parse(String(e.init?.body));
    state.polls.push(poll);
    return {
      status: 200,
      ok: true,
      headers: { "x-t3-bridge-proof": options.proof ?? PROOF },
      text: JSON.stringify({ pollerKey: "key-" + poll.sessionId, commands: options.commands?.(poll) ?? [] }),
    };
  });
  on("prompt.submit", (_, e) => {
    state.submitted.push({ text: e.text, asUser: e.origin?.kind === "plugin" ? e.origin.asUser === true : false });
    return { text: e.text };
  });
  return { clock, state };
}

const start = ($, isInteractive = true) =>
  $.session.start({ cwd: "/home/user/app", surface: isInteractive ? "terminal" : null, isInteractive });

const submit = (commandId: string, sessionId: string, asUser = false): Command => ({
  type: "submit", commandId, sessionId, text: "hello " + commandId, asUser,
});

test("submits a prompt only into the session it names, and acknowledges each", async ($, on) => {
  const { clock, state } = world(on, {
    commands: (poll) => (poll.acks.length === 0 ? [submit("c1", "s1", true), submit("c0", "s0")] : []),
  });
  await start($);
  await clock.advance(1000);
  await clock.advance(1000);

  expect(state.submitted).toEqual([{ text: "hello c1", asUser: true }]);
  expect(state.polls[1].acks).toEqual([
    { commandId: "c1", submitted: true },
    { commandId: "c0", submitted: false, reason: "the terminal started another conversation" },
  ]);
});

test("submits a prompt handed out twice once", async ($, on) => {
  const { clock, state } = world(on, { commands: () => [submit("c1", "s1")] });
  await start($);
  await clock.advance(1000);
  await clock.advance(1000);

  expect(state.submitted).toHaveLength(1);
  expect(state.polls[1].acks).toEqual([{ commandId: "c1", submitted: true }]);
});

test("ignores an answer without the server's proof", async ($, on) => {
  const { clock, state } = world(on, { proof: "someone-else", commands: () => [submit("c1", "s1")] });
  await start($);
  await clock.advance(1000);

  expect(state.submitted).toEqual([]);
});

test("polls under the new session after a clear, with a new key", async ($, on) => {
  const { clock, state } = world(on);
  await start($);
  await clock.advance(1000);
  state.session = "s2";
  await start($);
  await clock.advance(1000);

  expect(state.polls.map((poll) => [poll.sessionId, poll.pollerKey])).toEqual([
    ["s1", undefined],
    ["s2", undefined],
  ]);
});

test("refuses what it is handed once released, and takes it again on resume", async ($, on) => {
  const { clock, state } = world(on, {
    commands: (poll) => (poll.acks.length === 0 ? [submit("c" + state.polls.length, "s1")] : []),
  });
  await start($);
  await $.command.run({ command: "t3-bridge", args: "release" });
  await clock.advance(1000);
  await clock.advance(1000);
  expect(state.submitted).toEqual([]);
  expect(state.polls[1].acks[0]).toEqual({
    commandId: "c1",
    submitted: false,
    reason: "the terminal released the session",
  });
  await $.command.run({ command: "t3-bridge", args: "resume" });
  await clock.advance(1000);
  expect(state.submitted).toHaveLength(1);
});

test("stays inert outside an interactive session", async ($, on) => {
  const { clock, state } = world(on);
  await start($, false);
  await clock.advance(5000);

  expect(state.fetched).toBe(0);
});
`;

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-bridge-mod-"));
try {
  for (const [relative, text] of claudeBridgeMarketplaceFiles("0.0.0-test")) {
    const file = NodePath.join(root, relative);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  }
  const plugin = NodePath.join(root, CLAUDE_BRIDGE_MOD_NAME);
  NodeFS.writeFileSync(NodePath.join(plugin, "hooks", "register.test.ts"), MOD_TEST);
  const claude = process.env.CLAUDE_BIN ?? "claude";
  for (const args of [
    ["plugin", "validate", plugin],
    ["plugin", "test", plugin],
  ]) {
    const run = NodeChildProcess.spawnSync(claude, args, { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
} finally {
  NodeFS.rmSync(root, { recursive: true, force: true });
}
