import { assert, it } from "@effect/vitest";

import { lastPrintedLines, redactSignInSecrets } from "./providerAuthTerminal.ts";

it("keeps a login command's reason but never its sign-in link or a pasted code", () => {
  const code = "test-only-0123456789abcdefghijklmnop#state";
  const output = [
    "Opening browser to sign in…",
    "\u001b[1mBrowser didn't open? Use the url below to sign in:\u001b[0m",
    "https://claude.ai/oauth/authorize?code=true&client_id=test-only&state=s",
    `Paste code here if prompted > ${code}`,
    "OAuth error: Request failed with status code 400",
  ].join("\r\n");
  const printed = lastPrintedLines(output);
  assert.notInclude(printed, "https://");
  assert.notInclude(printed, "client_id");
  assert.notInclude(printed, code);
  assert.include(printed, "OAuth error: Request failed with status code 400");
  assert.strictEqual(redactSignInSecrets("Network unreachable."), "Network unreachable.");
});

it("redacts a sign-in link the terminal wrapped across lines", () => {
  const wrapped = [
    "Browser didn't open? Use the url below to sign in:",
    "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-59",
    "44d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2F",
    "oauth%2Fcode&scope=org%3Aa&state=Ab1",
    "Login failed: token exchange returned 400.",
  ].join("\n");
  const printed = lastPrintedLines(wrapped);
  for (const fragment of ["44d1962f5e", "response_type", "redirect_uri", "scope", "state=Ab1"])
    assert.notInclude(printed, fragment);
  assert.include(printed, "Login failed: token exchange returned 400.");
});
