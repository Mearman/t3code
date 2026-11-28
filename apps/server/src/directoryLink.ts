// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A directory link could not be made at `link`. */
export class DirectoryLinkError extends Schema.TaggedError<DirectoryLinkError>()(
  "DirectoryLinkError",
  { link: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not link the folder ${this.link}.`;
  }
}

/** How a directory is linked: a junction on Windows, which needs no elevation or Developer Mode. */
export const directoryLinkType = (platform: NodeJS.Platform) =>
  platform === "win32" ? "junction" : "dir";

/** Links the directory `link` to `target`, an absolute path to an existing directory. */
export const linkDirectory = Effect.fn("directoryLink.link")(function* (
  target: string,
  link: string,
) {
  const type = directoryLinkType(yield* HostProcess.Platform);
  yield* Effect.tryPromise({
    try: () => NodeFSP.symlink(target, link, type),
    catch: (cause) => new DirectoryLinkError({ link, cause }),
  });
});
