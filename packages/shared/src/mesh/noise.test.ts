import { describe, expect, it } from "@effect/vitest";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import * as Hex from "effect/encoding/Hex";
import * as Result from "effect/Result";

import { CipherState, NOISE_MAX_NONCE } from "./cipherState.ts";
import { reasonOf } from "./errors.testkit.ts";
import {
  createNkInitiator,
  createNkResponder,
  generateNoiseKeyPair,
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_MAX_PLAINTEXT_BYTES,
} from "./noise.ts";

const hex = (text: string) => Result.getOrThrow(Hex.decode(text));

// Copied verbatim from each project's Noise_NK_25519_ChaChaPoly_SHA256 entry, pinned by commit.
const VECTORS = [
  {
    source:
      "https://github.com/haskell-cryptography/cacophony/blob/18b7348c54fd61fcd0c220298883de0d09c8364d/vectors/cacophony.txt",
    prologue: "4a6f686e2047616c74",
    initiatorEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    responderRemoteStatic: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    responderStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    responderEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    handshakeHash: "2efa38a9c7c93ac98f3a097af25c2f58b9e7673787717bc27e98827118c2c1a5",
    messages: [
      [
        "4c756477696720766f6e204d69736573",
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0",
      ],
      [
        "4d757272617920526f746862617264",
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88",
      ],
      ["462e20412e20486179656b", "a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0"],
      ["4361726c204d656e676572", "174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff"],
      [
        "4a65616e2d426170746973746520536179",
        "337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777",
      ],
      [
        "457567656e2042f6686d20766f6e2042617765726b",
        "047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d",
      ],
    ],
  },
  {
    source:
      "https://github.com/mcginty/snow/blob/d00b360cc61a7fe519ce7539974dca4f36c4654a/tests/vectors/snow.txt",
    prologue:
      "5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e",
    initiatorEphemeral: "1b0c2affa2a0ba57c3d96a2b5def1671aa00f66a46d306618a2546a6757f5f65",
    responderRemoteStatic: "a1685fa10096ad890ba2427ef08d85c44ffe7b1990ebb6ed7555f57b248b9319",
    responderStatic: "eb80faf5ebe8437d8edacb3bd95d0718a4eb3e5de6f835bca4d7e161301a563e",
    responderEphemeral: "908f7161432df9036325367c1592ca275fea9a44cdf70d4f3135e16d0034dedc",
    handshakeHash: undefined,
    messages: [
      [
        "6b2da7554f3d4b8a27f371a0b2fb0d1b9c4830ea29e804b05d698f3f302740f4",
        "1c83e1721fadb9fc168e67da9d25503aa286e42d7d35b80c73096d29cce503096ee5516c7bd399fb1f8b0f2affa71e262626c7eb957069a46177f86530217aac9d18bbb78c297d3de7b651995c6783cc",
      ],
      [
        "0216bdac2fb32a7c53d9c4711e3ed995c2e856d19fb1ed465cc88efd4f347e6f",
        "d514c7509ba675f32aaaaef759846609383fb36f6081a3aed84737c800a3127c66ebfa61ba8ee2a58b5074e40e3c0ce02ac02c30f3b6afd9ace9fcc4494485e7e3e545d05f5e9f1336ab5cd9f0d8eb54",
      ],
      [
        "0497dfc21ec4d70f04ffc7094b9467808c043d027c87d410b62e1af3dc791dce",
        "5bd6fb7c4fd75dd4d15b6600c8df4a59509709a97affb19f4e4a72e62dc8459f89361ae710a9fd58545eee4ceb37ec01",
      ],
      [
        "874ba1f2539061f556a212f83c7a96faf33a451aa75099ef8a9b2aeb54c48f36",
        "1f7b7dd2a4992441bc91b6996b0079c3b0747e5aa8dc2443b1fe01331d57644647bbef13cda29f0abc9836739df52fff",
      ],
    ],
  },
] as const;

function handshake(options: { readonly prologue?: Uint8Array } = {}) {
  const responderStatic = generateNoiseKeyPair();
  const initiator = createNkInitiator({
    ...options,
    responderStaticPublicKey: responderStatic.publicKey,
  });
  const responder = createNkResponder({ ...options, staticPrivateKey: responderStatic.privateKey });
  responder.readFirst(initiator.writeFirst());
  const second = responder.writeSecond();
  const first = initiator.readSecond(second.message);
  return { initiator: first.transport, responder: second.transport };
}

const flipBit = (bytes: Uint8Array, index: number) =>
  bytes.map((byte, position) => (position === index ? byte ^ 1 : byte));

