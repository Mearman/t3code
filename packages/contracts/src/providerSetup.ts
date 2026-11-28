import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ClaudeAccountIdentity } from "./claudeAccount.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderSetupInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderSetupInput = typeof ProviderSetupInput.Type;

const SetupOperationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
// Environments supply these and clients open them, so a `javascript:` URL would run as the client.
export const SignInUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(16_384),
  Schema.isPattern(/^https?:\/\//i),
);

export const ProviderAuthMethod = Schema.Struct({
  id: SetupOperationId,
  accountEmail: Schema.optional(TrimmedNonEmptyString),
  canRemove: Schema.optionalKey(Schema.Boolean),
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  type: Schema.Literals(["agent", "terminal", "credentials"]),
});
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

export const ProviderAuthInteraction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browser"),
    id: SetupOperationId,
    url: SignInUrl,
    requiresConsent: Schema.Boolean,
    acceptsCallback: Schema.optionalKey(Schema.Boolean),
    // "code": the field takes the code the provider's page shows, which is not a URL.
    callbackInput: Schema.optionalKey(Schema.Literals(["url", "code"])),
    /** The page that shows that code; clients that read it open it instead of `url`. */
    codeUrl: Schema.optionalKey(SignInUrl),
  }),
  Schema.Struct({
    type: Schema.Literal("deviceCode"),
    id: SetupOperationId,
    url: SignInUrl,
    userCode: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    id: SetupOperationId,
    output: Schema.String.check(Schema.isMaxLength(16_384)),
    outputOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.Struct({
    type: Schema.Literal("credentials"),
    id: SetupOperationId,
    fields: Schema.Array(
      Schema.Struct({
        name: SetupOperationId,
        label: TrimmedNonEmptyString,
        secret: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(16)),
  }),
]);
export type ProviderAuthInteraction = typeof ProviderAuthInteraction.Type;

export const ProviderAuthResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browser"),
    action: Schema.Literals(["accept", "decline"]),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    data: Schema.String.check(Schema.isMaxLength(4_096)),
    // `data` holds one byte per UTF-16 code unit, as in `TerminalWriteInput`.
    binary: Schema.optionalKey(Schema.Boolean),
    size: Schema.optionalKey(
      Schema.Struct({
        cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
        rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("credentials"),
    values: Schema.Record(SetupOperationId, Schema.String.check(Schema.isMaxLength(16_384))).check(
      Schema.isMaxProperties(16),
    ),
  }),
]);
export type ProviderAuthResponse = typeof ProviderAuthResponse.Type;

export const ProviderAuthStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: Schema.optionalKey(SetupOperationId),
  returnUrl: Schema.optionalKey(Schema.String),
  callbackMode: Schema.optionalKey(Schema.Literals(["server", "client"])),
});
export type ProviderAuthStartInput = typeof ProviderAuthStartInput.Type;

export const ProviderAuthRemoveMethodInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: SetupOperationId,
});

export const ProviderAuthRespondInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  interactionId: SetupOperationId,
  response: ProviderAuthResponse,
});
export type ProviderAuthRespondInput = typeof ProviderAuthRespondInput.Type;

export const ProviderAuthState = Schema.Struct({
  instanceId: ProviderInstanceId,
  phase: Schema.Literals([
    "idle",
    "starting",
    "waiting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  flowId: Schema.NullOr(SetupOperationId),
  authorizationUrl: Schema.NullOr(SignInUrl),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(Schema.String),
  // Drop unknown auth methods rather than rejecting the entire state.
  methods: Schema.optionalKey(
    ForwardCompatibleArray(ProviderAuthMethod).check(Schema.isMaxLength(32)),
  ),
  interaction: ForwardCompatibleOptional(Schema.NullOr(ProviderAuthInteraction)),
  credentialOwner: ForwardCompatibleOptional(Schema.Literals(["provider", "t3"])),
});
export type ProviderAuthState = typeof ProviderAuthState.Type;

export const ProviderAuthCompleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderAuthCompleteInput = typeof ProviderAuthCompleteInput.Type;

/** Adds a Claude instance on a config directory the server creates, which signs in on its own. */
export const ClaudeAccountCreateInput = Schema.Struct({
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  // The new home links this instance's projects, sessions, file-history and tasks directories.
  shareHistoryWith: Schema.optionalKey(ProviderInstanceId),
});
export type ClaudeAccountCreateInput = typeof ClaudeAccountCreateInput.Type;
export const ClaudeAccountCreateResult = Schema.Struct({ instanceId: ProviderInstanceId });
export type ClaudeAccountCreateResult = typeof ClaudeAccountCreateResult.Type;

/**
 * Lets a thread send as `account`, the account the refused send showed the user. It applies only
 * while that is still the account the thread's last refusal found.
 */
export const ClaudeThreadAccountConfirmInput = Schema.Struct({
  threadId: ThreadId,
  account: ClaudeAccountIdentity,
});
export const ClaudeThreadAccountConfirmResult = Schema.Struct({
  /**
   * `confirmed`; `stale` when a later refusal found a different account, which the user has not
   * seen; `none` when the thread has no refused account.
   */
  outcome: Schema.Literals(["confirmed", "stale", "none"]),
});

/** The top-level threads, active or archived, a whole-account move takes from one account. */
export const ClaudeThreadMoveListInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ClaudeThreadMoveListInput = typeof ClaudeThreadMoveListInput.Type;
export const ClaudeThreadMoveListResult = Schema.Struct({ threadIds: Schema.Array(ThreadId) });
export type ClaudeThreadMoveListResult = typeof ClaudeThreadMoveListResult.Type;

/**
 * Moves threads to another Claude account; the client has named both accounts to the user. A
 * whole-account move sends one thread at a time, so the client can show each one finish.
 */
export const ClaudeThreadMoveInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  targetInstanceId: ProviderInstanceId,
  /** Compact under the old account first; a failed compaction then moves nothing. */
  compact: Schema.Boolean,
});
export type ClaudeThreadMoveInput = typeof ClaudeThreadMoveInput.Type;

