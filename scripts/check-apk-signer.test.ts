// @effect-diagnostics nodeBuiltinImport:off - Runs the shell script the signing job uses.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

const SCRIPT = NodePath.join(import.meta.dirname, "check-apk-signer.sh");
const PIN = "c142a04ac08eabfcae3b03e28fe4babd37e1b218a7b7b9b648cc346fa7af8300";
const OTHER = "0".repeat(64);

const passes = (output: string, pin = PIN) =>
  NodeChildProcess.spawnSync("bash", [SCRIPT, pin], { input: output }).status === 0;

it("accepts the older Signer #1 format", () => {
  expect(passes(`Signer #1 certificate SHA-256 digest: ${PIN}\n`)).toBe(true);
});

it("accepts the V3.0 Signer format", () => {
  const output = [
    "V3.0 Signer: certificate DN: CN=ExaCode Android, O=ExaDev",
    `V3.0 Signer: certificate SHA-256 digest: ${PIN}`,
    "V3.0 Signer: certificate SHA-1 digest: 697dfd492a4652fbf5a59feaaa2a8dc90cfcafb5",
  ].join("\n");
  expect(passes(output)).toBe(true);
});

it("rejects a different digest", () => {
  expect(passes(`V3.0 Signer: certificate SHA-256 digest: ${OTHER}\n`)).toBe(false);
});

it("rejects a pinned digest alongside a signer with another digest", () => {
  const output = [
    `V3.0 Signer: certificate SHA-256 digest: ${PIN}`,
    `V3.1 Signer: certificate SHA-256 digest: ${OTHER}`,
  ].join("\n");
  expect(passes(output)).toBe(false);
});

it("rejects output with no digest", () => {
  expect(passes("V3.0 Signer: certificate DN: CN=ExaCode Android, O=ExaDev\n")).toBe(false);
  expect(passes("")).toBe(false);
});

it("rejects the pin appearing only as a substring of a longer value", () => {
  expect(passes(`V3.0 Signer: certificate SHA-256 digest: ${PIN}ab\n`)).toBe(false);
  expect(passes(`V3.0 Signer: certificate SHA-256 digest: ab${PIN}\n`)).toBe(false);
});

it("rejects the pin on a line that is not a signer digest line", () => {
  expect(passes(`note: Signer #1 certificate SHA-256 digest: ${PIN}\n`)).toBe(false);
  expect(passes(`Signer #1 certificate SHA-1 digest: ${PIN}\n`)).toBe(false);
});