describe("Noise_NK_25519_ChaChaPoly_SHA256", () => {
  it.each(VECTORS)("reproduces the published vector from $source", (vector) => {
    const initiator = createNkInitiator({
      prologue: hex(vector.prologue),
      responderStaticPublicKey: hex(vector.responderRemoteStatic),
      ephemeralPrivateKey: hex(vector.initiatorEphemeral),
    });
    const responder = createNkResponder({
      prologue: hex(vector.prologue),
      staticPrivateKey: hex(vector.responderStatic),
      ephemeralPrivateKey: hex(vector.responderEphemeral),
    });
    const [[payload0, message0], [payload1, message1], ...transportMessages] = vector.messages;

    const first = initiator.writeFirst(hex(payload0));
    expect(Hex.encode(first)).toBe(message0);
    expect(Hex.encode(responder.readFirst(first))).toBe(payload0);
    const second = responder.writeSecond(hex(payload1));
    expect(Hex.encode(second.message)).toBe(message1);
    const done = initiator.readSecond(second.message);
    expect(Hex.encode(done.payload)).toBe(payload1);
    expect(Hex.encode(done.transport.handshakeHash)).toBe(
      Hex.encode(second.transport.handshakeHash),
    );
    if (vector.handshakeHash !== undefined) {
      expect(Hex.encode(done.transport.handshakeHash)).toBe(vector.handshakeHash);
    }

    // After the handshake the vectors alternate, starting with the initiator.
    const transcript = transportMessages.map(([payload], index) => {
      const [sender, receiver] =
        index % 2 === 0 ? [done.transport, second.transport] : [second.transport, done.transport];
      const ciphertext = sender.encrypt(hex(payload));
      return [Hex.encode(receiver.decrypt(ciphertext)), Hex.encode(ciphertext)];
    });
    expect(transcript).toEqual(transportMessages);
  });

  it("fails the handshake when the initiator pinned a different responder key", () => {
    const responderStatic = generateNoiseKeyPair();
    const initiator = createNkInitiator({
      responderStaticPublicKey: generateNoiseKeyPair().publicKey,
    });
    const responder = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    expect(reasonOf(() => responder.readFirst(initiator.writeFirst()))).toBe("decrypt_failed");
  });

  it("fails the handshake when the prologues differ", () => {
    const responderStatic = generateNoiseKeyPair();
    const initiator = createNkInitiator({
      prologue: Uint8Array.of(1),
      responderStaticPublicKey: responderStatic.publicKey,
    });
    const responder = createNkResponder({
      prologue: Uint8Array.of(2),
      staticPrivateKey: responderStatic.privateKey,
    });
    expect(reasonOf(() => responder.readFirst(initiator.writeFirst()))).toBe("decrypt_failed");
  });

  it.each([
    ["ephemeral key", 0],
    ["payload tag", 40],
  ])("rejects a first message with a tampered %s", (_part, index) => {
    const responderStatic = generateNoiseKeyPair();
    const initiator = createNkInitiator({ responderStaticPublicKey: responderStatic.publicKey });
    const responder = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    const tampered = flipBit(initiator.writeFirst(Uint8Array.of(1, 2, 3)), index);
    expect(reasonOf(() => responder.readFirst(tampered))).toBe("decrypt_failed");
    expect(reasonOf(() => responder.writeSecond())).toBe("handshake_order");
  });

  it.each([
    ["ephemeral key", 0],
    ["tag", 47],
  ])("rejects a second message with a tampered %s", (_part, index) => {
    const responderStatic = generateNoiseKeyPair();
    const initiator = createNkInitiator({ responderStaticPublicKey: responderStatic.publicKey });
    const responder = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    responder.readFirst(initiator.writeFirst());
    const tampered = flipBit(responder.writeSecond().message, index);
    expect(reasonOf(() => initiator.readSecond(tampered))).toBe("decrypt_failed");
  });

  it("rejects a small-order ephemeral key instead of deriving an all-zero secret", () => {
    const responderStatic = generateNoiseKeyPair();
    const responder = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    expect(reasonOf(() => responder.readFirst(new Uint8Array(48)))).toBe("invalid_key");
  });

  it("runs each handshake step once and in order", () => {
    const responderStatic = generateNoiseKeyPair();
    const initiator = createNkInitiator({ responderStaticPublicKey: responderStatic.publicKey });
    const responder = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    expect(reasonOf(() => initiator.readSecond(new Uint8Array(48)))).toBe("handshake_order");
    expect(reasonOf(() => responder.writeSecond())).toBe("handshake_order");
    const first = initiator.writeFirst();
    expect(reasonOf(() => initiator.writeFirst())).toBe("handshake_order");
    responder.readFirst(first);
    expect(reasonOf(() => responder.readFirst(first))).toBe("handshake_order");
  });

  it("fails the channel on a tampered transport message", () => {
    const { initiator, responder } = handshake();
    const genuine = initiator.encrypt(Uint8Array.of(1));
    expect(reasonOf(() => responder.decrypt(flipBit(genuine, 0)))).toBe("decrypt_failed");
    expect(reasonOf(() => responder.decrypt(genuine))).toBe("channel_failed");
    expect(reasonOf(() => responder.encrypt(Uint8Array.of(1)))).toBe("channel_failed");
  });

  it("never reuses a nonce: repeats differ, and replays and reorders fail", () => {
    const replay = handshake();
    const first = replay.initiator.encrypt(Uint8Array.of(7));
    const repeat = replay.initiator.encrypt(Uint8Array.of(7));
    expect(Hex.encode(repeat)).not.toBe(Hex.encode(first));
    replay.responder.decrypt(first);
    expect(reasonOf(() => replay.responder.decrypt(first))).toBe("decrypt_failed");

    const reorder = handshake();
    reorder.initiator.encrypt(Uint8Array.of(1));
    const later = reorder.initiator.encrypt(Uint8Array.of(2));
    expect(reasonOf(() => reorder.responder.decrypt(later))).toBe("decrypt_failed");

    const reflect = handshake();
    const own = reflect.initiator.encrypt(Uint8Array.of(3));
    expect(reasonOf(() => reflect.initiator.decrypt(own))).toBe("decrypt_failed");
  });

  it("holds every message to 65535 bytes", () => {
    const { initiator, responder } = handshake();
    const largest = initiator.encrypt(new Uint8Array(NOISE_MAX_PLAINTEXT_BYTES));
    expect(largest.length).toBe(NOISE_MAX_MESSAGE_BYTES);
    expect(responder.decrypt(largest).length).toBe(NOISE_MAX_PLAINTEXT_BYTES);
    expect(reasonOf(() => initiator.encrypt(new Uint8Array(NOISE_MAX_PLAINTEXT_BYTES + 1)))).toBe(
      "message_too_large",
    );
    expect(reasonOf(() => responder.decrypt(new Uint8Array(NOISE_MAX_MESSAGE_BYTES + 1)))).toBe(
      "message_too_large",
    );
    expect(reasonOf(() => handshake().responder.decrypt(new Uint8Array(15)))).toBe(
      "message_too_short",
    );

    const responderStatic = generateNoiseKeyPair();
    const tooLarge = new Uint8Array(NOISE_MAX_MESSAGE_BYTES - 32 - 16 + 1);
    const initiatorHandshake = createNkInitiator({
      responderStaticPublicKey: responderStatic.publicKey,
    });
    expect(reasonOf(() => initiatorHandshake.writeFirst(tooLarge))).toBe("message_too_large");
    const responderHandshake = createNkResponder({ staticPrivateKey: responderStatic.privateKey });
    expect(reasonOf(() => responderHandshake.readFirst(new Uint8Array(65_536)))).toBe(
      "message_too_large",
    );
  });

  it("stops before the reserved nonce 2^64 - 1", () => {
    const key = new Uint8Array(32).fill(9);
    const sender = new CipherState(key, NOISE_MAX_NONCE - 1n);
    const receiver = new CipherState(key, NOISE_MAX_NONCE - 1n);
    const last = sender.encryptWithAd(new Uint8Array(0), Uint8Array.of(1));
    expect(receiver.decryptWithAd(new Uint8Array(0), last)).toEqual(Uint8Array.of(1));
    expect(reasonOf(() => sender.encryptWithAd(new Uint8Array(0), Uint8Array.of(1)))).toBe(
      "nonce_exhausted",
    );
    expect(reasonOf(() => receiver.decryptWithAd(new Uint8Array(0), last))).toBe("nonce_exhausted");
  });

  it("encodes the nonce as 32 zero bits, then the counter as 64-bit little-endian", () => {
    const key = new Uint8Array(32).fill(5);
    const ad = Uint8Array.of(6);
    const plaintext = Uint8Array.of(4);
    const nonce = Uint8Array.of(0, 0, 0, 0, 1, 2, 0, 0, 3, 0, 0, 0);
    const expected = chacha20poly1305(key, nonce, ad).encrypt(plaintext);
    const state = new CipherState(key, 3n * 2n ** 32n + 0x0201n);
    expect(Hex.encode(state.encryptWithAd(ad, plaintext))).toBe(Hex.encode(expected));
  });
});
