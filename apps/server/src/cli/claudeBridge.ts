import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import {
  CLAUDE_BRIDGE_MARKETPLACE,
  CLAUDE_BRIDGE_MIN_CLAUDE_VERSION,
  CLAUDE_BRIDGE_PLUGIN_ID,
  claudeBridgeMarketplaceFiles,
} from "../claudeSessions/ClaudeBridgeMod.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

export class ClaudeBridgeInstallError extends Schema.TaggedError<ClaudeBridgeInstallError>()(
  "ClaudeBridgeInstallError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.step}: ${this.detail}`;
  }
}

const versionParts = (version: string) =>
  (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);

/** Whether `claude --version` output names a build at least `minimum`. */
export function claudeVersionAtLeast(output: string, minimum: string): boolean {
  const found = versionParts(output);
  const wanted = versionParts(minimum);
  if (found.length !== 3) return false;
  for (const [index, part] of found.entries()) {
    const other = wanted[index] ?? 0;
    if (part !== other) return part > other;
  }
  return true;
}

const run = Effect.fn("claudeBridge.run")(function* (
  step: string,
  binary: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make(binary, args, { env, extendEnv: true, stdin: "ignore" }))
    .pipe(
      Effect.mapError((cause) => new ClaudeBridgeInstallError({ step, detail: String(cause) })),
    );
});

const bridgeFlags = {
  baseDir: baseDirFlag,
  home: Flag.String("home").pipe(
    Flag.withDescription("Claude home to act on (CLAUDE_CONFIG_DIR). Defaults to ~/.claude."),
    Flag.optional,
  ),
  binary: Flag.String("binary").pipe(
    Flag.withDescription("The claude executable. Defaults to claude on PATH."),
    Flag.withDefault("claude"),
  ),
};

const homeEnv = (home: Option.Option<string>) =>
  Option.match(home, {
    onNone: () => ({}),
    onSome: (value) => ({ CLAUDE_CONFIG_DIR: value }),
  });

/** The directory a home's marketplace lives in: one per home, so removing one leaves the rest. */
export function claudeBridgeMarketplaceDirectory(home: string): string {
  return home.replaceAll(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

const marketplaceRoot = Effect.fn("claudeBridge.marketplaceRoot")(function* (
  baseDir: Option.Option<string>,
  homeFlag: Option.Option<string>,
) {
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  // The home claude itself uses: the flag, else the caller's CLAUDE_CONFIG_DIR, else ~/.claude.
  const home = path.resolve(
    Option.getOrUndefined(homeFlag) ??
      env.CLAUDE_CONFIG_DIR ??
      path.join(yield* HostProcess.HomeDirectory, ".claude"),
  );
  return path.join(
    yield* resolveBaseDir(Option.getOrUndefined(baseDir)),
    "claude-bridge",
    claudeBridgeMarketplaceDirectory(home),
  );
});

const installCommand = Command.make("install", bridgeFlags).pipe(
  Command.withDescription(
    "Install the T3 bridge mod into a Claude home, so T3 Code can send to a session a terminal holds. A running claude loads it after /reload-plugins.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = homeEnv(flags.home);
      const version = yield* run("read the claude version", flags.binary, ["--version"], env);
      if (!claudeVersionAtLeast(version, CLAUDE_BRIDGE_MIN_CLAUDE_VERSION)) {
        return yield* new ClaudeBridgeInstallError({
          step: "install the bridge mod",
          detail: `it needs Claude Code ${CLAUDE_BRIDGE_MIN_CLAUDE_VERSION} or later, found ${version.trim()}`,
        });
      }
      const root = yield* marketplaceRoot(flags.baseDir, flags.home);
      for (const [relative, text] of claudeBridgeMarketplaceFiles(packageJson.version)) {
        const file = path.join(root, relative);
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFileString(file, text);
      }
      // A local marketplace with a relative source runs these files, so an update is a rewrite.
      yield* run(
        "add the T3 Code marketplace",
        flags.binary,
        ["plugin", "marketplace", "add", root],
        env,
      );
      yield* run(
        "install the bridge mod",
        flags.binary,
        ["plugin", "install", CLAUDE_BRIDGE_PLUGIN_ID],
        env,
      );
      yield* Console.log(
        `Installed ${CLAUDE_BRIDGE_PLUGIN_ID} from the ${CLAUDE_BRIDGE_MARKETPLACE} marketplace at ${root}. Run /reload-plugins in a claude that is already running.`,
      );
    }),
  ),
);

const uninstallCommand = Command.make("uninstall", bridgeFlags).pipe(
  Command.withDescription(
    "Remove the T3 bridge mod and its marketplace from a Claude home. A running claude drops it after /reload-plugins.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const env = homeEnv(flags.home);
      yield* run(
        "uninstall the bridge mod",
        flags.binary,
        ["plugin", "uninstall", CLAUDE_BRIDGE_PLUGIN_ID],
        env,
      );
      yield* run(
        "remove the T3 Code marketplace",
        flags.binary,
        ["plugin", "marketplace", "remove", CLAUDE_BRIDGE_MARKETPLACE],
        env,
      );
      const root = yield* marketplaceRoot(flags.baseDir, flags.home);
      yield* fileSystem.remove(root, { recursive: true, force: true });
      yield* Console.log(
        `Removed ${CLAUDE_BRIDGE_PLUGIN_ID} and the ${CLAUDE_BRIDGE_MARKETPLACE} marketplace. Run /reload-plugins in a claude that is already running.`,
      );
    }),
  ),
);

export const claudeCommand = Command.make("claude").pipe(
  Command.withDescription("Claude Code integration."),
  Command.withSubcommands([
    Command.make("bridge").pipe(
      Command.withDescription(
        "The T3 bridge mod that lets T3 Code drive a session a terminal holds.",
      ),
      Command.withSubcommands([installCommand, uninstallCommand]),
    ),
  ]),
);
