import { assert, it } from "@effect/vitest";

import { staleExacodeIcons } from "./export-exacode-icons.ts";

it("keeps every committed ExaCode icon in step with its logo SVG", async () => {
  assert.deepStrictEqual(await staleExacodeIcons(), []);
});
