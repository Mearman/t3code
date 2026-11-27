import {
  CLAUDE_SESSION_CHUNK_SHA256_HEADER,
  type ClaudeSessionClaimInput,
  ClaudeSessionClaimResult,
  ClaudeSessionManifest,
  ClaudeRemoteSessionList,
  ClaudeSessionReplicationError,
  type EnvironmentId,
  PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_MANIFEST_ROUTE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { sha256OfBytes } from "../claudeSessions/ClaudeSessionFiles.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** A whole chunk over a slow route: well beyond a link's probe timeout, still bounded. */
const TRANSFER_TIMEOUT = Duration.minutes(2);

const decodeList = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeRemoteSessionList));
const decodeManifest = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeSessionManifest));
const decodeClaim = Schema.decodeUnknownEffect(ClaudeSessionClaimResult);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.String, message: Schema.optionalKey(Schema.String) }),
);

/**
 * Reads the Claude Code sessions a linked environment owns, over the link this environment holds to
 * it, and asks it to hand one over. Every call needs the peer to advertise
 * `claudeSessionReplication`; only the listing works below full access.
 */
export class PeerClaudeSessions extends Context.Service<
  PeerClaudeSessions,
  {
    readonly list: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ClaudeRemoteSessionList, ClaudeSessionReplicationError>;
    readonly manifest: (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      /** Also hash the transcript's first this many bytes. */
      readonly prefixBytes?: number;
    }) => Effect.Effect<ClaudeSessionManifest, ClaudeSessionReplicationError>;
    /** One chunk of a file, checked against the hash the owner sent with it. */
    readonly readChunk: (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    }) => Effect.Effect<Uint8Array, ClaudeSessionReplicationError>;
    readonly claim: (input: {
      readonly environmentId: EnvironmentId;
      readonly claim: ClaudeSessionClaimInput;
    }) => Effect.Effect<ClaudeSessionClaimResult, ClaudeSessionReplicationError>;
  }
>()("t3/peer/PeerClaudeSessions") {}

const fromLinkError = (error: { readonly reason: string; readonly message: string }) =>
  new ClaudeSessionReplicationError({
    reason:
      error.reason === "unknown_link"
        ? "unknown_link"
        : error.reason === "disabled"
          ? "disabled"
          : error.reason === "expired"
            ? "refused"
            : "unreachable",
    message: error.message,
    cause: error,
  });

const fromStatus = (status: number, code: string | undefined, label: string, detail?: string) => {
  if (status === 404 && code === "session_not_found") {
    return new ClaudeSessionReplicationError({
      reason: "not_found",
      message: `That session is no longer on ${label}.`,
    });
  }
  if (status === 404) {
    return new ClaudeSessionReplicationError({
      reason: "unsupported",
      message: `${label} does not share its Claude Code sessions over a link. Update it.`,
    });
  }
  if (status === 401 || status === 403) {
    return new ClaudeSessionReplicationError({
      reason: "refused",
      message:
        code === "full_access_required"
          ? `${label} shares session files only over a full-access link. Link it again with full access.`
          : `${label} refused the request. Its link may have been revoked there; link it again.`,
    });
  }
  if (status === 409) {
    return new ClaudeSessionReplicationError({
      reason: "refused",
      message: detail ?? `${label} kept the session.`,
    });
  }
  return new ClaudeSessionReplicationError({
    reason: "unreachable",
    message: `${label} answered HTTP ${status}.`,
  });
};

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;

  const resolve = Effect.fn("PeerClaudeSessions.resolve")(function* (environmentId: EnvironmentId) {
    if (!(yield* links.enabled)) {
      return yield* new ClaudeSessionReplicationError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const resolved = yield* links.resolve(environmentId).pipe(Effect.mapError(fromLinkError));
    if (resolved.capabilities.claudeSessionReplication !== true) {
      return yield* fromStatus(404, undefined, resolved.link.label);
    }
    return resolved;
  });

  const send = Effect.fn("PeerClaudeSessions.send")(function* (
    environmentId: EnvironmentId,
    request: (url: string) => HttpClientRequest.HttpClientRequest,
  ) {
    const resolved = yield* resolve(environmentId);
    const label = resolved.link.label;
    const response = yield* httpClient
      .execute(
        request(resolved.url).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
        ),
      )
      .pipe(
        Effect.timeout(TRANSFER_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new ClaudeSessionReplicationError({
              reason: "unreachable",
              message: `${label} did not answer.`,
              cause,
            }),
        ),
        Effect.tapError((error) => links.recordOutcome(environmentId, { error: error.message })),
      );
    if (response.status !== 200) {
      const refusal = yield* response.json.pipe(
        Effect.map(decodeRefusal),
        Effect.orElseSucceed(() => Option.none()),
      );
      const body = Option.getOrUndefined(refusal);
      return yield* fromStatus(response.status, body?.error, label, body?.message);
    }
    yield* links.recordOutcome(environmentId, { error: null });
    return { label, response };
  });

  const readJson = <A>(
    environmentId: EnvironmentId,
    request: (url: string) => HttpClientRequest.HttpClientRequest,
    decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    send(environmentId, request).pipe(
      Effect.flatMap(({ label, response }) =>
        response.json.pipe(
          Effect.flatMap(decode),
          Effect.mapError(
            (cause) =>
              new ClaudeSessionReplicationError({
                reason: "unsupported",
                message: `${label} answered in a shape this version cannot read. Update both environments.`,
                cause,
              }),
          ),
        ),
      ),
    );

  const list = Effect.fn("PeerClaudeSessions.list")(function* (environmentId: EnvironmentId) {
    return yield* readJson(
      environmentId,
      (url) => HttpClientRequest.get(`${url}${PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE}`),
      decodeList,
    );
  });

  const manifest = Effect.fn("PeerClaudeSessions.manifest")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly prefixBytes?: number;
  }) {
    const query = new URLSearchParams({
      session: input.sessionId,
      ...(input.prefixBytes === undefined ? {} : { prefix: String(input.prefixBytes) }),
    });
    return yield* readJson(
      input.environmentId,
      (url) => HttpClientRequest.get(`${url}${PEER_LINK_CLAUDE_SESSIONS_MANIFEST_ROUTE}?${query}`),
      decodeManifest,
    );
  });

  const readChunk = Effect.fn("PeerClaudeSessions.readChunk")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  }) {
    const query = new URLSearchParams({
      session: input.sessionId,
      path: input.path,
      offset: String(input.offset),
      length: String(input.length),
    });
    const { label, response } = yield* send(input.environmentId, (url) =>
      HttpClientRequest.get(`${url}${PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE}?${query}`),
    );
    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) =>
            new ClaudeSessionReplicationError({
              reason: "unreachable",
              message: `${label} stopped sending ${input.path}.`,
              cause,
            }),
        ),
      ),
    );
    if (sha256OfBytes(bytes) !== response.headers[CLAUDE_SESSION_CHUNK_SHA256_HEADER]) {
      return yield* new ClaudeSessionReplicationError({
        reason: "verification",
        message: `A chunk of ${input.path} from ${label} did not match the hash sent with it.`,
      });
    }
    return bytes;
  });

  const claim = Effect.fn("PeerClaudeSessions.claim")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly claim: ClaudeSessionClaimInput;
  }) {
    return yield* readJson(
      input.environmentId,
      (url) =>
        HttpClientRequest.post(`${url}${PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE}`).pipe(
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(input.claim), "application/json")),
        ),
      decodeClaim,
    );
  });

  return PeerClaudeSessions.of({ list, manifest, readChunk, claim });
});

export const layer = Layer.effect(PeerClaudeSessions, make);
