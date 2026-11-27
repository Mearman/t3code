// @effect-diagnostics nodeBuiltinImport:off - Resolves a transitive package from a given file.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import type { HashSource } from "./product-name-transform.ts";

/**
 * GT's own hash, the one gt-react keys translations by. It is not a direct dependency of any
 * workspace package, so it is resolved through `gt-react`, as seen from `fromFileUrl`.
 */
export async function loadGtHashSource(fromFileUrl: string): Promise<HashSource> {
  const fromApp = NodeModule.createRequire(fromFileUrl);
  const fromGtReact = NodeModule.createRequire(fromApp.resolve("gt-react"));
  const module: { readonly hashSource: HashSource } = await import(
    NodeURL.pathToFileURL(fromGtReact.resolve("generaltranslation/id")).href
  );
  return module.hashSource;
}
