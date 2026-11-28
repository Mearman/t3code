import { expect, it } from "vite-plus/test";

import { canMoveClaudeSession } from "./claudeSessionMoveDialogState";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

it.each([
  [
    "a Claude Code session on a server that moves them",
    `claude:${SESSION}`,
    { claudeSessionMove: true },
    true,
  ],
  [
    "a Claude Code session on a server that cannot",
    `claude:${SESSION}`,
    { claudeSessionMove: false },
    false,
  ],
  ["a session on a server whose config has not loaded", `claude:${SESSION}`, undefined, false],
  ["a thread T3 Code started", "thread-1", { claudeSessionMove: true }, false],
])("offers the palette's move for %s", (_, threadId, capabilities, offered) => {
  expect(canMoveClaudeSession(threadId, capabilities)).toBe(offered);
});
