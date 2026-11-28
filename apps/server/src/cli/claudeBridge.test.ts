import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { CLAUDE_BRIDGE_MIN_CLAUDE_VERSION } from "../claudeSessions/ClaudeBridgeMod.ts";
import {
  claudeBridgeMarketplaceDirectory,
  claudeCommand,
  claudeVersionAtLeast,
} from "./claudeBridge.ts";

it("installs the bridge only into a Claude Code that has the mod API", () => {
  assert.isTrue(claudeVersionAtLeast("2.1.287 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isTrue(claudeVersionAtLeast("2.1.309 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isTrue(claudeVersionAtLeast("2.2.0 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("2.1.286 (Claude Code)", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("1.9.999", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
  assert.isFalse(claudeVersionAtLeast("unknown", CLAUDE_BRIDGE_MIN_CLAUDE_VERSION));
});

it("gives each Claude home its own marketplace directory, even homes alike but for punctuation", () => {
  const homes = [
    "/home/user/.claude",
    "/home/user/.claude-work",
    "/home/user/.claude.work",
    "/home/user/.claude_work",
  ];
  const directories = homes.map(claudeBridgeMarketplaceDirectory);
  assert.strictEqual(new Set(directories).size, homes.length);
  for (const directory of directories) assert.notInclude(directory, "/");
  assert.strictEqual(directories[0], claudeBridgeMarketplaceDirectory("/home/user/.claude"));
});

it.layer(NodeServices.layer)("t3 claude bridge", (it) => {
  it.effect("installs into and uninstalls from the home's own marketplace directory only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-claude-bridge-cli-" })
        .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
      const baseDir = path.join(root, "state");
      const calls = path.join(root, "calls.log");
      // Stands in for claude: reports a version with the mod API and records every other call.
      const binary = path.join(root, "claude");
      yield* fileSystem.writeFileString(
        binary,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLAUDE_BRIDGE_MIN_CLAUDE_VERSION} (Claude Code)"; exit 0; fi\necho "$*" >> "${calls}"\n`,
      );
      yield* fileSystem.chmod(binary, 0o755);
      const work = path.join(root, ".claude-work");
      const other = path.join(root, ".claude_work");
      const bridge = (action: "install" | "uninstall", home: string) =>
        Command.runWith(claudeCommand, { version: "0.0.0" })([
          "bridge",
          action,
          "--home",
          home,
          "--binary",
          binary,
          "--base-dir",
          baseDir,
        ]);
      const marketplace = (home: string) =>
        path.join(baseDir, "claude-bridge", claudeBridgeMarketplaceDirectory(home));

      yield* bridge("install", work);
      yield* bridge("install", other);
      yield* bridge("uninstall", work);

      assert.include(
        yield* fileSystem.readFileString(calls),
        `plugin marketplace add ${marketplace(work)}\n`,
      );
      assert.isFalse(yield* fileSystem.exists(marketplace(work)));
      assert.isTrue(yield* fileSystem.exists(marketplace(other)));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Environment, {})),
  );
});
