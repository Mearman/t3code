// @effect-diagnostics nodeBuiltinImport:off - a script that writes a folder and runs claude.
/**
 * Runs the T3 bridge mod's tests in Claude Code's mod test kit (`claude plugin test`), against
 * the exact files `t3 claude bridge install` writes. Needs a `claude` of the bridge's minimum
 * version on PATH, or its path in CLAUDE_BIN; CI installs a pinned one on server shard 1.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CLAUDE_BRIDGE_MOD_NAME } from "@t3tools/contracts";

import { claudeBridgeMarketplaceFiles } from "../src/claudeSessions/ClaudeBridgeMod.ts";

const MOD_TEST = `import type { On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const HOME = "/home/user/.claude";
const PROOF = "proof-a";
const connection = { schemaVersion: 1, url: "http://127.0.0.1:3774/claude-bridge/v1", token: "t", proof: PROOF };

type Command = { type: "submit"; commandId: string; sessionId: string; text: string; asUser: boolean };
type Ack = { commandId: string; submitted: boolean; reason?: string };
type Poll = { schemaVersion: number; sessionId: string; pollerKey?: string; acks: Ack[] };

function world(on: On, options: { proof?: string; commands?: (poll: Poll) => Command[] } = {}) {
  const clock = mock.clock(on);
  mock.env(on, { CLAUDE_CONFIG_DIR: HOME });
  const state = {
    session: "s1",
    polls: [] as Poll[],
    submitted: [] as Array<{ text: string; asUser: boolean }>,
    fetched: 0,
  };
  // A call on $ is answered with { value }.
  on("fs.exists", () => ({ value: true }));
  on("fs.list", () => ({
    value: [{ name: "server-a.json", kind: "file", size: 1, mtimeMs: 0, isLink: false }],
  }));
  on("fs.read", () => ({ value: JSON.stringify(connection) }));
  on("session.id", () => ({ value: state.session }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("ui.status", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("http.fetch", (_, e) => {
    state.fetched += 1;
    const poll: Poll = JSON.parse(String(e.init?.body));
    state.polls.push(poll);
    return {
      value: {
        status: 200,
        ok: true,
        headers: { "x-t3-bridge-proof": options.proof ?? PROOF },
        text: JSON.stringify({
          pollerKey: "key-" + poll.sessionId,
          commands: options.commands?.(poll) ?? [],
        }),
      },
    };
  });
  on("prompt.submit", (_, e) => {
    state.submitted.push({ text: e.text, asUser: e.origin?.kind === "plugin" ? e.origin.asUser === true : false });
    return { text: e.text };
  });
  return { clock, state };
}

const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: "/home/user/app", surface: isInteractive ? "terminal" : null, isInteractive });

// The person typing /t3-bridge <args> at the prompt, as the engine stamps it.
const run = ($: Engine, args: string) =>
  $.command.run({
    command: "t3-bridge",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });

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
  expect(state.polls.at(1)?.acks).toEqual([
    { commandId: "c1", submitted: true },
    { commandId: "c0", submitted: false, reason: "anotherConversation" },
  ]);
});

test("submits a prompt handed out twice once, framed as the mod's unless it is the person's", async ($, on) => {
  const { clock, state } = world(on, { commands: () => [submit("c1", "s1")] });
  await start($);
  await clock.advance(1000);
  await clock.advance(1000);

  expect(state.submitted).toEqual([{ text: "hello c1", asUser: false }]);
  expect(state.polls.at(1)?.acks).toEqual([{ commandId: "c1", submitted: true }]);
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
  await run($, "release");
  await clock.advance(1000);
  await clock.advance(1000);
  expect(state.submitted).toEqual([]);
  expect(state.polls.at(1)?.acks[0]).toEqual({
    commandId: "c1",
    submitted: false,
    reason: "released",
  });
  await run($, "resume");
  await clock.advance(1000);
  expect(state.submitted).toHaveLength(1);
});

test("answers a bare or unknown argument with its usage, itself", async ($, on) => {
  world(on);
  await start($);

  for (const args of ["", "stop"]) {
    expect(await run($, args)).toEqual({ text: "Usage: /t3-bridge release, or /t3-bridge resume." });
  }
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
