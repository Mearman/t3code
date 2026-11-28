import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Where an environment serves the Claude Code sessions it owns to environments linked to it, signed
 * in with the link's own session as on `/mcp`. Listing needs any link; manifests, file bytes and
 * ownership claims need a full-access link, since a session's files hold whatever its conversation
 * did (secrets and file contents included).
 */
const PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX = "/api/links/claude-sessions";
export const PEER_LINK_CLAUDE_SESSIONS_LIST_ROUTE = `${PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX}/list`;
export const PEER_LINK_CLAUDE_SESSIONS_MANIFEST_ROUTE = `${PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX}/manifest`;
export const PEER_LINK_CLAUDE_SESSIONS_FILE_ROUTE = `${PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX}/file`;
export const PEER_LINK_CLAUDE_SESSIONS_CLAIM_ROUTE = `${PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX}/claim`;
/** The owner asks the claimant, over its own link, whether it really sent a claim. */
export const PEER_LINK_CLAUDE_SESSIONS_CLAIM_CONFIRM_ROUTE = `${PEER_LINK_CLAUDE_SESSIONS_ROUTE_PREFIX}/claim-confirm`;
/** The most sessions one listing page holds; a page past it carries `nextCursor`. */
export const CLAUDE_REMOTE_SESSION_PAGE_LIMIT = 200;

/** The most bytes one file request returns; a larger file is fetched in several. */
export const CLAUDE_SESSION_FILE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Response headers of a file request: the chunk's SHA-256 and the file's size when read. */
export const CLAUDE_SESSION_CHUNK_SHA256_HEADER = "t3-chunk-sha256";
export const CLAUDE_SESSION_FILE_SIZE_HEADER = "t3-file-size";

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/**
 * One file of a session, by its path below the Claude home (`/`-separated): the transcript
 * `projects/<slug>/<id>.jsonl`, or a sidecar below `projects/<slug>/<id>/`, `file-history/<id>/` or
 * `tasks/<id>/`. Nothing else in a home (its login, settings or other sessions) is ever named.
 */
export const ClaudeSessionFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  size: NonNegativeInt,
  sha256: Sha256Hex,
});
export type ClaudeSessionFile = typeof ClaudeSessionFile.Type;

/** Where a session ran, as a repository another machine can find by its remote. */
export const ClaudeSessionRepositoryPlace = Schema.Struct({
  /** `RepositoryIdentity.canonicalKey` of the checkout the session ran in. */
  canonicalKey: TrimmedNonEmptyString,
  /** The session's directory below that checkout's root, `/`-separated; empty at the root. */
  relativeCwd: Schema.String,
});
export type ClaudeSessionRepositoryPlace = typeof ClaudeSessionRepositoryPlace.Type;

/** Every file of one session as its owner holds it now. */
export const ClaudeSessionManifest = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  cwd: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(ClaudeSessionRepositoryPlace),
  transcript: ClaudeSessionFile,
  /**
   * The hash of the transcript's first bytes, when the request named a length within it: a copy of
   * that length and hash lacks only later lines, so it is brought up to date from where it ends.
   */
  transcriptPrefix: Schema.NullOr(Schema.Struct({ size: NonNegativeInt, sha256: Sha256Hex })),
  sidecars: Schema.Array(ClaudeSessionFile),
});
export type ClaudeSessionManifest = typeof ClaudeSessionManifest.Type;

/** A session an environment owns, as a linked environment lists it. */
export const ClaudeRemoteSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  /** The thread that shows it there, to open through the link without copying anything. */
  threadId: Schema.NullOr(ThreadId),
  title: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  updatedAt: Schema.DateTimeUtc,
  /** Its thread or that thread's project is pinned there. */
  pinned: Schema.Boolean,
  transcriptBytes: NonNegativeInt,
});
export type ClaudeRemoteSession = typeof ClaudeRemoteSession.Type;

export const ClaudeRemoteSessionList = Schema.Struct({
  sessions: Schema.Array(ClaudeRemoteSession),
  /** Where the next page starts; null on the last page. */
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  /** The owner's clock when it read the list, for asking what changed since. */
  listedAt: Schema.DateTimeUtc,
});
export type ClaudeRemoteSessionList = typeof ClaudeRemoteSessionList.Type;

