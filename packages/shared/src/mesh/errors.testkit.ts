import { MeshProtocolError } from "./errors.ts";

/** The reason a mesh call failed with, the error itself if it was another kind, or "no error". */
export function reasonOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof MeshProtocolError ? error.reason : error;
  }
  return "no error";
}
