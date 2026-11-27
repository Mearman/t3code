import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

const buildEnv = vi.hoisted(() => {
  const current: Record<string, string | undefined> = {};
  return { current };
});

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => buildEnv.current,
}));

afterEach(() => {
  buildEnv.current = {};
});

async function loadConfig(variant: string | undefined, env: Record<string, string> = {}) {
  vi.resetModules();
  buildEnv.current = { APP_VARIANT: variant, ...env };
  return (await import("./app.config.ts")).default;
}

const FORK_ENV = {
  T3CODE_DESKTOP_PRODUCT_NAME: "ExaCode",
  T3CODE_DESKTOP_UPDATE_REPOSITORY: "example/fork",
  T3CODE_ANDROID_PACKAGE: "io.example.fork",
};

it("names a fork build, gives it its own package and icons, and keeps it off upstream's channels", async () => {
  const config = await loadConfig("production", { ...FORK_ENV, T3CODE_ANDROID_VERSION_CODE: "42" });
  expect(config.name).toBe("ExaCode");
  expect(config.android?.package).toBe("io.example.fork");
  expect(config.android?.versionCode).toBe(42);
  expect(config.scheme).toBe("io.example.fork");
  expect(config.android?.adaptiveIcon?.foregroundImage).toBe(
    "../../assets/exacode/exacode-android-foreground.png",
  );
  expect(config.android?.adaptiveIcon?.backgroundColor).toBe("#1B2A5E");
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.updates?.enabled).toBe(false);
  expect(config.extra?.productName).toBe("ExaCode");
  expect(config.extra?.releaseRepository).toBe("example/fork");
});

it("keeps T3 Code's name and update channel when no product name is set", async () => {
  const config = await loadConfig("production", { GITHUB_REPOSITORY: "pingdotgg/t3code" });
  expect(config.name).toBe("T3 Code");
  expect(config.extra?.productName).toBeNull();
  expect(config.android?.versionCode).toBeUndefined();
  expect(config.updates?.enabled).toBe(true);
});

it.each([undefined, "com.t3tools.t3code", "io.example.1fork", "fork"])(
  "rejects a fork build whose Android package is %j",
  async (androidPackage) => {
    const env: Record<string, string> = { ...FORK_ENV };
    if (androidPackage === undefined) delete env.T3CODE_ANDROID_PACKAGE;
    else env.T3CODE_ANDROID_PACKAGE = androidPackage;
    await expect(loadConfig("production", env)).rejects.toThrow("needs T3CODE_ANDROID_PACKAGE");
  },
);

it.each(["0", "1.5", "-3", "2100000001", "abc"])(
  "rejects T3CODE_ANDROID_VERSION_CODE=%j",
  async (versionCode) => {
    await expect(
      loadConfig("production", { T3CODE_ANDROID_VERSION_CODE: versionCode }),
    ).rejects.toThrow("T3CODE_ANDROID_VERSION_CODE must be an integer");
  },
);

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  ["pingdotgg/t3code", true],
  ["owner/fork", false],
  [undefined, false],
])(
  "checks upstream's update channel only for a build provably upstream's (%j)",
  async (repository, checks) => {
    const config = await loadConfig(
      "production",
      repository === undefined ? {} : { GITHUB_REPOSITORY: repository },
    );
    expect(config.updates?.enabled).toBe(checks);
  },
);

it("rejects a product name released from upstream's own repository", async () => {
  await expect(
    loadConfig("production", {
      ...FORK_ENV,
      T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
    }),
  ).rejects.toThrow("cannot release from pingdotgg/t3code");
});
