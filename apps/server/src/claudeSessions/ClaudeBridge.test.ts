import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CLAUDE_BRIDGE_CONNECTION_DIRECTORY,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
  ClaudeBridgeConnection,
  type ClaudeBridgeAck,
  type ClaudeBridgePoll,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import {
  CLAUDE_BRIDGE_COMMAND_TTL,
  CLAUDE_BRIDGE_MAX_PENDING,
  CLAUDE_BRIDGE_MAX_SESSIONS,
  ClaudeBridge,
  layer as bridgeLayer,
} from "./ClaudeBridge.ts";

const layer = bridgeLayer.pipe(Layer.provide(SecureRandom.layerWebCrypto));
const decodeConnection = Schema.decodeEffect(Schema.fromJsonString(ClaudeBridgeConnection));

const poll = (
  sessionId: string,
  pollerKey?: string,
  acks: ReadonlyArray<ClaudeBridgeAck> = [],
): ClaudeBridgePoll => ({
  schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
  sessionId,
  ...(pollerKey === undefined ? {} : { pollerKey }),
  acks,
});

const prompt = (runId: string, text = "hello", asUser = false) => ({
  sessionId: "a",
  threadId: "thread-a",
  runId,
  text,
  asUser,
});

// A mod polling session "a", returning its key.
const attach = Effect.gen(function* () {
  const bridge = yield* ClaudeBridge;
  const answer = yield* bridge.poll(poll("a"));
  if (answer._tag !== "accepted") throw new Error("expected the first poll to be accepted");
  return answer.pollerKey;
});

