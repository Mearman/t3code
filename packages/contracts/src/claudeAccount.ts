import * as Schema from "effect/Schema";

/**
 * The account a Claude process reports through `accountInfo()`, reduced to what names it. An
 * account with no email (an API key, a third-party backend) is told apart only by where its
 * credential comes from: `accountInfo()` exposes nothing that tells two keys from one source apart.
 */
export const ClaudeAccountIdentity = Schema.Struct({
  apiProvider: Schema.String,
  email: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  credentialSource: Schema.NullOr(Schema.String),
});
export type ClaudeAccountIdentity = typeof ClaudeAccountIdentity.Type;

/** A send refused because the thread's Claude account changed: the account it was sent as, and now. */
export const ClaudeAccountChange = Schema.Struct({
  recorded: ClaudeAccountIdentity,
  current: ClaudeAccountIdentity,
});
export type ClaudeAccountChange = typeof ClaudeAccountChange.Type;
