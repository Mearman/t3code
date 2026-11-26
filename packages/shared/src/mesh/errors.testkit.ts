import * as Schema from "effect/Schema";

import { MeshProtocolError } from "./errors.ts";

const isMeshProtocolError = Schema.is(MeshProtocolError);

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return "no error";
}

/** The reason a mesh call failed with, the error itself if it was another kind, or "no error". */
export function reasonOf(run: () => unknown) {
  const error = thrownBy(run);
  return isMeshProtocolError(error) ? error.reason : error;
}

/** The reason and whether it is channel-fatal, for asserting a failure's consequence too. */
export function failureOf(run: () => unknown) {
  const error = thrownBy(run);
  return isMeshProtocolError(error) ? { reason: error.reason, fatal: error.channelFatal } : error;
}
