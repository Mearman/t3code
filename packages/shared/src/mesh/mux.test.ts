import { describe, expect, it } from "@effect/vitest";

import { reasonOf } from "./errors.testkit.ts";
import {
  createMeshMux,
  encodeMeshFrame,
  MESH_INITIAL_WINDOW_BYTES,
  MESH_MAX_DATA_BYTES,
  type MeshMux,
} from "./mux.ts";
import { NOISE_MAX_PLAINTEXT_BYTES } from "./noise.ts";

function pair(
  options: { readonly maxStreams?: number; readonly initialWindowBytes?: number } = {},
) {
  const toResponder: Array<Uint8Array> = [];
  const toInitiator: Array<Uint8Array> = [];
  const initiator = createMeshMux({
    ...options,
    role: "initiator",
    write: (f) => toResponder.push(f),
  });
  const responder = createMeshMux({
    ...options,
    role: "responder",
    write: (f) => toInitiator.push(f),
  });
  const deliver = (queue: Array<Uint8Array>, mux: MeshMux) => queue.splice(0).map(mux.receive);
  return {
    initiator,
    responder,
    toResponder,
    toInitiator,
    toResponderNow: () => deliver(toResponder, responder),
    toInitiatorNow: () => deliver(toInitiator, initiator),
  };
}

const head = new TextEncoder().encode('{"method":"GET","path":"/"}');
const frame = (type: number, streamId: number, ...body: Array<number>) => {
  const bytes = new Uint8Array(5 + body.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, streamId);
  bytes.set(body, 5);
  return bytes;
};

