import {
  CLAUDE_SESSION_CHUNK_SHA256_HEADER,
  type ClaudeSessionClaimInput,
  ClaudeSessionClaimResult,
  ClaudeSessionManifest,
  ClaudeRemoteSessionList,
  ClaudeSessionReplicationError,
  type EnvironmentId,
  PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE,
  PEER_LINK_CLAUDE_MOVE_FILE_ROUTE,
  PEER_LINK_CLAUDE_MOVE_MANIFEST_ROUTE,
  PEER_LINK_CLAUDE_MOVE_ROUTE,
  ClaudeSessionCodePackage,
  ClaudeSessionMoveResult,
  type ClaudeSessionMoveOffer,
  PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE,
  PEER_LINK_CLAUDE_SESSIONS_CLAIM_CONFIRM_ROUTE,
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
/** A move's target may clone a repository and fetch its code before it answers. */
const MOVE_TIMEOUT = Duration.minutes(30);

const decodeList = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeRemoteSessionList));
const decodeManifest = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeSessionManifest));
const decodeClaim = Schema.decodeUnknownEffect(ClaudeSessionClaimResult);
const decodeConfirm = Schema.decodeUnknownEffect(Schema.Struct({ confirmed: Schema.Boolean }));
const decodeMoveResult = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeSessionMoveResult));
const decodeCodePackage = Schema.decodeUnknownEffect(Schema.toCodecJson(ClaudeSessionCodePackage));
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
    /** One page of the peer's own sessions; see `ClaudeSessionReplication.listOwned`. */
    readonly list: (
      environmentId: EnvironmentId,
      options?: {
        readonly limit?: number;
        readonly query?: string;
        readonly changedSinceMs?: number;
        readonly cursor?: string;
      },
    ) => Effect.Effect<ClaudeRemoteSessionList, ClaudeSessionReplicationError>;
    /** Asks the peer whether it sent the claim with this session and nonce. */
    readonly confirmClaim: (input: {
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly nonce: string;
    }) => Effect.Effect<boolean, ClaudeSessionReplicationError>;
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
    /** Asks the target of a move to take the session in; it may clone and fetch for a while. */
    readonly offerMove: (input: {
      readonly environmentId: EnvironmentId;
      readonly offer: ClaudeSessionMoveOffer;
    }) => Effect.Effect<ClaudeSessionMoveResult, ClaudeSessionReplicationError>;
    /** The code a move's source packed, as the target reads it back. */
    readonly moveManifest: (input: {
      readonly environmentId: EnvironmentId;
      readonly moveId: string;
    }) => Effect.Effect<ClaudeSessionCodePackage, ClaudeSessionReplicationError>;
    readonly readMoveChunk: (input: {
      readonly environmentId: EnvironmentId;
      readonly moveId: string;
      readonly path: string;
      readonly offset: number;
      readonly length: number;
    }) => Effect.Effect<Uint8Array, ClaudeSessionReplicationError>;
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

