import { MeshProtocolError } from "./errors.ts";
import {
  createNkInitiatorCore,
  createNkResponderCore,
  generateNoiseKeyPair,
  type NoiseTransport,
} from "./noiseCore.ts";

export {
  generateNoiseKeyPair,
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_MAX_PLAINTEXT_BYTES,
  type NoiseKeyPair,
  type NoiseTransport,
} from "./noiseCore.ts";

// Bump with any change to the handshake or framing, so mismatched peers fail at the first message.
const MESH_NOISE_PROLOGUE = new TextEncoder().encode("t3code-mesh/v1");
const EMPTY = new Uint8Array(0);

/** The side that knows the responder's static key in advance and sends first. */
export interface NkInitiator {
  /** `-> e, es`: the first handshake message. It carries no payload. */
  writeFirst(): Uint8Array;
  /** `<- e, ee`: reads the reply, completing the handshake. */
  readSecond(message: Uint8Array): {
    readonly payload: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

/**
 * Starts `Noise_NK_25519_ChaChaPoly_SHA256` towards a pinned responder key, with a fresh ephemeral key. Out-of-order calls are refused harmlessly; a failed `readSecond` ends it.
 */
export function createNkInitiator(options: {
  readonly responderStaticPublicKey: Uint8Array;
}): NkInitiator {
  const core = createNkInitiatorCore({
    prologue: MESH_NOISE_PROLOGUE,
    responderStaticPublicKey: options.responderStaticPublicKey,
    ephemeralPrivateKey: generateNoiseKeyPair().privateKey,
  });
  return { writeFirst: () => core.writeFirst(EMPTY), readSecond: core.readSecond };
}

/** The side holding the static key; it learns nothing about who the initiator is. */
export interface NkResponder {
  /** `-> e, es`: reads the first message, which must carry no payload. */
  readFirst(message: Uint8Array): void;
  /** `<- e, ee`: the reply, completing the handshake. */
  writeSecond(payload?: Uint8Array): {
    readonly message: Uint8Array;
    readonly transport: NoiseTransport;
  };
}

/** The responder half of `createNkInitiator`, with the same contract for `readFirst`. */
export function createNkResponder(options: { readonly staticPrivateKey: Uint8Array }): NkResponder {
  const core = createNkResponderCore({
    prologue: MESH_NOISE_PROLOGUE,
    staticPrivateKey: options.staticPrivateKey,
    ephemeralPrivateKey: generateNoiseKeyPair().privateKey,
  });
  let rejected = false;
  return {
    readFirst(message) {
      if (core.readFirst(message).length > 0) {
        rejected = true;
        throw new MeshProtocolError({
          reason: "unexpected_payload",
          detail: "The first NK message carries no payload.",
        });
      }
    },
    writeSecond(payload = EMPTY) {
      if (rejected) {
        throw new MeshProtocolError({
          reason: "handshake_order",
          detail: "The handshake failed at its first message.",
        });
      }
      return core.writeSecond(payload);
    },
  };
}
