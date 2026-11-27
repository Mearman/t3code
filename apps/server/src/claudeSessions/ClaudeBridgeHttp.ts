import {
  CLAUDE_BRIDGE_PROOF_HEADER,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  ClaudeBridgePoll,
} from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { isDirectSameHostRequest } from "../auth/utils.ts";
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
 * The bridge mod's poll. It answers only a request straight from this host that carries the token
 * from this server's 0600 connection file; every answer carries the proof the mod checks, so the
 * mod trusts no other process that answers at this address.
 */
export const layer = HttpRouter.add(
  "POST",
  `${CLAUDE_BRIDGE_ROUTE_PREFIX}/poll`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bridge = yield* ClaudeBridge;
    if (!isDirectSameHostRequest(request) || !presentsToken(request, bridge.token)) {
      return HttpServerResponse.empty({ status: 403, headers: NO_STORE });
    }
    const headers = { ...NO_STORE, [CLAUDE_BRIDGE_PROOF_HEADER]: bridge.proof };
    const poll = yield* request.json.pipe(Effect.flatMap(decodePoll), Effect.option);
    if (poll._tag === "None") return HttpServerResponse.empty({ status: 400, headers });
    const answer = yield* bridge.poll(poll.value);
    if (answer._tag === "refused") {
      return yield* HttpServerResponse.json(
        { reason: answer.reason },
        { status: answer.reason === "claimed" ? 409 : 429, headers },
      );
    }
    return yield* HttpServerResponse.json(
      { pollerKey: answer.pollerKey, commands: answer.commands },
      { headers },
    );
  }),
);