export const ClaudeThreadMoveStatus = Schema.Literals([
  "moved",
  "unchanged",
  "unsupported",
  "busy",
  "held",
  "compactionFailed",
  "missing",
  "copyFailed",
  "failed",
]);
export type ClaudeThreadMoveStatus = typeof ClaudeThreadMoveStatus.Type;

export const ClaudeThreadMoveOutcome = Schema.Struct({
  threadId: ThreadId,
  status: ClaudeThreadMoveStatus,
  /** Why it did not move, for the user. */
  detail: Schema.optionalKey(Schema.String),
  /** Moved by copying to the other account's history, rather than within a shared one. */
  copied: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeThreadMoveOutcome = typeof ClaudeThreadMoveOutcome.Type;
export const ClaudeThreadMoveResult = Schema.Struct({
  outcomes: Schema.Array(ClaudeThreadMoveOutcome),
});
export type ClaudeThreadMoveResult = typeof ClaudeThreadMoveResult.Type;

export const ProviderAuthCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: SetupOperationId,
});
export type ProviderAuthCancelInput = typeof ProviderAuthCancelInput.Type;

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProviderInstallState = Schema.Struct({
  driver: ProviderDriverKind,
  operationId: Schema.NullOr(SetupOperationId),
  phase: Schema.Literals([
    "idle",
    "downloading",
    "extracting",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  executablePath: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  source: Schema.optionalKey(Schema.NullOr(Schema.Literals(["managed", "local"]))),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ProviderInstallState = typeof ProviderInstallState.Type;

export const ProviderInstallCancelInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  operationId: SetupOperationId,
});
export type ProviderInstallCancelInput = typeof ProviderInstallCancelInput.Type;

/** Safe setup failure text. Never include OAuth codes, URLs, or native token data. */
export class ProviderSetupError extends Schema.TaggedError<ProviderSetupError>()(
  "ProviderSetupError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ChatGptReconnectProfile = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^oaiapp_[\w-]+$/u)),
  subject: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}\/auth\/callback$/u),
    ),
  ),
  connectionLabel: Schema.optionalKey(Schema.String),
  sharingEnabled: Schema.optionalKey(Schema.Boolean),
  idTokenHint: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
});
export type ChatGptReconnectProfile = typeof ChatGptReconnectProfile.Type;
export const ChatGptTransferredProfile = Schema.Struct({
  registration: ChatGptReconnectProfile,
  credentials: Schema.Struct({
    clientId: Schema.String,
    accessToken: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)),
    refreshToken: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_384))),
    idToken: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)),
    issuer: Schema.String,
    expiresAt: Schema.Finite,
    earliestRefreshAt: Schema.NullOr(Schema.Finite),
    scopes: Schema.Array(Schema.String),
    subject: Schema.String,
    email: Schema.NullOr(Schema.String),
  }),
});
export type ChatGptTransferredProfile = typeof ChatGptTransferredProfile.Type;
export const ChatGptReconnectProfileInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  methodId: Schema.String,
});
export const ChatGptImportProfileInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  profile: ChatGptTransferredProfile,
});
export const ChatGptHandoffInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  environmentId: EnvironmentId,
  attemptId: Schema.String.check(Schema.isMaxLength(128)),
  returnUrl: Schema.String.check(Schema.isMaxLength(4_096)),
  profile: Schema.NullOr(ChatGptReconnectProfile),
});
export type ChatGptHandoffInput = typeof ChatGptHandoffInput.Type;
export const ChatGptHandoffState = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("auth"), state: ProviderAuthState }),
  Schema.Struct({ phase: Schema.Literal("finished"), profile: ChatGptTransferredProfile }),
]);
export type ChatGptHandoffState = typeof ChatGptHandoffState.Type;
