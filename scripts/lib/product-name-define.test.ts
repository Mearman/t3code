import { expect, it } from "vite-plus/test";

import { forkIdentity, forkProductName, productNameDefine } from "./product-name-define.ts";

it("defines the product name as a string literal for the bundle", () => {
  expect(productNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: " ExaCode " })).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"ExaCode"',
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
