import { expect, it } from "vite-plus/test";

import { renameCatalog, renameProductInSource } from "./product-name-transform.ts";

it("renames upstream's name except on marked lines and in T3's GitHub App name", () => {
  const source = [
    'const a = "Open T3 Code now";',
    'const b = "T3 Code"; // product-name: keep',
    'const c = "Install T3 Code for GitHub";',
    "const d = `T3 Code's logs`;",
  ].join("\n");
  expect(renameProductInSource(source, "ExaCode")).toBe(
    [
      'const a = "Open ExaCode now";',
      'const b = "T3 Code"; // product-name: keep',
      'const c = "Install T3 Code for GitHub";',
      "const d = `ExaCode's logs`;",
    ].join("\n"),
  );
});

// A stand-in for GT's hash: a different source gives a different key.
const hashSource = ({ source }: { readonly source: unknown }) => `h:${JSON.stringify(source)}`;

it("moves a translated entry to the key of the renamed source", () => {
  const english = { 'h:"Open T3 Code"': "Open T3 Code", 'h:"Close"': "Close" };
  const translated = { 'h:"Open T3 Code"': "T3-Code öffnen", 'h:"Close"': "Schließen" };
  expect(renameCatalog({ english, translated, name: "ExaCode", hashSource })).toEqual({
    'h:"Open ExaCode"': "ExaCode öffnen",
    'h:"Close"': "Schließen",
  });
});

it("drops an entry whose key the hash cannot reproduce, so it falls back to English", () => {
  const english = { opaque: "Open T3 Code" };
  expect(
    renameCatalog({
      english,
      translated: { opaque: "T3 Code öffnen" },
      name: "ExaCode",
      hashSource,
    }),
  ).toEqual({});
});

it("renames inside structured entries", () => {
  const source = ["Get T3 Code", { t: "code", i: 1, c: "t3 pair" }];
  const english = { [hashSource({ source })]: source };
  const translated = {
    [hashSource({ source })]: ["T3 Code holen", { t: "code", i: 1, c: "t3 pair" }],
  };
  const renamed = ["Get ExaCode", { t: "code", i: 1, c: "t3 pair" }];
  expect(renameCatalog({ english, translated, name: "ExaCode", hashSource })).toEqual({
    [hashSource({ source: renamed })]: ["ExaCode holen", { t: "code", i: 1, c: "t3 pair" }],
  });
});
