import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CLAUDE_BRIDGE_PROOF_HEADER,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { ClaudeBridge, layer as bridgeLayer } from "./ClaudeBridge.ts";
import { answerClaudeBridgePoll, handleClaudeBridgePoll } from "./ClaudeBridgeHttp.ts";

const bridge = bridgeLayer.pipe(Layer.provide(SecureRandom.layerWebCrypto));
const body = Effect.succeedSome<unknown>({
  schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
  sessionId: "a",
  acks: [],
});

it.layer(NodeServices.layer)("ClaudeBridgeHttp", (it) => {
  it.effect("answers with the proof only a same-host caller holding the token", () =>
    Effect.gen(function* () {
      const { token, proof } = yield* ClaudeBridge;
      const answer = (sameHost: boolean, authorization: string | undefined) =>
        answerClaudeBridgePoll({ sameHost, authorization, body }).pipe(
          Effect.map(HttpServerResponse.toWeb),
        );

      const accepted = yield* answer(true, `Bearer ${token}`);
      const refusals = [
        yield* answer(false, `Bearer ${token}`),
        yield* answer(true, "Bearer someone-else"),
        yield* answer(true, undefined),
      ];

      assert.strictEqual(accepted.status, 200);
      assert.strictEqual(accepted.headers.get(CLAUDE_BRIDGE_PROOF_HEADER), proof);
      for (const refusal of refusals) {
        assert.strictEqual(refusal.status, 403);
        assert.isNull(refusal.headers.get(CLAUDE_BRIDGE_PROOF_HEADER));
      }
    }).pipe(Effect.provide(bridge)),
  );

  it.effect("takes an ack whose reason this server does not know, as a refusal", () =>
    Effect.gen(function* () {
      const claudeBridge = yield* ClaudeBridge;
      const first = yield* claudeBridge.poll({
        schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
        sessionId: "a",
        acks: [],
      });
      assert.strictEqual(first._tag, "accepted");
      const pollerKey = first._tag === "accepted" ? first.pollerKey : "";
      yield* claudeBridge.submit({
        sessionId: "a",
        threadId: "thread-a",
        runId: "run-a",
        text: "hello",
        asUser: false,
      });
      // A mod newer than this server reports a code it has never seen.
      const answer = yield* answerClaudeBridgePoll({
        sameHost: true,
        authorization: `Bearer ${claudeBridge.token}`,
        body: Effect.succeedSome<unknown>({
          schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
          sessionId: "a",
          pollerKey,
          acks: [{ commandId: "run-a", submitted: false, reason: "aCodeFromALaterBuild" }],
        }),
      }).pipe(Effect.map(HttpServerResponse.toWeb));

      assert.strictEqual(answer.status, 200);
      assert.deepStrictEqual(
        (yield* Queue.clear(claudeBridge.failures)).map((failure) => failure.reason),
        ["refused"],
      );
    }).pipe(Effect.provide(bridge)),
  );

  it.effect("answers through the route only a request straight from this host", () =>
    Effect.gen(function* () {
      const { token } = yield* ClaudeBridge;
      const route = (headers: Record<string, string>, peer: string | undefined) => {
        const web = new Request(`http://127.0.0.1${CLAUDE_BRIDGE_ROUTE_PREFIX}/poll`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({
            schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION,
            sessionId: "a",
            acks: [],
          }),
        });
        // Node's server request carries its socket; a web request has none unless given one.
        if (peer !== undefined) {
          Object.defineProperty(web, "socket", {
            value: { remoteAddress: peer, localAddress: "127.0.0.1" },
          });
        }
        return handleClaudeBridgePoll.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(web),
          ),
          Effect.map((response) => HttpServerResponse.toWeb(response).status),
        );
      };
      const host = { host: "127.0.0.1:3774" };

      const accepted = yield* route(host, "127.0.0.1");
      // Each passes a check on the peer's address alone: only the whole same-host check refuses it.
      const refused = [
        yield* route({ ...host, origin: "https://evil.example" }, "127.0.0.1"),
        yield* route({ ...host, "x-forwarded-for": "203.0.113.9" }, "127.0.0.1"),
        yield* route({ host: "evil.example" }, "127.0.0.1"),
        yield* route(host, undefined),
      ];

      assert.strictEqual(accepted, 200);
      assert.deepStrictEqual(refused, [403, 403, 403, 403]);
    }).pipe(Effect.provide(bridge)),
  );
});
