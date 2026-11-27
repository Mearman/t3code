import { resolveReleaseRepository } from "./release-repository.ts";

/**
 * The bundler `define` that names a build's own product, read from `T3CODE_DESKTOP_PRODUCT_NAME`
 * like the packaging identity. Empty when unset, so the code keeps its upstream default.
 */
export function productNameDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  return productName === undefined || productName === ""
    ? {}
    : { __T3CODE_DESKTOP_PRODUCT_NAME__: JSON.stringify(productName) };
}

/**
 * The fork's product name and the repository it releases from, or undefined for a build that
 * keeps upstream's. A product name with no repository fails: nothing may fall back to T3's.
 */
export function forkIdentity(
  env: Readonly<Record<string, string | undefined>>,
): { readonly name: string; readonly repository: string } | undefined {
  const name = forkProductName(env);
  if (name === undefined) return undefined;
  const repository = resolveReleaseRepository(env);
  if (repository === undefined) {
    throw new Error(
      `A build named ${name} needs T3CODE_DESKTOP_UPDATE_REPOSITORY or GITHUB_REPOSITORY, the ` +
        "repository its links and releases belong to.",
    );
  }
  return { name, repository };
}

/** The fork's product name, or undefined for a build that keeps upstream's. */
export function forkProductName(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  return productName === undefined || productName === "" ? undefined : productName;
}
