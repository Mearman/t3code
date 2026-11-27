const REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/**
 * The `owner/name` repository whose GitHub releases a build updates from: the same setting the desktop updater feed reads (`T3CODE_DESKTOP_UPDATE_REPOSITORY`, else the CI's `GITHUB_REPOSITORY`). Undefined when neither is set, so the code keeps its upstream default. Throws on a malformed value.
 */
export function resolveReleaseRepository(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const repository =
    env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() || env.GITHUB_REPOSITORY?.trim() || undefined;
  if (repository === undefined) return undefined;
  const segments = repository.split("/");
  if (
    segments.length !== 2 ||
    !segments.every(
      (segment) => segment !== "." && segment !== ".." && REPOSITORY_SEGMENT.test(segment),
    )
  ) {
    throw new Error(`The release repository must be "owner/name", got "${repository}".`);
  }
  return repository;
}

/** The bundler `define` that points packages/shared/src/cliRelease.ts at the release repository. */
export function releaseRepositoryDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const repository = resolveReleaseRepository(env);
  return repository === undefined
    ? {}
    : { __T3CODE_RELEASE_REPOSITORY__: JSON.stringify(repository) };
}
