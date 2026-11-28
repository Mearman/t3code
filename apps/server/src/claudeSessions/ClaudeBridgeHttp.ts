import {
  CLAUDE_BRIDGE_PROOF_HEADER,
  CLAUDE_BRIDGE_ROUTE_PREFIX,
  ClaudeBridgePoll,
} from "@t3tools/contracts";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";

import { isDirectSameHostRequest } from "../auth/utils.ts";
import { ClaudeBridge } from "./ClaudeBridge.ts";

const NO_STORE = { "cache-control": "no-store" };
const decodePoll = Schema.decodeUnknownEffect(ClaudeBridgePoll);

function presentsToken(authorization: string | undefined, token: string): boolean {
  const encoder = new TextEncoder();
  return Mac.timingSafeEqual(
    encoder.encode(authorization ?? ""),
    encoder.encode(`Bearer ${token}`),
  );
}

/**
 * Answers one poll. A request not straight from this host, or without the token from this
 * server's 0600 connection file, gets a bare 403; every other answer carries the proof the mod
 * checks, so the mod trusts no other process that answers at this address.
 */
export const answerClaudeBridgePoll = Effect.fn("ClaudeBridgeHttp.answerPoll")(function* (input: {
  readonly sameHost: boolean;
  readonly authorization: string | undefined;
  /** The request body as JSON, or none when it is not JSON. */
  readonly body: Effect.Effect<Option.Option<unknown>>;
}) {
  const bridge = yield* ClaudeBridge;
  if (!input.sameHost || !presentsToken(input.authorization, bridge.token)) {
    return HttpServerResponse.empty({ status: 403, headers: NO_STORE });
  }
  const headers = { ...NO_STORE, [CLAUDE_BRIDGE_PROOF_HEADER]: bridge.proof };
  const json = yield* input.body;
  const poll = Option.isNone(json)
    ? Option.none()
    : yield* decodePoll(json.value).pipe(Effect.option);
  if (Option.isNone(poll)) return HttpServerResponse.empty({ status: 400, headers });
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
});

/** The route's handler, reading the request it answers. */
export const handleClaudeBridgePoll = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* answerClaudeBridgePoll({
    sameHost: isDirectSameHostRequest(request),
    authorization: request.headers["authorization"],
    body: request.json.pipe(Effect.option),
  });
});

export const layer = HttpRouter.add(
  "POST",
  `${CLAUDE_BRIDGE_ROUTE_PREFIX}/poll`,
  handleClaudeBridgePoll,
);
