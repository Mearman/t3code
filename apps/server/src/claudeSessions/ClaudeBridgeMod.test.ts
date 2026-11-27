import { assert, it } from "@effect/vitest";
import { CLAUDE_BRIDGE_CONNECTION_FILE, CLAUDE_BRIDGE_MOD_NAME } from "@t3tools/contracts";

import { claudeBridgeMarketplaceFiles } from "./ClaudeBridgeMod.ts";

it("ships a marketplace whose one plugin is the mod its hooks file names", () => {
  const files = claudeBridgeMarketplaceFiles("1.2.3");
  const marketplace = JSON.parse(files.get(".claude-plugin/marketplace.json") ?? "{}");
  const plugin = JSON.parse(files.get(`${CLAUDE_BRIDGE_MOD_NAME}/.claude-plugin/plugin.json`) ?? "{}");
  const hooks = JSON.parse(files.get(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/hooks.json`) ?? "{}");

  assert.deepStrictEqual(
    marketplace.plugins.map((entry: { readonly name: string }) => entry.name),
    [CLAUDE_BRIDGE_MOD_NAME],
  );
  assert.strictEqual(plugin.version, "1.2.3");
  assert.isTrue(files.has(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/${hooks.modules[0].slice(2)}`));
});

it("keeps the mod inert outside an interactive session and reads its home's connection file", () => {
  const source =
    claudeBridgeMarketplaceFiles("1.2.3").get(`${CLAUDE_BRIDGE_MOD_NAME}/hooks/register.ts`) ?? "";
  assert.include(source, "if (e.isInteractive)");
  assert.include(source, JSON.stringify(CLAUDE_BRIDGE_CONNECTION_FILE));
  // A prompt goes as the person's words only when the server says so.
  assert.include(source, "command.asUser === true");
  assert.notInclude(source, '["/usr/bin/env"]');
});
