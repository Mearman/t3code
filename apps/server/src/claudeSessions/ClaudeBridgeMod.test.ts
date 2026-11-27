import { assert, it } from "@effect/vitest";
import {
  CLAUDE_BRIDGE_CONNECTION_DIRECTORY,
  CLAUDE_BRIDGE_MOD_NAME,
  CLAUDE_BRIDGE_PROOF_HEADER,
} from "@t3tools/contracts";

import { claudeBridgeMarketplaceFiles } from "./ClaudeBridgeMod.ts";

it("ships a marketplace whose one plugin is the mod its hooks file names", () => {
  const files = claudeBridgeMarketplaceFiles("1.2.3");
  const marketplace = JSON.parse(files.get(".claude-plugin/marketplace.json") ?? "{}");
  const plugin = JSON.parse(
    files.get(`${CLAUDE_BRIDGE_MOD_NAME}/.claude-plugin/plugin.json`) ?? "{}",
  );
  const hooks = JSON.parse(files.get(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/hooks.json`) ?? "{}");

  assert.deepStrictEqual(
    marketplace.plugins.map((entry: { readonly name: string }) => entry.name),
    [CLAUDE_BRIDGE_MOD_NAME],
  );
  assert.strictEqual(plugin.version, "1.2.3");
  assert.isTrue(files.has(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/${hooks.modules[0].slice(2)}`));
});

// The mod's behaviour runs in Claude Code's own test kit:
// apps/server/scripts/test-claude-bridge-mod.ts.
it("builds the mod from the bridge contract's names", () => {
  const source =
    claudeBridgeMarketplaceFiles("1.2.3").get(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/register.ts`) ?? "";
  assert.include(source, JSON.stringify(CLAUDE_BRIDGE_CONNECTION_DIRECTORY));
  assert.include(source, JSON.stringify(CLAUDE_BRIDGE_PROOF_HEADER));
});
