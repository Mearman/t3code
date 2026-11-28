import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CLAUDE_SHARED_HISTORY_DIRECTORIES,
  createClaudeAccount,
  createManagedClaudeHome,
} from "./ClaudeAccounts.ts";

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

it.effect("links a managed home's history to the store so one transcript serves both", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const store = path.join(root, "store");
    const home = path.join(root, "managed", "home");
    yield* fileSystem.makeDirectory(path.join(store, "projects", "-repo"), { recursive: true });
    yield* createManagedClaudeHome(home, store).pipe(Effect.asVoid);

    for (const directory of CLAUDE_SHARED_HISTORY_DIRECTORIES) {
      assert.strictEqual(
        yield* fileSystem.realPath(path.join(home, directory)),
        path.join(store, directory),
      );
    }
    const transcript = path.join("projects", "-repo", "session.jsonl");
    yield* fileSystem.writeFileString(path.join(home, transcript), '{"type":"user"}\n');
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(store, transcript)),
      '{"type":"user"}\n',
    );
    assert.isFalse(yield* fileSystem.exists(path.join(home, ".credentials.json")));

    const existing = yield* createManagedClaudeHome(home, store).pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(existing._tag, "PlatformError");
    // Refusing an existing home leaves it, and the history it reaches, as it was.
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(home, transcript)),
      '{"type":"user"}\n',
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("a home without a store shares nothing and is never reused", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const home = path.join(root, "home");
    yield* createManagedClaudeHome(home, undefined).pipe(Effect.asVoid);
    assert.deepEqual(yield* fileSystem.readDirectory(home), []);
    // An existing home may hold another account's login, so it is never reused.
    assert.strictEqual(
      (yield* createManagedClaudeHome(home, undefined).pipe(Effect.asVoid, Effect.flip))._tag,
      "PlatformError",
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

const personal = ProviderInstanceId.make("claudeAgent_personal");
const accountLayer = (root: string, store: string) =>
  Layer.mergeAll(
    ServerSettings.layerTest({
      providerInstances: {
        [personal]: { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath: store } },
        [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex") },
      },
    }),
    ServerConfig.layerTest(root, { prefix: "t3code-claude-accounts-test-" }),
  );

it.effect("adds an instance on a managed home under the state directory", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const store = path.join(root, "personal");
    yield* Effect.gen(function* () {
      const { instanceId } = yield* createClaudeAccount({
        displayName: "Work",
        shareHistoryWith: personal,
      });
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const instance = settings.providerInstances[instanceId];
      assert.strictEqual(instance?.displayName, "Work");
      assert.strictEqual(instance?.enabled, true);
      assert.match(instanceId, /^claudeAgent_[0-9a-f-]{36}$/u);
      const { homePath } = decodeClaudeSettings(instance?.config);
      assert.strictEqual(
        homePath,
        path.join(stateDir, "providers", "claudeAgent", instanceId, "home"),
      );
      assert.strictEqual(
        yield* fileSystem.realPath(path.join(homePath, "projects")),
        path.join(store, "projects"),
      );
    }).pipe(Effect.provide(accountLayer(root, store)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses to share history with an instance that is not Claude", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const error = yield* createClaudeAccount({
      displayName: "Work",
      shareHistoryWith: ProviderInstanceId.make("codex"),
    }).pipe(Effect.provide(accountLayer(root, root)), Effect.flip);
    if (error._tag !== "ProviderSetupError") return assert.fail(`unexpected ${error._tag}`);
    assert.strictEqual(
      error.detail,
      "The Claude account to share history with is not configured here.",
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("links a home sharing with a managed home straight to the real store", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const store = path.join(root, "store");
    const first = path.join(root, "first", "home");
    const second = path.join(root, "second", "home");
    yield* fileSystem.makeDirectory(store);
    yield* createManagedClaudeHome(first, store).pipe(Effect.asVoid);
    yield* createManagedClaudeHome(second, first).pipe(Effect.asVoid);
    for (const directory of CLAUDE_SHARED_HISTORY_DIRECTORIES)
      assert.strictEqual(
        yield* fileSystem.readLink(path.join(second, directory)),
        path.join(store, directory),
      );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

const refusingSave = (root: string, store: string) =>
  Layer.mergeAll(
    Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        return {
          ...settings,
          updateProviderInstance: () =>
            Effect.fail(
              new ServerSettingsError({
                settingsPath: "settings.json",
                operation: "create-provider-instance",
              }),
            ),
        };
      }).pipe(
        Effect.provide(
          ServerSettings.layerTest({
            providerInstances: {
              [personal]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: store },
              },
            },
          }),
        ),
      ),
    ),
    ServerConfig.layerTest(root, { prefix: "t3code-claude-accounts-test-" }),
  );

it.effect("leaves no folder, link or store directory behind when the save is refused", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const store = path.join(root, "personal");
    yield* fileSystem.makeDirectory(path.join(store, "projects"), { recursive: true });
    yield* Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const error = yield* createClaudeAccount({
        displayName: "Work",
        shareHistoryWith: personal,
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderSetupError");
      const accounts = path.join(stateDir, "providers", "claudeAgent");
      assert.deepEqual(
        (yield* fileSystem.exists(accounts)) ? yield* fileSystem.readDirectory(accounts) : [],
        [],
      );
      assert.deepEqual(yield* fileSystem.readDirectory(store), ["projects"]);
    }).pipe(Effect.provide(refusingSave(root, store)));
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("creates nothing when the organisation manages provider accounts", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    yield* Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const error = yield* createClaudeAccount({ displayName: "Work" }).pipe(Effect.flip);
      assert.include(error.message, "Example Corp manages the provider accounts");
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "providers", "claudeAgent")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(
            {},
            {
              organization: "Example Corp",
              lockedSettings: ["providerInstances"],
            },
          ),
          ServerConfig.layerTest(root, { prefix: "t3code-claude-accounts-test-" }),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("removes the half-made home when a link fails part-way", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const store = path.join(root, "store");
    const home = path.join(root, "accounts", "work", "home");
    // `projects` links; making `sessions` in the read-only store then fails.
    yield* fileSystem.makeDirectory(path.join(store, "projects"), { recursive: true });
    yield* fileSystem.chmod(store, 0o500);
    const failed = yield* createManagedClaudeHome(home, store).pipe(Effect.asVoid, Effect.flip);
    yield* fileSystem.chmod(store, 0o700);
    assert.strictEqual(failed._tag, "PlatformError");
    assert.isFalse(yield* fileSystem.exists(path.join(root, "accounts", "work")));
    assert.deepEqual(yield* fileSystem.readDirectory(store), ["projects"]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("removes the folder it made for the home when the home itself cannot be made", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    // A name longer than any file system allows fails after its parent folder is made.
    const home = path.join(root, "accounts", "work", "h".repeat(300));
    const failed = yield* createManagedClaudeHome(home, undefined).pipe(Effect.asVoid, Effect.flip);
    assert.strictEqual(failed._tag, "PlatformError");
    assert.isFalse(yield* fileSystem.exists(path.join(root, "accounts", "work")));
  }).pipe(Effect.scoped, Effect.provide(services)),
);