/**
 * Asks the owner to hand a session to the claimant, whose replica holds exactly the owner's
 * transcript (`size`, `sha256`) plus lines Claude appended there. The owner accepts only while its
 * own copy is still that transcript, so ownership never moves past history it lacks.
 */
export const ClaudeSessionClaimInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  claimantEnvironmentId: EnvironmentId,
  size: NonNegativeInt,
  sha256: Sha256Hex,
  /** Known only to the claimant, which confirms it when the owner asks over its own link. */
  nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
});
export type ClaudeSessionClaimInput = typeof ClaudeSessionClaimInput.Type;

export const ClaudeSessionClaimResult = Schema.Struct({ accepted: Schema.Literal(true) });
export type ClaudeSessionClaimResult = typeof ClaudeSessionClaimResult.Type;

/**
 * `current` matches the owner as of `syncedAt`; `stale` could not be checked because the owner did
 * not answer, so the copy may be behind it.
 */
export const ClaudeSessionReplicaStatus = Schema.Literals(["current", "stale"]);
export type ClaudeSessionReplicaStatus = typeof ClaudeSessionReplicaStatus.Type;

/** A session this environment holds a copy of, owned by a linked environment. */
export const ClaudeSessionReplica = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  /** The title of the copy's thread here, once the sync has shown it. */
  title: Schema.NullOr(Schema.String),
  ownerEnvironmentId: EnvironmentId,
  /** The Claude instance whose home holds the copy. */
  providerInstanceId: ProviderInstanceId,
  /** Where the copy's transcript is, so `claude --resume` finds it from `cwd`. */
  transcriptPath: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  syncedBytes: NonNegativeInt,
  syncedAt: Schema.DateTimeUtc,
  status: ClaudeSessionReplicaStatus,
  /** Sessions made here from lines Claude appended to the copy after the owner moved on. */
  forkedSessionIds: Schema.Array(Schema.String),
  lastError: Schema.NullOr(Schema.String),
});
export type ClaudeSessionReplica = typeof ClaudeSessionReplica.Type;

/** Why a session a rule matched was not copied. */
export const ClaudeReplicationSkipReason = Schema.Literals([
  "disk_reserve",
  /** A `claude` here has the copy open, so it is left alone until that process ends. */
  "held",
  /** This environment has its own session with that id, not a copy of the owner's. */
  "owned_here",
  "failed",
]);
export type ClaudeReplicationSkipReason = typeof ClaudeReplicationSkipReason.Type;

export const ClaudeReplicationSkip = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  bytes: NonNegativeInt,
  reason: ClaudeReplicationSkipReason,
  message: Schema.String,
});
export type ClaudeReplicationSkip = typeof ClaudeReplicationSkip.Type;

/** How the last pass went for one linked environment. */
export const ClaudeReplicationSource = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  outcome: Schema.Literals(["synced", "unreachable", "unsupported", "refused"]),
  message: Schema.NullOr(Schema.String),
});
export type ClaudeReplicationSource = typeof ClaudeReplicationSource.Type;

export const ClaudeReplicationReport = Schema.Struct({
  lastRunAt: Schema.NullOr(Schema.DateTimeUtc),
  sources: Schema.Array(ClaudeReplicationSource),
  replicas: Schema.Array(ClaudeSessionReplica),
  skipped: Schema.Array(ClaudeReplicationSkip),
});
export type ClaudeReplicationReport = typeof ClaudeReplicationReport.Type;

/** A linked environment to list, and text its sessions' titles or folders must contain. */
export const ClaudeRemoteSessionsInput = Schema.Struct({
  environmentId: EnvironmentId,
  query: Schema.optionalKey(Schema.String),
});
export type ClaudeRemoteSessionsInput = typeof ClaudeRemoteSessionsInput.Type;

/** Why listing, copying or claiming a session across a link failed, in words a user can act on. */
export class ClaudeSessionReplicationError extends Schema.TaggedError<ClaudeSessionReplicationError>()(
  "ClaudeSessionReplicationError",
  {
    reason: Schema.Literals([
      "disabled",
      "unknown_link",
      "unreachable",
      "unsupported",
      "refused",
      "not_found",
      "verification",
      "disk_reserve",
      "storage",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
