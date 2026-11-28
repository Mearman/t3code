import { expect, it } from "vite-plus/test";

import { canMoveClaudeSession } from "./claudeSessionMoveDialogState";

const SESSION = "0b7f6a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const moves = { claudeSessionMove: true };

it.each([
  ["a Claude Code session its server can move", `claude:${SESSION}`, moves, true, true],
  [
    "a session its server cannot move",
    `claude:${SESSION}`,
    { claudeSessionMove: false },
    true,
    false,
  ],
  ["a session whose server config has not loaded", `claude:${SESSION}`, undefined, true, false],
  ["a thread T3 Code started", "thread-1", moves, true, false],
  ["a session this client may not move", `claude:${SESSION}`, moves, false, false],
])("offers the move for %s: %s", (_, threadId, capabilities, permitted, offered) => {
  expect(canMoveClaudeSession(threadId, capabilities, permitted)).toBe(offered);
});
