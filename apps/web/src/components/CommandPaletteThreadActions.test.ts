import { expect, it } from "vite-plus/test";

import { PALETTE_SKIPPED_THREAD_ACTIONS } from "./CommandPaletteThreadActions";

it("leaves out the thread menu's move, which the palette lists as its own row", () => {
  expect(PALETTE_SKIPPED_THREAD_ACTIONS.has("move-claude-session")).toBe(true);
});
