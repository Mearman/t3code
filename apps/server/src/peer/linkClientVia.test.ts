import { assert, it } from "@effect/vitest";

import { linkClientVia } from "./PeerLinks.ts";

it("reads who a link came from whichever product name its build put before the label", () => {
  assert.equal(linkClientVia("T3 Code · Laptop"), "Laptop");
  assert.equal(linkClientVia("ChatGPT"), "ChatGPT");
});
