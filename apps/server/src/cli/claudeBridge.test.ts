import { assert, it } from "@effect/vitest";

import { CLAUDE_BRIDGE_MIN_CLAUDE_VERSION } from "../claudeSessions/ClaudeBridgeMod.ts";
import { claudeBridgeMarketplaceDirectory, claudeVersionAtLeast } from "./claudeBridge.ts";

it("installs the bridge only into a Claude Code that has the mod API", () => {
  assert.isTrue(claudeVersionAtLeast("2.1.287 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isTrue(claudeVersionAtLeast("2.1.309 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isTrue(claudeVersionAtLeast("2.2.0 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("2.1.286 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("1.9.999", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("unknown", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
});

it("gives each Claude home its own marketplace directory", () => {
  const a = claudeBridgeMarketplaceDirectory("/home/user/.claude");
  const b = claudeBridgeMarketplaceDirectory("/home/user/.claude-work");
  assert.notStrictEqual(a, b);
  assert.notInclude(a, "/");
  assert.strictEqual(a, claudeBridgeMarketplaceDirectory("/home/user/.claude"));
});
