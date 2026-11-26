import * as Schema from "effect/Schema";

import { MeshProtocolError } from "./errors.ts";

const isMeshProtocolError = Schema.is(MeshProtocolError);

/** The reason a mesh call failed with, the error itself if it was another kind, or "no error". */
export function reasonOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return isMeshProtocolError(error) ? error.reason : error;
  }
  return "no error";
}
