import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  type ClaudeAccountCreateInput,
  type ClaudeAccountCreateResult,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** What a managed home links to the shared store; its login and settings stay its own. */
export const CLAUDE_SHARED_HISTORY_DIRECTORIES = [
  "projects",
  "sessions",
  "file-history",
  "tasks",
] as const;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/**
 * Creates `home` (which must not exist) and, with `store`, links each shared history directory to
 * the store's real directory, creating it there first, so each transcript has one copy that both
 * homes reach.
 */
export const createManagedClaudeHome = Effect.fn("ClaudeAccounts.createManagedHome")(function* (
  home: string,
  store: string | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(home), { recursive: true });
  yield* fileSystem.makeDirectory(home, { mode: 0o700 });
  if (store === undefined) return;
  for (const directory of CLAUDE_SHARED_HISTORY_DIRECTORIES) {
    const target = path.join(store, directory);
    yield* fileSystem.makeDirectory(target, { recursive: true });
    yield* fileSystem.symlink(yield* fileSystem.realPath(target), path.join(home, directory));
  }
});

/** Adds a Claude instance on a new managed home under the server's state directory. */
export const createClaudeAccount = Effect.fn("ClaudeAccounts.create")(function* (
  input: ClaudeAccountCreateInput,
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const failure = (detail: string) => (cause: unknown) =>
    new ProviderSetupError({ instanceId, operation: "createAccount", detail, cause });
  const instanceId = ProviderInstanceId.make(
    `claudeAgent_${yield* random.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: ProviderInstanceId.make(CLAUDE_DRIVER),
            operation: "createAccount",
            detail: "Could not name the new Claude account.",
            cause,
          }),
      ),
    )}`,
  );

  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(failure("Could not read this environment's settings.")),
  );
  let store: string | undefined;
  if (input.shareHistoryWith !== undefined) {
    const source = settings.providerInstances[input.shareHistoryWith];
    const config =
      source?.driver === CLAUDE_DRIVER ? decodeClaudeSettings(source.config ?? {}) : undefined;
    if (config === undefined || config._tag === "None")
      return yield* new ProviderSetupError({
        instanceId,
        operation: "createAccount",
        detail: "The Claude account to share history with is not configured here.",
      });
    const environment = yield* mergeProviderInstanceEnvironment(
      source?.environment,
      yield* HostProcess.Environment,
    ).pipe(Effect.mapError(failure("Could not read that account's environment.")));
    store = yield* resolveClaudeHomePath(config.value, environment);
  }

  const home = path.join(stateDir, "providers", CLAUDE_DRIVER, instanceId, "home");
  yield* createManagedClaudeHome(home, store).pipe(
    Effect.mapError(failure("Could not create the Claude account's config folder.")),
  );
  yield* settingsService
    .updateProviderInstance({
      operation: "create",
      instanceId,
      instance: {
        driver: CLAUDE_DRIVER,
        displayName: input.displayName,
        enabled: true,
        config: { homePath: home },
      },
    })
    .pipe(Effect.mapError(failure("Could not save the Claude account.")));
  return { instanceId } satisfies ClaudeAccountCreateResult;
});