it.layer(NodeServices.layer)("ClaudeBridge", (it) => {
  it.effect("queues a prompt only for a session a mod polls, and only so many", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      const unattached = yield* Effect.flip(bridge.submit(prompt("run-0")));
      assert.include(unattached.reason, "not polling");

      yield* attach;
      for (let index = 0; index < CLAUDE_BRIDGE_MAX_PENDING; index += 1) {
        yield* bridge.submit(prompt(`run-${index + 1}`));
      }
      const full = yield* Effect.flip(bridge.submit(prompt("run-over")));
      assert.include(full.reason, "too many");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps a prompt until the mod acknowledges it, handing it out again after a lease",
    () =>
      Effect.gen(function* () {
        const bridge = yield* ClaudeBridge;
        const key = yield* attach;
        yield* bridge.submit(prompt("run-1", "/clear"));

        const first = yield* bridge.poll(poll("a", key));
        const leased = yield* bridge.poll(poll("a", key));
        yield* TestClock.adjust("16 seconds");
        const again = yield* bridge.poll(poll("a", key));
        const acked = yield* bridge.poll(poll("a", key, [{ commandId: "run-1", submitted: true }]));
        yield* TestClock.adjust("16 seconds");
        const after = yield* bridge.poll(poll("a", key));

        const commandsOf = (answer: typeof first) =>
          answer._tag === "accepted" ? answer.commands.map((command) => command.commandId) : [];
        assert.deepStrictEqual([first, leased, again, acked, after].map(commandsOf), [
          ["run-1"],
          [],
          ["run-1"],
          [],
          [],
        ]);
        // Text that is not a person's never reads as a slash command.
        assert.isFalse(
          first._tag === "accepted" &&
            (first.commands[0]?.text.trimStart().startsWith("/") ?? true),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("reports a prompt the mod refused, and one no mod took in time", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      const key = yield* attach;
      yield* bridge.submit(prompt("run-refused"));
      yield* bridge.submit(prompt("run-stale"));

      yield* bridge.poll(
        poll("a", key, [
          { commandId: "run-refused", submitted: false, reason: "anotherConversation" },
        ]),
      );
      yield* TestClock.adjust(CLAUDE_BRIDGE_COMMAND_TTL);
      yield* bridge.poll(poll("b"));

      const failures = yield* Queue.takeAll(bridge.failures);
      assert.deepStrictEqual(
        failures.map((failure) => [failure.runId, failure.threadId, failure.reason]),
        [
          ["run-refused", "thread-a", "anotherConversation"],
          ["run-stale", "thread-a", "expired"],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("times a handed-out prompt from its hand-out, so a late ack is not reported lost", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      const key = yield* attach;
      yield* bridge.submit(prompt("run-slow"));
      // Handed out late in its life, and acknowledged after it would have expired from queueing.
      yield* TestClock.adjust("90 seconds");
      yield* bridge.poll(poll("a", key));
      yield* TestClock.adjust("60 seconds");

      yield* bridge.poll(poll("a", key, [{ commandId: "run-slow", submitted: true }]));

      assert.deepStrictEqual(yield* Queue.clear(bridge.failures), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("applies an ack before expiring, and never hands out what has expired", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      const key = yield* attach;
      yield* bridge.submit(prompt("run-acked"));
      yield* bridge.submit(prompt("run-lost"));
      // Handed out between two of the bridge's own sweeps, so only these polls see them expire.
      yield* TestClock.adjust("5 seconds");
      yield* bridge.poll(poll("a", key));
      yield* TestClock.adjust(CLAUDE_BRIDGE_COMMAND_TTL);

      const answer = yield* bridge.poll(
        poll("a", key, [{ commandId: "run-acked", submitted: true }]),
      );

      assert.deepStrictEqual(answer, { _tag: "accepted", pollerKey: key, commands: [] });
      assert.deepStrictEqual(
        (yield* Queue.clear(bridge.failures)).map((failure) => failure.runId),
        ["run-lost"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lets one process poll a session at a time, and only so many sessions", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      yield* attach;

      const rival = yield* bridge.poll(poll("a", "someone-else"));
      yield* TestClock.adjust("11 seconds");
      const afterGrace = yield* bridge.poll(poll("a", "someone-else"));
      for (let index = 1; index < CLAUDE_BRIDGE_MAX_SESSIONS; index += 1) {
        yield* bridge.poll(poll(`session-${index}`));
      }
      const overCap = yield* bridge.poll(poll("one-too-many"));

      assert.deepStrictEqual(rival, { _tag: "refused", reason: "claimed" });
      assert.strictEqual(afterGrace._tag, "accepted");
      assert.deepStrictEqual(overCap, { _tag: "refused", reason: "full" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts a session attached only while its mod polls", () =>
    Effect.gen(function* () {
      const bridge = yield* ClaudeBridge;
      assert.isFalse(yield* bridge.attached("a"));
      yield* attach;
      assert.isTrue(yield* bridge.attached("a"));
      yield* TestClock.adjust("11 seconds");
      assert.isFalse(yield* bridge.attached("a"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("tightens an existing directory and removes a crashed server's file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const directory = path.join(home, CLAUDE_BRIDGE_CONNECTION_DIRECTORY);
      yield* fileSystem.makeDirectory(directory, { mode: 0o755 });
      const connectionOf = (pid: number) =>
        JSON.stringify({
          schemaVersion: 1,
          url: "http://127.0.0.1:1",
          token: "t",
          proof: "p",
          pid,
        });
      // 2^22 is above every pid Linux (below pid_max, at most 2^22) and macOS (at most 99999) hand
      // out, so no process holds it: this server stopped without removing its file.
      yield* fileSystem.writeFileString(path.join(directory, "dead.json"), connectionOf(2 ** 22));
      yield* fileSystem.writeFileString(path.join(directory, "live.json"), connectionOf(1));
      const bridge = yield* ClaudeBridge;

      yield* bridge.registerHome(home);
      yield* bridge.serveAt("http://127.0.0.1:3774");

      assert.strictEqual((yield* fileSystem.stat(directory)).mode & 0o777, 0o700);
      const names = yield* fileSystem.readDirectory(directory);
      assert.isFalse(names.includes("dead.json"));
      assert.isTrue(names.includes("live.json"));
      assert.strictEqual(names.length, 2);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("writes a file only its owner can read, and removes it when the server stops", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const directory = path.join(home, CLAUDE_BRIDGE_CONNECTION_DIRECTORY);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      const bridge = Context.get(context, ClaudeBridge);

      yield* bridge.registerHome(home);
      assert.isFalse(yield* fileSystem.exists(directory));
      yield* bridge.serveAt("http://127.0.0.1:3774");

      const [name] = yield* fileSystem.readDirectory(directory);
      assert.isDefined(name);
      const file = path.join(directory, name ?? "");
      assert.strictEqual((yield* fileSystem.stat(directory)).mode & 0o777, 0o700);
      assert.strictEqual((yield* fileSystem.stat(file)).mode & 0o777, 0o600);
      const connection = yield* decodeConnection(yield* fileSystem.readFileString(file));
      assert.strictEqual(connection.url, `http://127.0.0.1:3774${CLAUDE_BRIDGE_ROUTE_PREFIX}`);
      assert.strictEqual(connection.token, bridge.token);
      assert.strictEqual(connection.proof, bridge.proof);
      assert.notStrictEqual(connection.proof, connection.token);

      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(directory), []);
    }).pipe(Effect.scoped),
  );
});
