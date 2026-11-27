import { isUpstreamReleaseRepository } from "@t3tools/shared/cliRelease";

import { resolveReleaseRepository } from "./release-repository.ts";

/**
 * The bundler `define` that names a build's own product, read from `T3CODE_DESKTOP_PRODUCT_NAME`
 * like the packaging identity. Empty when unset, so the code keeps its upstream default.
 */
export function productNameDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  const label = env.T3CODE_TRIAGE_LABEL?.trim();
  return productName === undefined || productName === ""
    ? {}
    : {
        __T3CODE_DESKTOP_PRODUCT_NAME__: JSON.stringify(productName),
        ...(label === undefined || label === ""
          ? {}
          : { __T3CODE_TRIAGE_LABEL__: JSON.stringify(label) }),
        __T3CODE_BUILD_ISSUES_ENABLED__: JSON.stringify(env.T3CODE_ISSUES_ENABLED === "1"),
      };
}

/**
 * The fork's product name and the repository it releases from, or undefined for a build that
 * keeps upstream's. A product name with no repository, or with upstream's, fails.
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
  if (isUpstreamReleaseRepository(repository)) {
    throw new Error(
      `A build named ${name} cannot release from ${repository}, upstream's own repository: it ` +
        "would show its own name while linking, updating from and reporting to upstream.",
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

/** Whether a build with this environment is provably upstream's (no product name of its own). */
export function provablyUpstream(env: Readonly<Record<string, string | undefined>>): boolean {
  const repository = resolveReleaseRepository(env);
  return (
    forkProductName(env) === undefined &&
    repository !== undefined &&
    isUpstreamReleaseRepository(repository)
  );
}

const isValidEndpointHost = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** The bundler `define` for the build kind, always present so a bundle never has to guess it. */
export function buildKindDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return { __T3CODE_BUILD_PROVABLY_UPSTREAM__: JSON.stringify(provablyUpstream(env)) };
}

/**
 * The bundler `define`s that bake a collector into the server when the build sets both
 * `T3CODE_TELEMETRY_KEY` and `T3CODE_TELEMETRY_HOST` (a host with a scheme), so desktop and WSL
 * servers need no run-time environment to send there. Empty when the build sets no valid pair.
 */
export function telemetryEndpointDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const key = env.T3CODE_TELEMETRY_KEY?.trim() ?? "";
  const host = env.T3CODE_TELEMETRY_HOST?.trim() ?? "";
  return key !== "" && isValidEndpointHost(host)
    ? {
        __T3CODE_BUILD_TELEMETRY_KEY__: JSON.stringify(key),
        __T3CODE_BUILD_TELEMETRY_HOST__: JSON.stringify(host),
      }
    : {};
}
