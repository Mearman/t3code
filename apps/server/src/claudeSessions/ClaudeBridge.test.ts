import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CLAUDE_BRIDGE_CONNECTION_FILE,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
  ClaudeBridgeConnection,
  type ClaudeBridgePoll,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import { CLAUDE_BRIDGE_POLL_HOLD, ClaudeBridge, layer as bridgeLayer } from "./ClaudeBridge.ts";

const layer = bridgeLayer.pipe(Layer.provide(SecureRandom.layerWebCrypto));

const poll = (sessionId: string): ClaudeBridgePoll => ({
  schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
  sessionId,
});

it.layer(NodeServices.layer)("ClaudeBridge", (it) => {
  it.effect("hands a queued prompt to the session's next poll, and to no other session's", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      yield* bridge.submit({ sessionId: "a", commandId: "run-1", text: "/plan", asUser: false });

      const commands = yield* bridge.poll(poll("a"));
      const other = yield* bridge.poll(poll("b")).pipe(Effect.forkChild);
      yield* TestClock.adjust(CLAUDE_BRIDGE_POLL_HOLD);

      assert.strictEqual(commands.length, 1);
      const [command] = commands;
      assert.strictEqual(command?.asUser, false);
      assert.isFalse(command?.text.startsWith("/"));
      assert.deepStrictEqual(yield* Fiber.join(other), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts a session attached only while its mod polls or just polled", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      assert.isFalse(yield* bridge.attached("a"));

      const open = yield* bridge.poll(poll("a")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isTrue(yield* bridge.attached("a"));
      yield* TestClock.adjust(CLAUDE_BRIDGE_POLL_HOLD);
      yield* Fiber.join(open);
      assert.isTrue(yield* bridge.attached("a"));
      yield* TestClock.adjust("1 minute");
      assert.isFalse(yield* bridge.attached("a"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("writes the connection file only its owner can read, once the server listens", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const bridge = yield* ClaudeBridge;
      const file = path.join(home, CLAUDE_BRIDGE_CONNECTION_FILE);

      yield* bridge.registerHome(home);
      assert.isFalse(yield* fileSystem.exists(file));
      yield* bridge.serveAt("http://127.0.0.1:3774");

      const info = yield* fileSystem.stat(file);
      assert.strictEqual(info.mode & 0o777, 0o600);
      const connection = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeBridgeConnection))(
        yield* fileSystem.readFileString(file),
      );
      assert.strictEqual(connection.url, `http://127.0.0.1:3774${CLAUDE_BRIDGE_ROUTE_PREFIX}`);
      assert.strictEqual(connection.token, bridge.token);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
