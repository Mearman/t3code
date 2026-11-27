import { compareSemverVersions } from "@t3tools/shared/semver";

const NIGHTLY_TAG = /^v(\d+\.\d+\.\d+-nightly\.(\d{8})\.(\d+))$/u;

const publishedNightlies = (publishedTags: ReadonlyArray<string>) =>
  publishedTags.flatMap((tag) => {
    const match = NIGHTLY_TAG.exec(tag);
    return match?.[1] && match[2] && match[3]
      ? [{ version: match[1], date: match[2], build: Number(match[3]) }]
      : [];
  });

/**
 * The build number of a fork nightly cut on `date` from a commit at first-parent `depth` on
 * main. Rewriting main can lower or repeat the depth, so the number also clears every nightly
 * already published for `date`.
 */
export function forkNightlyBuildNumber(
  date: string,
  depth: number,
  publishedTags: ReadonlyArray<string>,
): number {
  const sameDay = publishedNightlies(publishedTags).filter((nightly) => nightly.date === date);
  return Math.max(depth, ...sameDay.map((nightly) => nightly.build + 1));
}

/** A published nightly at or above `version`, which would make releasing `version` go back. */
export function publishedNightlyNotOlderThan(
  version: string,
  publishedTags: ReadonlyArray<string>,
): string | undefined {
  return publishedNightlies(publishedTags).find(
    (nightly) => compareSemverVersions(nightly.version, version) >= 0,
  )?.version;
}
