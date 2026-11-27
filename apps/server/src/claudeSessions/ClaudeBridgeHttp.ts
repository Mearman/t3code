import { CLAUDE_BRIDGE_ROUTE_PREFIX, ClaudeBridgePoll } from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { isDirectLoopbackRequest } from "../auth/utils.ts";
import { ClaudeBridge } from "./ClaudeBridge.ts";

const NO_STORE = { "cache-control": "no-store" };
const decodePoll = Schema.decodeUnknownEffect(ClaudeBridgePoll);

function presentsToken(request: HttpServerRequest.HttpServerRequest, token: string): boolean {
  const encoder = new TextEncoder();
  return Mac.timingSafeEqual(
    encoder.encode(request.headers["authorization"] ?? ""),
    encoder.encode(`Bearer ${token}`),
  );
}

/**
 * The bridge mod's poll. It answers only a request from this host, not one a local proxy
 * forwarded, that carries the token from the 0600 connection file in the Claude home.
 */
export const layer = HttpRouter.add(
  "POST",
  `${CLAUDE_BRIDGE_ROUTE_PREFIX}/poll`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bridge = yield* ClaudeBridge;
    if (!isDirectLoopbackRequest(request) || !presentsToken(request, bridge.token)) {
      return HttpServerResponse.empty({ status: 403, headers: NO_STORE });
    }
    const poll = yield* request.json.pipe(Effect.flatMap(decodePoll), Effect.option);
    if (poll._tag === "None") return HttpServerResponse.empty({ status: 400, headers: NO_STORE });
    const commands = yield* bridge.poll(poll.value);
    return yield* HttpServerResponse.json({ commands }, { headers: NO_STORE });
  }),
);
