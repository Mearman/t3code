import * as Schema from "effect/Schema";

import { MeshProtocolError } from "./errors.ts";
import { NOISE_MAX_PLAINTEXT_BYTES } from "./noise.ts";

const MeshStreamKind = Schema.Literals(["http", "ws", "relay", "control"]);
export type MeshStreamKind = typeof MeshStreamKind.Type;
const MeshResetCode = Schema.Literals(["cancel", "refused", "internal"]);
export type MeshResetCode = typeof MeshResetCode.Type;

// On the wire a kind or reset code is its index in the literal list, plus one.
const STREAM_KINDS = MeshStreamKind.literals;
const RESET_CODES = MeshResetCode.literals;
const FRAME_TYPES = ["open", "data", "end", "reset", "window"] as const;
const HEADER_BYTES = 5;
const MAX_STREAM_ID = 0xffff_ffff;
/** Every frame is the plaintext of one Noise transport message. */
const MAX_FRAME_BYTES = NOISE_MAX_PLAINTEXT_BYTES;
export const MESH_MAX_DATA_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;
const MESH_MAX_OPEN_HEAD_BYTES = MAX_FRAME_BYTES - HEADER_BYTES - 1;
/** Every stream's credit in each direction when it opens: a protocol constant both sides share. */
export const MESH_STREAM_WINDOW_BYTES = 256 * 1024;
// The largest credit a stream may hold, as in HTTP/2, so a sum of grants cannot overflow.
const MAX_WINDOW_BYTES = 2 ** 31 - 1;
const MESH_DEFAULT_MAX_STREAMS = 128;

export type MeshFrame =
  | {
      readonly type: "open";
      readonly streamId: number;
      readonly kind: MeshStreamKind;
      readonly head: Uint8Array;
    }
  | { readonly type: "data"; readonly streamId: number; readonly data: Uint8Array }
  | { readonly type: "end"; readonly streamId: number }
  | { readonly type: "reset"; readonly streamId: number; readonly code: MeshResetCode }
  | { readonly type: "window"; readonly streamId: number; readonly increment: number };

const malformed = (detail: string) => new MeshProtocolError({ reason: "malformed_frame", detail });

/** Layout: type (u8), stream id (u32 big-endian), then a body that depends on the type. */
export function encodeMeshFrame(frame: MeshFrame): Uint8Array {
  const body =
    frame.type === "open"
      ? frameBody(1 + frame.head.length, (bytes) => {
          bytes[0] = STREAM_KINDS.indexOf(frame.kind) + 1;
          bytes.set(frame.head, 1);
        })
      : frame.type === "data"
        ? frame.data
        : frame.type === "end"
          ? new Uint8Array(0)
          : frame.type === "reset"
            ? Uint8Array.of(RESET_CODES.indexOf(frame.code) + 1)
            : frameBody(4, (bytes) => new DataView(bytes.buffer).setUint32(0, frame.increment));
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = FRAME_TYPES.indexOf(frame.type) + 1;
  new DataView(out.buffer).setUint32(1, frame.streamId);
  out.set(body, HEADER_BYTES);
  return out;
}

function frameBody(length: number, fill: (bytes: Uint8Array) => void) {
  const bytes = new Uint8Array(length);
  fill(bytes);
  return bytes;
}

