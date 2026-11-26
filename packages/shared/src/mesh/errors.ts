export type MeshProtocolErrorReason =
  | "invalid_key"
  | "handshake_order"
  | "message_too_large"
  | "message_too_short"
  | "decrypt_failed"
  | "nonce_exhausted"
  | "channel_failed"
  | "malformed_frame"
  | "stream_state"
  | "flow_control"
  | "stream_limit"
  | "stream_ids_exhausted";

/**
 * A violation of the mesh channel or mux protocol. Every reason is fatal to the channel that raised it except `stream_limit`, which only refuses the stream a local caller tried to open.
 */
export class MeshProtocolError extends Error {
  override readonly name = "MeshProtocolError";
  readonly reason: MeshProtocolErrorReason;

  constructor(reason: MeshProtocolErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
