import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CLAUDE_BRIDGE_PROOF_HEADER,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  CLAUDE_BRIDGE_SCHEMA_VERSION,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";

import { ClaudeBridge, layer as bridgeLayer } from "./ClaudeBridge.ts";
import { answerClaudeBridgePoll, layer as routeLayer } from "./ClaudeBridgeHttp.ts";

const bridge = bridgeLayer.pipe(Layer.provide(SecureRandom.layerWebCrypto));
const body = Effect.succeed({ schemaVersion: CLAUDE_BRIDGE_SCHEMA_VERSION, sessionId: "a", acks: [] });

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

  it.effect("refuses a request that did not come straight from this host", () =>
    Effect.gen(function* () {
      const { token } = yield* ClaudeBridge;
      const { handler, dispose } = HttpRouter.toWebHandler(
        routeLayer.pipe(Layer.provide(Layer.succeed(ClaudeBridge, yield* ClaudeBridge))),
        { disableLogger: true },
      );
      // A web request carries no socket, as one through a proxy or a browser shows none to trust.
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`http://127.0.0.1${CLAUDE_BRIDGE_ROUTE_PREFIX}/poll`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ schemaVersion: 1, sessionId: "a", acks: [] }),
          }),
        ),
      );
      yield* Effect.promise(dispose);

      assert.strictEqual(response.status, 403);
      assert.isNull(response.headers.get(CLAUDE_BRIDGE_PROOF_HEADER));
    }).pipe(Effect.provide(bridge)),
  );
});