function decodeMeshFrame(bytes: Uint8Array): MeshFrame {
  if (bytes.length > MAX_FRAME_BYTES) throw malformed("The frame is larger than one message.");
  if (bytes.length < HEADER_BYTES) throw malformed("The frame is shorter than its header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = FRAME_TYPES[view.getUint8(0) - 1];
  const streamId = view.getUint32(1);
  const body = bytes.subarray(HEADER_BYTES);
  if (type === undefined) throw malformed("The frame type is unknown.");
  if (streamId === 0) throw malformed("Stream 0 is reserved.");
  switch (type) {
    case "open": {
      const kind = body.length > 0 ? STREAM_KINDS[view.getUint8(HEADER_BYTES) - 1] : undefined;
      if (kind === undefined) throw malformed("The stream kind is unknown.");
      return { type, streamId, kind, head: body.slice(1) };
    }
    case "data":
      // An empty DATA frame would cost the sender nothing against its credit.
      if (body.length === 0) throw malformed("A DATA frame carries at least one byte.");
      return { type, streamId, data: body.slice() };
    case "end":
      if (body.length !== 0) throw malformed("An END frame has no body.");
      return { type, streamId };
    case "reset": {
      const code = body.length === 1 ? RESET_CODES[view.getUint8(HEADER_BYTES) - 1] : undefined;
      if (code === undefined) throw malformed("A RESET frame carries one known code.");
      return { type, streamId, code };
    }
    case "window": {
      const increment = body.length === 4 ? view.getUint32(HEADER_BYTES) : 0;
      if (increment === 0) throw malformed("A WINDOW frame grants a non-zero 32-bit credit.");
      return { type, streamId, increment };
    }
  }
}

export type MeshMuxEvent =
  | Extract<MeshFrame, { type: "open" | "data" | "end" | "reset" }>
  | { readonly type: "credit"; readonly streamId: number; readonly credit: number };

/**
 * Streams over one channel, buffering nothing: `send` refuses data beyond the stream's credit
 * and the caller waits for a `credit` event. A stream is a byte stream, so DATA boundaries are
 * not message boundaries. Errors from `receive` are channel-fatal; all other calls only refuse.
 */
export interface MeshMux {
  open(kind: MeshStreamKind, head: Uint8Array): number;
  send(streamId: number, data: Uint8Array): void;
  /** Half-closes the local direction; the peer may still send until it ends too. */
  end(streamId: number): void;
  /** Closes both directions at once. A stream that is already closed is left alone. */
  reset(streamId: number, code: MeshResetCode): void;
  /** Reports bytes the application has taken from a stream, which earns the peer new credit. */
  consume(streamId: number, bytes: number): void;
  /** Bytes `send` may still write to the stream; 0 once it is closed or ended locally. */
  credit(streamId: number): number;
  receive(frame: Uint8Array): MeshMuxEvent | undefined;
}

interface Stream {
  readonly local: boolean;
  sendCredit: number;
  receiveCredit: number;
  unconsumed: number;
  ungranted: number;
  localEnded: boolean;
  remoteEnded: boolean;
}

export function createMeshMux(options: {
  /** The side that opened the channel uses odd stream ids, the other side even ones. */
  readonly role: "initiator" | "responder";
  readonly write: (frame: Uint8Array) => void;
  /** Concurrent streams each side may open; more from the peer are refused. */
  readonly maxStreams?: number;
}): MeshMux {
  const maxStreams = options.maxStreams ?? MESH_DEFAULT_MAX_STREAMS;
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1) {
    throw new MeshProtocolError({
      reason: "invalid_input",
      detail: "maxStreams must be a whole number of at least 1.",
    });
  }
  const streams = new Map<number, Stream>();
  const parity = options.role === "initiator" ? 1 : 0;
  let nextLocalId = options.role === "initiator" ? 1 : 2;
  let lastRemoteId = 0;
  let localOpen = 0;
  let remoteOpen = 0;

  const send = (frame: MeshFrame) => options.write(encodeMeshFrame(frame));
  const isLocal = (streamId: number) => streamId % 2 === parity;
  const add = (streamId: number, local: boolean) => {
    streams.set(streamId, {
      local,
      sendCredit: MESH_STREAM_WINDOW_BYTES,
      receiveCredit: MESH_STREAM_WINDOW_BYTES,
      unconsumed: 0,
      ungranted: 0,
      localEnded: false,
      remoteEnded: false,
    });
    if (local) localOpen += 1;
    else remoteOpen += 1;
  };
  const remove = (streamId: number, stream: Stream) => {
    streams.delete(streamId);
    if (stream.local) localOpen -= 1;
    else remoteOpen -= 1;
  };
  const closeIfDone = (streamId: number, stream: Stream) => {
    if (stream.localEnded && stream.remoteEnded) remove(streamId, stream);
  };
  const writable = (streamId: number) => {
    const stream = streams.get(streamId);
    if (stream === undefined || stream.localEnded) {
      throw new MeshProtocolError({
        reason: "stream_closed",
        detail: `Stream ${streamId} is not open for writing.`,
      });
    }
    return stream;
  };
  const opened = (streamId: number) =>
    isLocal(streamId) ? streamId < nextLocalId : streamId <= lastRemoteId;

  return {
    open(kind, head) {
      if (head.length > MESH_MAX_OPEN_HEAD_BYTES) {
        throw new MeshProtocolError({
          reason: "payload_too_large",
          detail: "The stream head exceeds one frame.",
        });
      }
      if (localOpen >= maxStreams) {
        throw new MeshProtocolError({
          reason: "stream_limit",
          detail: "Too many streams are open on this channel.",
        });
      }
      if (nextLocalId > MAX_STREAM_ID) {
        throw new MeshProtocolError({
          reason: "stream_ids_exhausted",
          detail: "This channel has no stream ids left.",
        });
      }
      const streamId = nextLocalId;
      nextLocalId += 2;
      add(streamId, true);
      send({ type: "open", streamId, kind, head });
      return streamId;
    },
    send(streamId, data) {
      const stream = writable(streamId);
      if (data.length > stream.sendCredit) {
        throw new MeshProtocolError({
          reason: "credit_exceeded",
          detail: "The data exceeds the stream's credit.",
        });
      }
      stream.sendCredit -= data.length;
      for (let offset = 0; offset < data.length; offset += MESH_MAX_DATA_BYTES) {
        send({ type: "data", streamId, data: data.subarray(offset, offset + MESH_MAX_DATA_BYTES) });
      }
    },
    end(streamId) {
      const stream = writable(streamId);
      stream.localEnded = true;
      send({ type: "end", streamId });
      closeIfDone(streamId, stream);
    },
    reset(streamId, code) {
      const stream = streams.get(streamId);
      if (stream === undefined) return;
      remove(streamId, stream);
      send({ type: "reset", streamId, code });
    },
    consume(streamId, bytes) {
      const stream = streams.get(streamId);
      if (stream === undefined) return;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > stream.unconsumed) {
        throw new MeshProtocolError({
          reason: "invalid_input",
          detail: "consume() reports more bytes than the stream delivered.",
        });
      }
      stream.unconsumed -= bytes;
      stream.ungranted += bytes;
      // Batch grants so a stream read in small pieces does not send one WINDOW per read.
      if (stream.remoteEnded || stream.ungranted < MESH_STREAM_WINDOW_BYTES / 2) return;
      const increment = stream.ungranted;
      stream.ungranted = 0;
      stream.receiveCredit += increment;
      send({ type: "window", streamId, increment });
    },
    credit(streamId) {
      const stream = streams.get(streamId);
      return stream === undefined || stream.localEnded ? 0 : stream.sendCredit;
    },
    receive(bytes) {
      const frame = decodeMeshFrame(bytes);
      const { streamId } = frame;
      if (frame.type === "open") {
        if (isLocal(streamId) || streamId <= lastRemoteId) {
          throw new MeshProtocolError({
            reason: "stream_state",
            detail: "The peer opened an id it cannot use.",
          });
        }
        lastRemoteId = streamId;
        if (remoteOpen >= maxStreams) {
          send({ type: "reset", streamId, code: "refused" });
          return undefined;
        }
        add(streamId, false);
        return frame;
      }
      const stream = streams.get(streamId);
      if (stream === undefined) {
        // Frames already in flight when a stream closed are dropped; any other is a violation.
        if (opened(streamId)) return undefined;
        throw new MeshProtocolError({
          reason: "stream_state",
          detail: "The frame names a stream never opened.",
        });
      }
      switch (frame.type) {
        case "data":
          if (stream.remoteEnded) {
            throw new MeshProtocolError({
              reason: "stream_state",
              detail: "The peer sent data after END.",
            });
          }
          if (frame.data.length > stream.receiveCredit) {
            throw new MeshProtocolError({
              reason: "flow_control",
              detail: "The peer sent beyond its credit.",
            });
          }
          stream.receiveCredit -= frame.data.length;
          stream.unconsumed += frame.data.length;
          return frame;
        case "end":
          if (stream.remoteEnded) {
            throw new MeshProtocolError({
              reason: "stream_state",
              detail: "The peer ended a stream twice.",
            });
          }
          stream.remoteEnded = true;
          closeIfDone(streamId, stream);
          return frame;
        case "reset":
          remove(streamId, stream);
          return frame;
        case "window":
          if (stream.sendCredit + frame.increment > MAX_WINDOW_BYTES) {
            throw new MeshProtocolError({
              reason: "flow_control",
              detail: "The peer granted more than 2^31-1.",
            });
          }
          stream.sendCredit += frame.increment;
          return { type: "credit", streamId, credit: stream.sendCredit };
      }
    },
  };
}
