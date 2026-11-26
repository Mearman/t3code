import * as Schema from "effect/Schema";

// What the peer sent, or a channel already broken: the channel must be closed.
const PEER_VIOLATIONS = [
  "invalid_key",
  "message_too_large",
  "message_too_short",
  "decrypt_failed",
  "unexpected_payload",
  "nonce_exhausted",
  "channel_failed",
  "malformed_frame",
  "stream_state",
  "flow_control",
] as const;

// A local call the channel refused; the channel is exactly as it was before the call.
const LOCAL_REFUSALS = [
  "invalid_input",
  "handshake_order",
  "payload_too_large",
  "stream_closed",
  "credit_exceeded",
  "stream_limit",
  "stream_ids_exhausted",
] as const;

const MeshProtocolErrorReason = Schema.Literals([...PEER_VIOLATIONS, ...LOCAL_REFUSALS]);
type PeerViolation = (typeof PEER_VIOLATIONS)[number];
const isPeerViolation = (reason: string): reason is PeerViolation =>
  PEER_VIOLATIONS.some((violation) => violation === reason);

/**
 * A mesh channel or mux failure. Only reading calls (`readFirst`, `readSecond`, `decrypt`, `receive`) raise a `channelFatal` reason, plus `encrypt` on a channel already failed or out of nonces. Every other throw is a local refusal that leaves the channel usable.
 */
export class MeshProtocolError extends Schema.TaggedError<MeshProtocolError>()(
  "MeshProtocolError",
  {
    reason: MeshProtocolErrorReason,
    detail: Schema.String,
  },
) {
  get channelFatal(): boolean {
    return isPeerViolation(this.reason);
  }

  override get message(): string {
    return `${this.detail} (${this.reason})`;
  }
}
