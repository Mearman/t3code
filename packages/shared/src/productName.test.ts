import { assert, it } from "@effect/vitest";

import { afterEach, vi } from "vite-plus/test";

import {
  brandText,
  IS_FORK_PRODUCT,
  IS_PROVABLY_UPSTREAM_BUILD,
  renameProduct,
  UPSTREAM_PRODUCT_NAME,
} from "./productName.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("renames every spelling of upstream's product", () => {
  assert.equal(
    renameProduct("T3 Code restarts; the T3-Code-Server stays.", "MearCode"),
    "MearCode restarts; the MearCode-Server stays.",
  );
});

it("keeps upstream's text when no product name is defined", () => {
  assert.equal(brandText("Update T3 Code, then reopen it."), "Update T3 Code, then reopen it.");
  assert.isFalse(IS_FORK_PRODUCT);
  assert.equal(UPSTREAM_PRODUCT_NAME, "T3 Code");
});

it("leaves T3's GitHub App name alone", () => {
  assert.equal(
    renameProduct("Install T3 Code for GitHub, then open T3 Code.", "MearCode"),
    "Install T3 Code for GitHub, then open MearCode.",
  );
});

it("is not provably upstream's when the build defined nothing", () => {
  assert.isFalse(IS_PROVABLY_UPSTREAM_BUILD);
});

it("takes the build kind from the define", async () => {
  for (const defined of [true, false]) {
    vi.resetModules();
    vi.stubGlobal("__T3CODE_BUILD_PROVABLY_UPSTREAM__", defined);
    const fresh = await import("./productName.ts");
    assert.equal(fresh.IS_PROVABLY_UPSTREAM_BUILD, defined);
  }
});
