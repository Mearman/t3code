import { expect, it } from "vite-plus/test";

import { forkIdentity, forkProductName, productNameDefine } from "./product-name-define.ts";

it("defines the product name as a string literal for the bundle", () => {
  expect(productNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: " ExaCode " })).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"ExaCode"',
    __T3CODE_BUILD_ISSUES_ENABLED__: "false",
  });
  expect(
    productNameDefine({
      T3CODE_DESKTOP_PRODUCT_NAME: "ExaCode",
      T3CODE_TRIAGE_LABEL: "reported-in-app",
      T3CODE_ISSUES_ENABLED: "1",
    }),
  ).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"ExaCode"',
    __T3CODE_TRIAGE_LABEL__: '"reported-in-app"',
    __T3CODE_BUILD_ISSUES_ENABLED__: "true",
  });
  expect(forkProductName({ T3CODE_DESKTOP_PRODUCT_NAME: " ExaCode " })).toBe("ExaCode");
});

it("keeps the upstream name when no product name is configured", () => {
  expect(productNameDefine({})).toEqual({});
  expect(productNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: "  " })).toEqual({});
  expect(forkProductName({})).toBeUndefined();
});

it("gives a fork build its repository, and refuses a name with none", () => {
  expect(
    forkIdentity({ T3CODE_DESKTOP_PRODUCT_NAME: "ExaCode", GITHUB_REPOSITORY: "owner/fork" }),
  ).toEqual({ name: "ExaCode", repository: "owner/fork" });
  expect(forkIdentity({})).toBeUndefined();
  expect(() => forkIdentity({ T3CODE_DESKTOP_PRODUCT_NAME: "ExaCode" })).toThrow(
    "GITHUB_REPOSITORY",
  );
});

it("refuses a product name that releases from upstream's repository", () => {
  expect(() =>
    forkIdentity({ T3CODE_DESKTOP_PRODUCT_NAME: "ExaCode", GITHUB_REPOSITORY: "pingdotgg/t3code" }),
  ).toThrow("upstream's own repository");
});
