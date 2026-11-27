import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  cliChannelPointerUrl,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  cliReleasesPageUrl,
  isUpstreamReleaseRepository,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { msg } from "gt-react-native";
import * as Schema from "effect/Schema";

import { m } from "../../i18n/messages";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));

const releaseCheckFailed = (status: number) =>
  new Error(m(msg("Could not check releases ({status}). Try again.", { status })));

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) throw releaseCheckFailed(response.status);
  return response;
}

async function readChannelReleases(
  channel: ReturnType<typeof cliReleaseChannelOf>,
  repository: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<typeof Release.Type>> {
  const releasesPage = cliReleasesPageUrl(repository);
  if (channel === "stable") {
    const response = await fetchReleases(`${releasesPage}/latest`, "application/json", signal);
    return [decodeRelease(await response.json())];
  }
  if (!isUpstreamReleaseRepository(repository)) {
    // Another repository's feed can list upstream's tags, which have no release there.
    const response = await fetch(cliChannelPointerUrl(channel, repository), {
      signal,
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return [];
    if (!response.ok) throw releaseCheckFailed(response.status);
    return [decodeRelease(await response.json())];
  }
  const response = await fetchReleases(`${releasesPage}.atom`, "application/atom+xml", signal);
  return Array.from(
    (await response.text()).matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g),
    ([, tag_name = ""]) => ({ tag_name }),
  );
}

/** The newest release of `repository` on `currentVersion`'s channel, when newer than it. */
export async function findEnvironmentUpdate(
  currentVersion: string,
  repository: string,
  signal: AbortSignal,
) {
  const channel = cliReleaseChannelOf(currentVersion);
  // Public release pages avoid the anonymous API quota shared by devices on the same network.
  const releases = await readChannelReleases(channel, repository, signal);
  let version = newestCliReleaseVersion(releases, channel);

  // The feed only includes ten releases, so later nightlies can displace a published preview.
  for (let page = 1; version === undefined; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page, repository),
      "application/vnd.github+json",
      signal,
    );
    const releases = decodeReleases(await response.json());
    version = newestCliReleaseVersion(releases, channel);
    if (releases.length < 100) break;
  }

  if (version === undefined)
    throw new Error(m(msg("No {channel} release was found.", { channel })));
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
