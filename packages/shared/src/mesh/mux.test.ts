import { describe, expect, it } from "@effect/vitest";

import { failureOf, reasonOf } from "./errors.testkit.ts";
import {
  createMeshMux,
  encodeMeshFrame,
  MESH_MAX_DATA_BYTES,
  MESH_STREAM_WINDOW_BYTES,
  type MeshMux,
} from "./mux.ts";
import { NOISE_MAX_PLAINTEXT_BYTES } from "./noise.ts";

const WINDOW = MESH_STREAM_WINDOW_BYTES;

function pair(options: { readonly maxStreams?: number } = {}) {
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

const openFrame = (streamId: number) =>
  encodeMeshFrame({ type: "open", streamId, kind: "http", head });

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
    expect(failureOf(() => link.responder.send(streamId, Uint8Array.of(4)))).toEqual({
      reason: "stream_closed",
      fatal: false,
    });
  });

  it("reports no credit after a local END while the peer can still send", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.end(streamId);
    expect(link.initiator.credit(streamId)).toBe(0);
    link.toResponderNow();
    link.responder.send(streamId, Uint8Array.of(9));
    expect(link.toInitiatorNow()).toEqual([{ type: "data", streamId, data: Uint8Array.of(9) }]);
  });

  it("refuses local calls on a stream the peer reset without harming the channel", () => {
    const link = pair();
    const reset = link.initiator.open("http", head);
    const other = link.initiator.open("http", head);
    link.toResponderNow();
    link.responder.reset(reset, "cancel");
    expect(link.toInitiatorNow()).toEqual([{ type: "reset", streamId: reset, code: "cancel" }]);
    expect([
      failureOf(() => link.initiator.send(reset, Uint8Array.of(1))),
      failureOf(() => link.initiator.end(reset)),
    ]).toEqual([
      { reason: "stream_closed", fatal: false },
      { reason: "stream_closed", fatal: false },
    ]);
    expect(link.initiator.credit(reset)).toBe(0);
    link.initiator.send(other, Uint8Array.of(2));
    expect(link.toResponderNow()).toEqual([
      { type: "data", streamId: other, data: Uint8Array.of(2) },
    ]);
  });

  it("gives each side its own increasing stream ids and rejects a peer that breaks them", () => {
    const link = pair();
    expect([link.initiator.open("ws", head), link.initiator.open("ws", head)]).toEqual([1, 3]);
    expect([link.responder.open("control", head), link.responder.open("relay", head)]).toEqual([
      2, 4,
    ]);
    link.toResponderNow();
    expect(failureOf(() => link.responder.receive(openFrame(1)))).toEqual({
      reason: "stream_state",
      fatal: true,
    });
    expect(reasonOf(() => link.responder.receive(openFrame(6)))).toBe("stream_state");
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

  it("treats ids the peer skipped as opened and closed", () => {
    const link = pair();
    expect(link.responder.receive(openFrame(5))).toMatchObject({ type: "open", streamId: 5 });
    expect([link.responder.receive(frame(2, 1, 1)), link.responder.receive(frame(3, 3))]).toEqual([
      undefined,
      undefined,
    ]);
    expect(reasonOf(() => link.responder.receive(frame(2, 7, 1)))).toBe("stream_state");
    expect(reasonOf(() => link.responder.receive(openFrame(3)))).toBe("stream_state");
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

  it("refuses a local send beyond credit and keeps the stream usable", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    expect(failureOf(() => link.initiator.send(streamId, new Uint8Array(WINDOW + 1)))).toEqual({
      reason: "credit_exceeded",
      fatal: false,
    });
    expect(link.initiator.credit(streamId)).toBe(WINDOW);
    link.initiator.send(streamId, new Uint8Array(WINDOW));
    expect(link.initiator.credit(streamId)).toBe(0);
  });

  it("counts the peer's credit across several DATA frames", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, new Uint8Array(WINDOW));
    expect(link.toResponder.length).toBeGreaterThan(2);
    link.toResponderNow();
    expect(failureOf(() => link.responder.receive(frame(2, streamId, 1)))).toEqual({
      reason: "flow_control",
      fatal: true,
    });
  });

  it("tracks credit through partial use and a grant", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, new Uint8Array(WINDOW / 2 + 10));
    expect(link.initiator.credit(streamId)).toBe(WINDOW / 2 - 10);
    link.toResponderNow();
    link.responder.consume(streamId, WINDOW / 2 - 1);
    expect(link.toInitiator).toEqual([]);
    link.responder.consume(streamId, 1);
    expect(link.toInitiatorNow()).toEqual([{ type: "credit", streamId, credit: WINDOW - 10 }]);
    expect(link.initiator.credit(streamId)).toBe(WINDOW - 10);
    link.initiator.send(streamId, new Uint8Array(WINDOW - 10));
    link.toResponderNow();
    expect(reasonOf(() => link.responder.receive(frame(2, streamId, 1)))).toBe("flow_control");
  });

  it("grants no credit once the peer has ended its side", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, new Uint8Array(WINDOW));
    link.initiator.end(streamId);
    link.toResponderNow();
    link.responder.consume(streamId, WINDOW);
    expect(link.toInitiator).toEqual([]);
  });

  it("refuses to consume more than the stream delivered", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    link.initiator.send(streamId, Uint8Array.of(1));
    link.toResponderNow();
    expect(
      [2, -1, 0.5].map((bytes) => failureOf(() => link.responder.consume(streamId, bytes))),
    ).toEqual([2, -1, 0.5].map(() => ({ reason: "invalid_input", fatal: false })));
  });

  it("rejects a grant that would take the credit past 2^31 - 1", () => {
    const link = pair();
    const streamId = link.initiator.open("http", head);
    const room = 2 ** 31 - 1 - WINDOW;
    expect(
      link.initiator.receive(encodeMeshFrame({ type: "window", streamId, increment: room })),
    ).toEqual({ type: "credit", streamId, credit: 2 ** 31 - 1 });
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
    expect(failureOf(() => link.initiator.open("http", head))).toEqual({
      reason: "stream_limit",
      fatal: false,
    });
    link.initiator.reset(first, "cancel");
    expect(link.initiator.open("http", head)).toBe(5);
  });

  it("refuses a peer's extra stream and drops its later frames", () => {
    const flood = pair({ maxStreams: 1 });
    expect(flood.responder.receive(openFrame(1))).toMatchObject({ type: "open" });
    expect(flood.responder.receive(openFrame(3))).toBeUndefined();
    expect(flood.toInitiator).toEqual([
      encodeMeshFrame({ type: "reset", streamId: 3, code: "refused" }),
    ]);
    expect([flood.responder.receive(frame(2, 3, 1)), flood.responder.receive(frame(3, 3))]).toEqual(
      [undefined, undefined],
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a stream limit of %s",
    (maxStreams) => {
      expect(
        failureOf(() => createMeshMux({ role: "initiator", write: () => undefined, maxStreams })),
      ).toEqual({ reason: "invalid_input", fatal: false });
    },
  );

  it("refuses a head that does not fit one frame", () => {
    const link = pair();
    expect(
      failureOf(() => link.initiator.open("http", new Uint8Array(NOISE_MAX_PLAINTEXT_BYTES))),
    ).toEqual({ reason: "payload_too_large", fatal: false });
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
    expect(failureOf(() => pair().responder.receive(bytes))).toEqual({
      reason: "malformed_frame",
      fatal: true,
    });
  });
});
