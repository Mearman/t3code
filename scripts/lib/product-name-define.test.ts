// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  buildKindDefine,
  forkIdentity,
  forkProductName,
  productNameDefine,
  provablyUpstream,
  telemetryEndpointDefine,
} from "./product-name-define.ts";

it("defines the product name as a string literal for the bundle", () => {
  expect(productNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: " MearCode " })).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"MearCode"',
    __T3CODE_BUILD_ISSUES_ENABLED__: "false",
  });
  expect(
    productNameDefine({
      T3CODE_DESKTOP_PRODUCT_NAME: "MearCode",
      T3CODE_TRIAGE_LABEL: "reported-in-app",
      T3CODE_ISSUES_ENABLED: "1",
    }),
  ).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"MearCode"',
    __T3CODE_TRIAGE_LABEL__: '"reported-in-app"',
    __T3CODE_BUILD_ISSUES_ENABLED__: "true",
  });
  expect(forkProductName({ T3CODE_DESKTOP_PRODUCT_NAME: " MearCode " })).toBe("MearCode");
});

it("keeps the upstream name when no product name is configured", () => {
  expect(productNameDefine({})).toEqual({});
  expect(productNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: "  " })).toEqual({});
  expect(forkProductName({})).toBeUndefined();
});

it("gives a fork build its repository, and refuses a name with none", () => {
  expect(
    forkIdentity({ T3CODE_DESKTOP_PRODUCT_NAME: "MearCode", GITHUB_REPOSITORY: "owner/fork" }),
  ).toEqual({ name: "MearCode", repository: "owner/fork" });
  expect(forkIdentity({})).toBeUndefined();
  expect(() => forkIdentity({ T3CODE_DESKTOP_PRODUCT_NAME: "MearCode" })).toThrow(
    "GITHUB_REPOSITORY",
  );
});

it("refuses a product name that releases from upstream's repository", () => {
  expect(() =>
    forkIdentity({
      T3CODE_DESKTOP_PRODUCT_NAME: "MearCode",
      GITHUB_REPOSITORY: "pingdotgg/t3code",
    }),
  ).toThrow("upstream's own repository");
});

it("calls a build upstream's only with upstream's repository and no product name", () => {
  expect(provablyUpstream({ GITHUB_REPOSITORY: "pingdotgg/t3code" })).toBe(true);
  expect(provablyUpstream({ GITHUB_REPOSITORY: "owner/fork" })).toBe(false);
  expect(provablyUpstream({})).toBe(false);
  expect(
    provablyUpstream({ GITHUB_REPOSITORY: "pingdotgg/t3code", T3CODE_DESKTOP_PRODUCT_NAME: "X" }),
  ).toBe(false);
});

it("always defines the build kind", () => {
  expect(buildKindDefine({})).toEqual({ __T3CODE_BUILD_PROVABLY_UPSTREAM__: "false" });
  expect(buildKindDefine({ GITHUB_REPOSITORY: "pingdotgg/t3code" })).toEqual({
    __T3CODE_BUILD_PROVABLY_UPSTREAM__: "true",
  });
});

it("bakes a valid collector in, and none from an empty key or a host without a scheme", () => {
  expect(
    telemetryEndpointDefine({
      T3CODE_TELEMETRY_KEY: " phc_own ",
      T3CODE_TELEMETRY_HOST: "https://ingest.example.com",
    }),
  ).toEqual({
    __T3CODE_BUILD_TELEMETRY_KEY__: '"phc_own"',
    __T3CODE_BUILD_TELEMETRY_HOST__: '"https://ingest.example.com"',
  });
  for (const env of [
    { T3CODE_TELEMETRY_KEY: "", T3CODE_TELEMETRY_HOST: "https://ingest.example.com" },
    { T3CODE_TELEMETRY_KEY: "phc_own", T3CODE_TELEMETRY_HOST: "ingest.example.com" },
    { T3CODE_TELEMETRY_KEY: "phc_own", T3CODE_TELEMETRY_HOST: "" },
    {},
  ]) {
    expect(telemetryEndpointDefine(env)).toEqual({});
  }
});

// The bundler configs are not importable without running a build, so read what they spread.
const configSource = (app: string) =>
  NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, `../../apps/${app}/vite.config.ts`),
    "utf8",
  );

it.each([
  ["server", "...buildKindDefine(repoEnv)"],
  ["server", "...telemetryEndpointDefine(repoEnv)"],
  ["web", "...buildKindDefine(repoEnv)"],
])("spreads the %s bundle's usage-data define %s", (app, spread) => {
  expect(configSource(app)).toContain(spread);
});