describe("mesh stream mux", () => {
  it("carries a stream both ways and forgets it once both sides end", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, Uint8Array.of(1, 2));
    link.initiator.end(streamId);
    expect(link.toResponderNow()).toEqual([
      { type: "open", streamId, kind: "http", head },
      { type: "data", streamId, data: Uint8Array.of(1, 2) },
      { type: "end", streamId },
    ]);
    link.responder.send(streamId, Uint8Array.of(3));
    link.responder.end(streamId);
    expect(link.toInitiatorNow()).toEqual([
      { type: "data", streamId, data: Uint8Array.of(3) },
      { type: "end", streamId },
    ]);
    expect(link.initiator.credit(streamId)).toBe(0);
    expect(reasonOf(() => link.responder.send(streamId, Uint8Array.of(4)))).toBe("stream_state");
  });

  it("gives each side its own increasing stream ids and rejects a peer that breaks them", () => {
    const link = pair();
    expect([link.initiator.open("ws", head), link.initiator.open("ws", head)]).toEqual([1, 3]);
    expect([link.responder.open("control", head), link.responder.open("relay", head)]).toEqual([
      2, 4,
    ]);
    link.toResponderNow();
    expect(
      reasonOf(() =>
        link.responder.receive(encodeMeshFrame({ type: "open", streamId: 1, kind: "http", head })),
      ),
    ).toBe("stream_state");
    expect(
      reasonOf(() =>
        link.responder.receive(encodeMeshFrame({ type: "open", streamId: 6, kind: "http", head })),
      ),
    ).toBe("stream_state");
  });

  it("refuses frames for a stream never opened and drops late frames for a closed one", () => {
    const link = pair();
    expect(reasonOf(() => link.responder.receive(frame(2, 9, 1)))).toBe("stream_state");
    expect(reasonOf(() => link.initiator.receive(frame(2, 1, 1)))).toBe("stream_state");
    const streamId = link.initiator.open("http", head);
    link.toResponderNow();
    link.responder.reset(streamId, "cancel");
    expect(link.toInitiatorNow()).toEqual([{ type: "reset", streamId, code: "cancel" }]);
    expect(link.responder.receive(frame(2, streamId, 1))).toBeUndefined();
    expect(link.responder.receive(frame(5, streamId, 0, 0, 0, 1))).toBeUndefined();
  });

  it("rejects data or a second END after the peer ended its side", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.end(streamId);
    link.toResponderNow();
    expect(reasonOf(() => link.responder.receive(frame(3, streamId)))).toBe("stream_state");
    const other = pair();
    const second = other.initiator.open("http", head);
    other.initiator.end(second);
    other.toResponderNow();
    expect(reasonOf(() => other.responder.receive(frame(2, second, 1)))).toBe("stream_state");
  });

  it("splits data into frames that each fit one Noise message", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.toResponder.splice(0);
    link.initiator.send(streamId, new Uint8Array(MESH_MAX_DATA_BYTES * 2 + 1));
    expect(link.toResponder.map((f) => f.length)).toEqual([
      NOISE_MAX_PLAINTEXT_BYTES,
      NOISE_MAX_PLAINTEXT_BYTES,
      5 + 1,
    ]);
  });

  it("holds each direction to the credit its receiver granted", () => {
    const window = 8;
    const link = pair({ initialWindowBytes: window });
    const streamId = link.initiator.open("http", head);
    link.toResponderNow();
    expect(reasonOf(() => link.initiator.send(streamId, new Uint8Array(window + 1)))).toBe(
      "flow_control",
    );
    link.initiator.send(streamId, new Uint8Array(window));
    expect(link.initiator.credit(streamId)).toBe(0);
    link.toResponderNow();
    expect(reasonOf(() => link.responder.receive(frame(2, streamId, 1)))).toBe("flow_control");
  });

  it("grants credit back once half the window is consumed", () => {
    const window = 8;
    const link = pair({ initialWindowBytes: window });
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, new Uint8Array(window));
    link.toResponderNow();
    link.responder.consume(streamId, window / 2 - 1);
    expect(link.toInitiator).toEqual([]);
    link.responder.consume(streamId, 1);
    expect(link.toInitiatorNow()).toEqual([{ type: "credit", streamId, credit: window / 2 }]);
    link.initiator.send(streamId, new Uint8Array(window / 2));
    expect(link.toResponderNow()).toHaveLength(1);
    expect(() => link.responder.consume(streamId, window + 1)).toThrow(RangeError);
  });

  it("rejects a grant that would take the credit past 2^31 - 1", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    const room = 2 ** 31 - 1 - MESH_INITIAL_WINDOW_BYTES;
    expect(
      link.initiator.receive(encodeMeshFrame({ type: "window", streamId, increment: room })),
    ).toEqual({
      type: "credit",
      streamId,
      credit: 2 ** 31 - 1,
    });
    expect(
      reasonOf(() =>
        link.initiator.receive(encodeMeshFrame({ type: "window", streamId, increment: 1 })),
      ),
    ).toBe("flow_control");
  });

  it("limits concurrent streams on each side", () => {
    const link = pair({ maxStreams: 2 });
    const first = link.initiator.open("http", head);
    link.initiator.open("http", head);
    expect(reasonOf(() => link.initiator.open("http", head))).toBe("stream_limit");
    link.initiator.reset(first, "cancel");
    link.toResponder.splice(0);
    const third = link.initiator.open("http", head);
    expect(third).toBe(5);

    const flood = pair({ maxStreams: 1 });
    expect(
      flood.responder.receive(encodeMeshFrame({ type: "open", streamId: 1, kind: "http", head })),
    ).toMatchObject({
      type: "open",
    });
    expect(
      flood.responder.receive(encodeMeshFrame({ type: "open", streamId: 3, kind: "http", head })),
    ).toBeUndefined();
    expect(flood.toInitiator).toEqual([
      encodeMeshFrame({ type: "reset", streamId: 3, code: "refused" }),
    ]);
  });

  it("refuses a head that does not fit one frame", () => {
    const link = pair();
    expect(
      reasonOf(() => link.initiator.open("http", new Uint8Array(NOISE_MAX_PLAINTEXT_BYTES))),
    ).toBe("message_too_large");
  });

  it.each([
    ["a frame shorter than its header", Uint8Array.of(1, 0, 0, 1)],
    ["an unknown frame type", frame(6, 2)],
    ["frame type 0", frame(0, 2)],
    ["stream 0", frame(1, 0, 1)],
    ["an OPEN with no kind", frame(1, 2)],
    ["an OPEN with an unknown kind", frame(1, 2, 5)],
    ["an empty DATA frame", frame(2, 2)],
    ["an END with a body", frame(3, 2, 0)],
    ["a RESET with no code", frame(4, 2)],
    ["a RESET with an unknown code", frame(4, 2, 4)],
    ["a RESET with a long body", frame(4, 2, 1, 1)],
    ["a WINDOW of zero", frame(5, 2, 0, 0, 0, 0)],
    ["a WINDOW with a short body", frame(5, 2, 0, 1)],
    ["a frame larger than one Noise message", new Uint8Array(NOISE_MAX_PLAINTEXT_BYTES + 1)],
  ])("rejects %s", (_name, bytes) => {
    expect(reasonOf(() => pair().responder.receive(bytes))).toBe("malformed_frame");
  });
});