export const fromStatus = (
  status: number,
  code: string | undefined,
  label: string,
  detail?: string,
) => {
  if (code === "claude_sessions_off") {
    return new ClaudeSessionReplicationError({
      reason: "refused",
      message: `${label} has Claude Code sessions turned off, so it shares none.`,
    });
  }
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

  const resolve = Effect.fn("PeerClaudeSessions.resolve")(function* (
    environmentId: EnvironmentId,
    capability: "claudeSessionReplication" | "claudeSessionMove" = "claudeSessionReplication",
  ) {
    if (!(yield* links.enabled)) {
      return yield* new ClaudeSessionReplicationError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    const resolved = yield* links.resolve(environmentId).pipe(Effect.mapError(fromLinkError));
    if (resolved.capabilities[capability] !== true) {
      return yield* fromStatus(404, undefined, resolved.link.label);
    }
    return resolved;
  });

  const send = Effect.fn("PeerClaudeSessions.send")(function* (
    environmentId: EnvironmentId,
    request: (url: string) => HttpClientRequest.HttpClientRequest,
    options?: {
      readonly capability: "claudeSessionMove";
      readonly timeout: Duration.Duration;
    },
  ) {
    const resolved = yield* resolve(environmentId, options?.capability);
    const label = resolved.link.label;
    const response = yield* httpClient
      .execute(
        request(resolved.url).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${resolved.token}` }),
        ),
      )
      .pipe(
        Effect.timeout(options?.timeout ?? TRANSFER_TIMEOUT),
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
    options?: Parameters<typeof send>[2],
  ) =>
    send(environmentId, request, options).pipe(
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

  const list = Effect.fn("PeerClaudeSessions.list")(function* (
    environmentId: EnvironmentId,
    options?: {
      readonly limit?: number;
      readonly query?: string;
      readonly changedSinceMs?: number;
      readonly cursor?: string;
    },
  ) {
    const query = new URLSearchParams();
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    if (options?.query !== undefined) query.set("query", options.query);
    if (options?.changedSinceMs !== undefined) {
      query.set("changedSince", String(options.changedSinceMs));
    }
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    return yield* readJson(
      environmentId,
      (url) => HttpClientRequest.get(`${url}${PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE}?${query}`),
      decodeList,
    );
  });

  const confirmClaim = Effect.fn("PeerClaudeSessions.confirmClaim")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly nonce: string;
  }) {
    const query = new URLSearchParams({ session: input.sessionId, nonce: input.nonce });
    const answer = yield* readJson(
      input.environmentId,
      (url) =>
        HttpClientRequest.get(`${url}${PEER_LINK_CLAUDE_SESSIONS_CLAIM_CONFIRM_ROUTE}?${query}`),
      decodeConfirm,
    );
    return answer.confirmed;
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

  const readChunkAt = Effect.fn("PeerClaudeSessions.readChunkAt")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly route: string;
    readonly query: Record<string, string>;
    readonly path: string;
    readonly offset: number;
    readonly length: number;
    readonly capability?: "claudeSessionMove";
  }) {
    const query = new URLSearchParams({
      ...input.query,
      path: input.path,
      offset: String(input.offset),
      length: String(input.length),
    });
    const { label, response } = yield* send(
      input.environmentId,
      (url) => HttpClientRequest.get(`${url}${input.route}?${query}`),
      input.capability === undefined
        ? undefined
        : { capability: input.capability, timeout: TRANSFER_TIMEOUT },
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

  const readChunk = (input: {
    readonly environmentId: EnvironmentId;
    readonly sessionId: string;
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  }) =>
    readChunkAt({
      ...input,
      route: PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE,
      query: { session: input.sessionId },
    });

  const moveOptions = { capability: "claudeSessionMove", timeout: MOVE_TIMEOUT } as const;

  const offerMove = Effect.fn("PeerClaudeSessions.offerMove")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly offer: ClaudeSessionMoveOffer;
  }) {
    return yield* readJson(
      input.environmentId,
      (url) =>
        HttpClientRequest.post(`${url}${PEER_LINK_CLAUDE_MOVE_ROUTE}`).pipe(
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(input.offer), "application/json")),
        ),
      decodeMoveResult,
      moveOptions,
    );
  });

  const moveManifest = Effect.fn("PeerClaudeSessions.moveManifest")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly moveId: string;
  }) {
    return yield* readJson(
      input.environmentId,
      (url) =>
        HttpClientRequest.get(
          `${url}${PEER_LINK_CLAUDE_MOVE_MANIFEST_ROUTE}?${new URLSearchParams({ move: input.moveId })}`,
        ),
      decodeCodePackage,
      { capability: "claudeSessionMove", timeout: TRANSFER_TIMEOUT },
    );
  });

  const readMoveChunk = (input: {
    readonly environmentId: EnvironmentId;
    readonly moveId: string;
    readonly path: string;
    readonly offset: number;
    readonly length: number;
  }) =>
    readChunkAt({
      ...input,
      route: PEER_LINK_CLAUDE_MOVE_FILE_ROUTE,
      query: { move: input.moveId },
      capability: "claudeSessionMove",
    });

  return PeerClaudeSessions.of({
    list,
    confirmClaim,
    manifest,
    readChunk,
    claim,
    offerMove,
    moveManifest,
    readMoveChunk,
  });
});

export const layer = Layer.effect(PeerClaudeSessions, make);
