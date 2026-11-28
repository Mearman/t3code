import { assert, it } from "@effect/vitest";

import { staleMearcodeIcons } from "./export-mearcode-icons.ts";

it("keeps every committed MearCode icon in step with its logo SVG", async () => {
  assert.deepStrictEqual(await staleMearcodeIcons(), []);
});
