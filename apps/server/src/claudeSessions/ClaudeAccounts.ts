import {
  ClaudeSettings,
  isManagedSettingPath,
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
import { linkDirectory } from "../directoryLink.ts";
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
 * homes reach. Returns a rollback that removes the home, its links and the directories it made.
 */
export const createManagedClaudeHome = Effect.fn("ClaudeAccounts.createManagedHome")(function* (
  home: string,
  store: string | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The rollback removes the home's own folder or, if this call made it, its account folder, never
  // an existing home (it may hold another account's login) nor the shared `providers` folders.
  let made: string | undefined;
  const madeInStore: Array<string> = [];
  // Removing the home removes its links, never what they point at.
  const rollback = Effect.gen(function* () {
    if (made !== undefined) yield* fileSystem.remove(made, { recursive: true });
    // A directory something wrote into since is left, so the rollback never deletes history.
    for (const directory of madeInStore)
      if ((yield* fileSystem.readDirectory(directory)).length === 0)
        yield* fileSystem.remove(directory, { recursive: true });
  }).pipe(Effect.ignore);
  yield* Effect.gen(function* () {
    if (!(yield* fileSystem.exists(path.dirname(home)))) {
      yield* fileSystem.makeDirectory(path.dirname(home), { recursive: true });
      made = path.dirname(home);
    }
    yield* fileSystem.makeDirectory(home, { mode: 0o700 });
    made ??= home;
  }).pipe(Effect.onError(() => rollback));
  if (store === undefined) return rollback;
  // A link or store directory failing part-way removes what this call made so far.
  yield* Effect.forEach(
    CLAUDE_SHARED_HISTORY_DIRECTORIES,
    (directory) =>
      Effect.gen(function* () {
        const target = path.join(store, directory);
        if (!(yield* fileSystem.exists(target))) {
          yield* fileSystem.makeDirectory(target, { recursive: true });
          madeInStore.push(target);
        }
        yield* linkDirectory(yield* fileSystem.realPath(target), path.join(home, directory));
      }),
    { discard: true },
  ).pipe(Effect.onError(() => rollback));
  return rollback;
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

  const policy = settingsService.managedPolicy;
  if (policy !== undefined && isManagedSettingPath(policy, `providerInstances.${instanceId}`))
    return yield* new ProviderSetupError({
      instanceId,
      operation: "createAccount",
      detail: `${policy.organization} manages the provider accounts on this environment.`,
    });
  const home = path.join(stateDir, "providers", CLAUDE_DRIVER, instanceId, "home");
  const rollback = yield* createManagedClaudeHome(home, store).pipe(
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
    .pipe(
      Effect.tapError(() => rollback),
      Effect.mapError(failure("Could not save the Claude account.")),
    );
  return { instanceId } satisfies ClaudeAccountCreateResult;
});
