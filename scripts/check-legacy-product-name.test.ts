import { expect, it } from "vite-plus/test";

import { APP_ID, APP_ID_FILES, findLegacyNames } from "./check-legacy-product-name.ts";

const legacy = ["Exa", "Code"].join("");
const legacyId = ["io", "exadev", legacy.toLowerCase()].join(".");
const withIds = (extra: Record<string, string | null>) =>
  new Map<string, string | null>([
    ...APP_ID_FILES.map((file) => [file, APP_ID] as const),
    ...Object.entries(extra),
  ]);

it("accepts a tree that names only the current product", () => {
  expect(findLegacyNames(withIds({ "README.md": "# MearCode" }))).toEqual([]);
});

it("reports the legacy name and id in contents and in paths, but not in binary contents", () => {
  const findings = findLegacyNames(
    withIds({
      "a.ts": `const a = "${legacy}";`,
      "b.yml": `app_id: ${legacyId}`,
      [`assets/${legacy.toLowerCase()}/logo.png`]: null,
    }),
  );
  expect(findings.map((f) => [f.file, f.line])).toEqual([
    ["a.ts", 1],
    ["b.yml", 1],
    [`assets/${legacy.toLowerCase()}/logo.png`, null],
  ]);
});

it("allows only the provisioned keystore alias", () => {
  const alias = `--ks-key-alias ${legacy.toLowerCase()} \\`;
  expect(findLegacyNames(withIds({ "c.yml": alias }))).toEqual([]);
  const other = withIds({ "c.yml": `name: ${legacy.toLowerCase()}-build` });
  expect(findLegacyNames(other)).toHaveLength(1);
});

it("fails when a release workflow does not carry the current bundle id", () => {
  const files = new Map<string, string | null>(APP_ID_FILES.map((file) => [file, "app_id: x"]));
  expect(findLegacyNames(files).map((f) => f.file)).toEqual([...APP_ID_FILES]);
});
