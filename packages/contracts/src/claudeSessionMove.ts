import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClaudeSessionFile } from "./claudeSessionReplication.ts";

const MOVE_ROUTE_PREFIX = "/api/links/claude-sessions/move";
/** The target of a move asks the source for what it carries, then for each file of it. */
export const PEER_LINK_CLAUDE_MOVE_ROUTE = MOVE_ROUTE_PREFIX;
export const PEER_LINK_CLAUDE_MOVE_MANIFEST_ROUTE = `${MOVE_ROUTE_PREFIX}/manifest`;
export const PEER_LINK_CLAUDE_MOVE_FILE_ROUTE = `${MOVE_ROUTE_PREFIX}/file`;

/** An untracked file that is a symbolic link travels as its target, not its contents. */
export const ClaudeSessionCodeEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: TrimmedNonEmptyString,
    file: ClaudeSessionFile,
    /** Whether any execute bit is set; git keeps only that of a file's mode. */
    executable: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("symlink"),
    path: TrimmedNonEmptyString,
    target: Schema.String,
  }),
]);
export type ClaudeSessionCodeEntry = typeof ClaudeSessionCodeEntry.Type;

/**
 * The code a session ran in, as the source packed it: commits no remote has (a bundle), staged and
 * unstaged changes (binary patches) and untracked files git does not ignore. Each `file` names a
 * file of the move package, fetched like a session file.
 */
export const ClaudeSessionCodePackage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git"),
    /** `RepositoryIdentity.canonicalKey`, which a checkout on the target must share. */
    canonicalKey: TrimmedNonEmptyString,
    /** Where the target clones the repository when it has no checkout of it. */
    remoteUrl: TrimmedNonEmptyString,
    /** The session's directory below the repository root, `/`-separated; empty at the root. */
    relativeCwd: Schema.String,
    head: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    bundle: Schema.NullOr(ClaudeSessionFile),
    staged: Schema.NullOr(ClaudeSessionFile),
    unstaged: Schema.NullOr(ClaudeSessionFile),
    untracked: Schema.Array(ClaudeSessionCodeEntry),
  }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    /** The session's directory, which the move does not carry since it is outside git. */
    cwd: Schema.NullOr(Schema.String),
  }),
]);
export type ClaudeSessionCodePackage = typeof ClaudeSessionCodePackage.Type;

/** What the source of a move offers its target. `moveId` names the package until it is taken. */
export const ClaudeSessionMoveOffer = Schema.Struct({
  moveId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
});
export type ClaudeSessionMoveOffer = typeof ClaudeSessionMoveOffer.Type;

export const ClaudeSessionMoveInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  targetEnvironmentId: EnvironmentId,
  /**
   * Ends an idle `claude` that has the session open (SIGTERM to its verified pid) instead of
   * refusing; one that is working is never ended.
   */
  takeOver: Schema.Boolean,
});
export type ClaudeSessionMoveInput = typeof ClaudeSessionMoveInput.Type;

/** Where the session and its code are on the target, and how to resume it there. */
export const ClaudeSessionMoveResult = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  sessionId: TrimmedNonEmptyString,
  cwd: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /** A command to run on the target that resumes the session with plain `claude`. */
  resumeCommand: Schema.String,
  /** Bytes of code the target fetched, besides the session's own files. */
  codeBytes: NonNegativeInt,
  warnings: Schema.Array(Schema.String),
});
export type ClaudeSessionMoveResult = typeof ClaudeSessionMoveResult.Type;

/** Why a move stopped, with the reason in words; nothing has moved when it fails. */
export class ClaudeSessionMoveError extends Schema.TaggedError<ClaudeSessionMoveError>()(
  "ClaudeSessionMoveError",
  {
    reason: Schema.Literals([
      "not_owned",
      "held",
      "busy",
      "unsupported",
      "unreachable",
      "refused",
      "no_remote",
      "submodule",
      "lfs",
      "git",
      "storage",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
