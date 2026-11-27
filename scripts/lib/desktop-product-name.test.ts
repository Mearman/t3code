import { expect, it } from "vite-plus/test";

import { desktopProductNameDefine } from "./desktop-product-name.ts";

it("defines the product name as a string literal for the bundle", () => {
  expect(desktopProductNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: " ExaCode " })).toEqual({
    __T3CODE_DESKTOP_PRODUCT_NAME__: '"ExaCode"',
  });
});

it("keeps the upstream name when no product name is configured", () => {
  expect(desktopProductNameDefine({})).toEqual({});
  expect(desktopProductNameDefine({ T3CODE_DESKTOP_PRODUCT_NAME: "  " })).toEqual({});
});
