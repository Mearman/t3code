import { assert, it } from "@effect/vitest";

import { brandText, IS_FORK_PRODUCT, renameProduct, UPSTREAM_PRODUCT_NAME } from "./productName.ts";

it("renames every spelling of upstream's product", () => {
  assert.equal(
    renameProduct("T3 Code restarts; the T3-Code-Server stays.", "ExaCode"),
    "ExaCode restarts; the ExaCode-Server stays.",
  );
});

it("keeps upstream's text when no product name is defined", () => {
  assert.equal(brandText("Update T3 Code, then reopen it."), "Update T3 Code, then reopen it.");
  assert.isFalse(IS_FORK_PRODUCT);
  assert.equal(UPSTREAM_PRODUCT_NAME, "T3 Code");
});
