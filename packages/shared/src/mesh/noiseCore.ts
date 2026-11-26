import { x25519 } from "@noble/curves/ed25519";
import { expand, extract } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

import { CipherState } from "./cipherState.ts";
import { MeshProtocolError } from "./errors.ts";

/**
 * The only Noise protocol the mesh speaks (https://noiseprotocol.org/noise.html, revision 34). Its name is exactly HASHLEN bytes, so it is the initial handshake hash without padding.
 */
const NOISE_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export const NOISE_MAX_MESSAGE_BYTES = 65_535;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
export const NOISE_MAX_PLAINTEXT_BYTES = NOISE_MAX_MESSAGE_BYTES - TAG_BYTES;
const EMPTY = new Uint8Array(0);

export interface NoiseKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

const invalidInput = (detail: string) => new MeshProtocolError({ reason: "invalid_input", detail });

export function generateNoiseKeyPair(): NoiseKeyPair {
  return localKeyPair(x25519.utils.randomPrivateKey());
}

function localKeyPair(privateKey: Uint8Array): NoiseKeyPair {
  if (privateKey.length !== KEY_BYTES) throw invalidInput("An X25519 private key is 32 bytes.");
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

function checkLocalPublicKey(publicKey: Uint8Array) {
  if (publicKey.length !== KEY_BYTES) throw invalidInput("An X25519 public key is 32 bytes.");
}

// Only reached with a key the peer sent, so a failure is the peer's.
function dh(privateKey: Uint8Array, remotePublicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(privateKey, remotePublicKey);
  } catch {
    // noble rejects a small-order public key, whose shared secret would be all zeros.
    throw new MeshProtocolError({
      reason: "invalid_key",
      detail: "The peer's X25519 public key is not usable.",
    });
  }
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// The Noise HKDF is RFC 5869 extract-then-expand with an empty info.
function hkdf2(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array) {
  const output = expand(sha256, extract(sha256, inputKeyMaterial, chainingKey), EMPTY, 64);
  return [output.slice(0, 32), output.slice(32)] as const;
}

class SymmetricState {
  readonly cipher = new CipherState(undefined);
  #chainingKey: Uint8Array;
  #hash: Uint8Array;

  constructor(prologue: Uint8Array) {
    this.#hash = new TextEncoder().encode(NOISE_PROTOCOL_NAME);
    this.#chainingKey = this.#hash;
    this.mixHash(prologue);
  }

  get handshakeHash() {
    return this.#hash.slice();
  }

  mixHash(data: Uint8Array) {
    this.#hash = sha256(concat(this.#hash, data));
  }

  mixKey(inputKeyMaterial: Uint8Array) {
    const [chainingKey, key] = hkdf2(this.#chainingKey, inputKeyMaterial);
    this.#chainingKey = chainingKey;
    this.cipher.initializeKey(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    const [initiatorKey, responderKey] = hkdf2(this.#chainingKey, EMPTY);
    return [new CipherState(initiatorKey), new CipherState(responderKey)] as const;
  }
}

/**
 * Both directions of an established channel. Nonces are internal and only advance, so no key and nonce pair is used twice. Any `decrypt` failure fails the channel and later calls throw `channel_failed`; an oversized `encrypt` is refused without harm.
 */
export interface NoiseTransport {
  /** `h` after the handshake: unique to this channel, signed by the initiator hello. */
  readonly handshakeHash: Uint8Array;
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(message: Uint8Array): Uint8Array;
}

function transport(
  send: CipherState,
  receive: CipherState,
  handshakeHash: Uint8Array,
): NoiseTransport {
  let failed = false;
  const live = () => {
    if (failed) {
      throw new MeshProtocolError({
        reason: "channel_failed",
        detail: "The Noise channel has failed.",
      });
    }
  };
  return {
    handshakeHash,
    encrypt(plaintext) {
      live();
      checkPayloadSize(plaintext.length + TAG_BYTES);
      return send.encryptWithAd(EMPTY, plaintext);
    },
    decrypt(message) {
      live();
      try {
        checkMessageSize(message, TAG_BYTES);
        return receive.decryptWithAd(EMPTY, message);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
}

function checkMessageSize(message: Uint8Array, minimum: number) {
  if (message.length > NOISE_MAX_MESSAGE_BYTES) {
    throw new MeshProtocolError({
      reason: "message_too_large",
      detail: "The Noise message exceeds 65535 bytes.",
    });
  }
  if (message.length < minimum) {
    throw new MeshProtocolError({
      reason: "message_too_short",
      detail: "The Noise message is truncated.",
    });
  }
}

function checkPayloadSize(messageBytes: number) {
  if (messageBytes > NOISE_MAX_MESSAGE_BYTES) {
    throw new MeshProtocolError({
      reason: "payload_too_large",
      detail: "The payload does not fit one Noise message.",
    });
  }
}

const outOfOrder = () =>
  new MeshProtocolError({
    reason: "handshake_order",
    detail: "The Noise handshake step is out of order.",
  });

interface CoreOptions {
  readonly prologue: Uint8Array;
  readonly ephemeralPrivateKey: Uint8Array;
}

/**
 * NK with every input explicit, so published vectors can drive it. Production code uses `noise.ts`, which fixes the prologue, draws a fresh ephemeral key and sends no first payload. Writing steps refuse misuse without effect; a reading step that throws spoils the handshake.
 */
export function createNkInitiatorCore(
  options: CoreOptions & { readonly responderStaticPublicKey: Uint8Array },
) {
  const responderStatic = options.responderStaticPublicKey;
  checkLocalPublicKey(responderStatic);
  const e = localKeyPair(options.ephemeralPrivateKey);
  // Derived up front so an unusable pinned key is refused here, before any state changes.
  let es: Uint8Array;
  try {
    es = x25519.getSharedSecret(e.privateKey, responderStatic);
  } catch {
    throw invalidInput("The pinned X25519 public key is not usable.");
  }
  const state = new SymmetricState(options.prologue);
  state.mixHash(responderStatic);
  let step: "first" | "second" | "done" = "first";
  return {
    /** `-> e, es` */
    writeFirst(payload: Uint8Array): Uint8Array {
      if (step !== "first") throw outOfOrder();
      checkPayloadSize(KEY_BYTES + payload.length + TAG_BYTES);
      step = "second";
      state.mixHash(e.publicKey);
      state.mixKey(es);
      return concat(e.publicKey, state.encryptAndHash(payload));
    },
    /** `<- e, ee`: completes the handshake. */
    readSecond(message: Uint8Array) {
      if (step !== "second") throw outOfOrder();
      step = "done";
      checkMessageSize(message, KEY_BYTES + TAG_BYTES);
      const remoteEphemeral = message.slice(0, KEY_BYTES);
      state.mixHash(remoteEphemeral);
      state.mixKey(dh(e.privateKey, remoteEphemeral));
      const payload = state.decryptAndHash(message.slice(KEY_BYTES));
      const [initiatorCipher, responderCipher] = state.split();
      return {
        payload,
        transport: transport(initiatorCipher, responderCipher, state.handshakeHash),
      };
    },
  };
}

/** The responder half of `createNkInitiatorCore`, with the same contract. */
export function createNkResponderCore(
  options: CoreOptions & { readonly staticPrivateKey: Uint8Array },
) {
  const localStatic = localKeyPair(options.staticPrivateKey);
  const e = localKeyPair(options.ephemeralPrivateKey);
  const state = new SymmetricState(options.prologue);
  state.mixHash(localStatic.publicKey);
  let phase:
    | { readonly step: "first" | "done" }
    | { readonly step: "second"; readonly re: Uint8Array } = { step: "first" };
  return {
    /** `-> e, es`: returns the first message's payload. */
    readFirst(message: Uint8Array): Uint8Array {
      if (phase.step !== "first") throw outOfOrder();
      phase = { step: "done" };
      checkMessageSize(message, KEY_BYTES + TAG_BYTES);
      const re = message.slice(0, KEY_BYTES);
      state.mixHash(re);
      state.mixKey(dh(localStatic.privateKey, re));
      const payload = state.decryptAndHash(message.slice(KEY_BYTES));
      phase = { step: "second", re };
      return payload;
    },
    /** `<- e, ee`: completes the handshake. */
    writeSecond(payload: Uint8Array) {
      if (phase.step !== "second") throw outOfOrder();
      checkPayloadSize(KEY_BYTES + payload.length + TAG_BYTES);
      const { re } = phase;
      phase = { step: "done" };
      state.mixHash(e.publicKey);
      state.mixKey(dh(e.privateKey, re));
      const message = concat(e.publicKey, state.encryptAndHash(payload));
      const [initiatorCipher, responderCipher] = state.split();
      return {
        message,
        transport: transport(responderCipher, initiatorCipher, state.handshakeHash),
      };
    },
  };
}
