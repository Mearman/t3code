import {
  CLAUDE_SESSION_CHUNK_SHA256_HEADER,
  CLAUDE_SESSION_FILE_SIZE_HEADER,
  ClaudeRemoteSessionList,
  ClaudeSessionClaimInput,
  ClaudeSessionManifest,
  type ClaudeSessionReplicationError,
  PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_MANIFEST_ROUTE,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { sha256OfBytes } from "../claudeSessions/ClaudeSessionFiles.ts";
import * as ClaudeSessionReplication from "../claudeSessions/ClaudeSessionReplication.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";

const NO_STORE = { "cache-control": "no-store" };
const encodeList = Schema.encodeEffect(Schema.toCodecJson(ClaudeRemoteSessionList));
const encodeManifest = Schema.encodeEffect(Schema.toCodecJson(ClaudeSessionManifest));
const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSessionClaimInput));

const refusal = (status: number, error: string, message?: string) =>
  HttpServerResponse.jsonUnsafe(message === undefined ? { error } : { error, message }, {
    status,
    headers: NO_STORE,
  });

const fromReplicationError = (error: ClaudeSessionReplicationError) =>
  error.reason === "not_found"
    ? refusal(404, "session_not_found")
    : error.reason === "refused"
      ? refusal(409, "refused", error.message)
      : refusal(500, "session_read_failed");

/**
 * Admits a peer link's session as `/mcp` does: no browser origin, the link's own bearer, and the
 * Linked environments beta on here. Session files hold whatever the conversation did, so every
 * route but the listing also needs the link to have full access.
 */
const admitLink = Effect.fn("claudeSessionReplicaHttp.admitLink")(function* (fullAccess: boolean) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.origin !== undefined) return refusal(403, "origin_not_allowed");
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const settings = yield* ServerSettings.ServerSettingsService;
  const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
  if (client._tag === "None") return refusal(401, "unauthorized");
  if (!client.value.peerLink) return refusal(403, "not_a_link_session");
  const current = yield* settings.getSettings.pipe(Effect.option);
  if (current._tag === "None" || !current.value.linkedEnvironmentsEnabled) {
    return refusal(403, "linked_environments_off");
  }
  if (!current.value.claudeSessionSync.enabled) return refusal(404, "session_not_found");
  if (fullAccess && client.value.access !== "full-access") {
    return refusal(403, "full_access_required");
  }
  return {
    request,
    params: new URLSearchParams(request.url.split("?", 2)[1] ?? ""),
    linkExpiresAt: client.value.linkExpiresAt,
  };
});

const withLinkExpiry = (
  response: HttpServerResponse.HttpServerResponse,
  linkExpiresAt: DateTime.Utc | undefined,
) =>
  linkExpiresAt === undefined
    ? response
    : HttpServerResponse.setHeader(
        response,
        McpInvocationContext.LINK_EXPIRES_AT_HEADER,
        DateTime.formatIso(linkExpiresAt),
      );

const nonNegativeInt = (text: string | null) => {
  if (text === null || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
};

const listRoute = HttpRouter.add(
  "GET",
  PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink(false);
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const replication = yield* ClaudeSessionReplication.ClaudeSessionReplication;
    const limit = nonNegativeInt(admitted.params.get("limit"));
    const query = admitted.params.get("query") ?? undefined;
    const body = yield* replication
      .listOwned({
        ...(limit === undefined ? {} : { limit }),
        ...(query === undefined ? {} : { query }),
      })
      .pipe(Effect.flatMap(encodeList), Effect.option);
    if (body._tag === "None") return refusal(500, "session_read_failed");
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(body.value, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

const manifestRoute = HttpRouter.add(
  "GET",
  PEER_LINK_CLAUDE_SESSIONS_MANIFEST_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink(true);
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const sessionId = admitted.params.get("session");
    if (!sessionId) return refusal(400, "invalid_request");
    const prefixText = admitted.params.get("prefix");
    const prefixBytes = nonNegativeInt(prefixText);
    if (prefixText !== null && prefixBytes === undefined) return refusal(400, "invalid_request");
    const replication = yield* ClaudeSessionReplication.ClaudeSessionReplication;
    const manifest = yield* Effect.result(
      replication.manifest({
        sessionId,
        ...(prefixBytes === undefined ? {} : { prefixBytes }),
      }),
    );
    if (manifest._tag === "Failure") return fromReplicationError(manifest.failure);
    const body = yield* encodeManifest(manifest.success).pipe(Effect.option);
    if (body._tag === "None") return refusal(500, "session_read_failed");
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe(body.value, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

const fileRoute = HttpRouter.add(
  "GET",
  PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink(true);
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const sessionId = admitted.params.get("session");
    const filePath = admitted.params.get("path");
    const offset = nonNegativeInt(admitted.params.get("offset"));
    const length = nonNegativeInt(admitted.params.get("length"));
    if (!sessionId || !filePath || offset === undefined || length === undefined) {
      return refusal(400, "invalid_request");
    }
    const replication = yield* ClaudeSessionReplication.ClaudeSessionReplication;
    const chunk = yield* Effect.result(
      replication.readFile({ sessionId, path: filePath, offset, length }),
    );
    if (chunk._tag === "Failure") return fromReplicationError(chunk.failure);
    return withLinkExpiry(
      HttpServerResponse.uint8Array(chunk.success.bytes, {
        contentType: "application/octet-stream",
        headers: {
          ...NO_STORE,
          [CLAUDE_SESSION_CHUNK_SHA256_HEADER]: sha256OfBytes(chunk.success.bytes),
          [CLAUDE_SESSION_FILE_SIZE_HEADER]: String(chunk.success.fileSize),
        },
      }),
      admitted.linkExpiresAt,
    );
  }),
);

const claimRoute = HttpRouter.add(
  "POST",
  PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE,
  Effect.gen(function* () {
    const admitted = yield* admitLink(true);
    if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
    const text = yield* admitted.request.text.pipe(Effect.option);
    if (text._tag === "None") return refusal(400, "invalid_request");
    const input = yield* decodeClaim(text.value).pipe(Effect.option);
    if (input._tag === "None") return refusal(400, "invalid_request");
    const replication = yield* ClaudeSessionReplication.ClaudeSessionReplication;
    const claimed = yield* Effect.result(replication.claim(input.value));
    if (claimed._tag === "Failure") return fromReplicationError(claimed.failure);
    return withLinkExpiry(
      HttpServerResponse.jsonUnsafe({ accepted: true }, { headers: NO_STORE }),
      admitted.linkExpiresAt,
    );
  }),
);

/** What an environment serves of the Claude sessions it owns to the environments linked to it. */
export const layer = Layer.mergeAll(listRoute, manifestRoute, fileRoute, claimRoute);
