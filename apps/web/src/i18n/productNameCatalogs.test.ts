// @effect-diagnostics nodeBuiltinImport:off - Reads the committed locale catalogues from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UPSTREAM_PRODUCT_PATTERN } from "@t3tools/shared/productName";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { loadGtHashSource } from "../../../../scripts/lib/gt-hash.ts";
import { renameCatalog, type HashSource } from "../../../../scripts/lib/product-name-transform.ts";

const DIRECTORY = NodePath.join(import.meta.dirname, "translations");
const LOCALES = NodeFS.readdirSync(DIRECTORY)
  .filter((file) => file.endsWith(".json") && file !== "en.json")
  .map((file) => file.slice(0, -".json".length));
const read = (locale: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(DIRECTORY, `${locale}.json`), "utf8")) as Record<
    string,
    string | ReadonlyArray<unknown>
  >;

let hashSource: HashSource;
beforeAll(async () => {
  hashSource = await loadGtHashSource(import.meta.url);
});

const namesUpstream = (value: unknown) =>
  JSON.stringify(value).replace(UPSTREAM_PRODUCT_PATTERN, "") !== JSON.stringify(value);

describe("renaming the product in the locale catalogues, with GT's own hash", () => {
  it("reproduces the committed key of every English entry", () => {
    const english = read("en");
    const unreproduced = Object.entries(english).filter(
      ([key, source]) =>
        !(["ICU", "JSX"] as const).some((dataFormat) => hashSource({ source, dataFormat }) === key),
    );
    expect(unreproduced.map(([key]) => key)).toEqual([]);
  });

  it.each(LOCALES)(
    "keeps every %s translation, each under the key of its renamed source",
    (locale) => {
      const english = read("en");
      const translated = read(locale);
      const renamed = renameCatalog({ english, translated, name: "ExaCode", hashSource });
      // Nothing is dropped, and no two entries collapse onto one key.
      expect(Object.keys(renamed)).toHaveLength(Object.keys(translated).length);
      for (const [key, source] of Object.entries(english)) {
        if (!namesUpstream(source) || translated[key] === undefined) continue;
        const renamedSource = JSON.parse(
          JSON.stringify(source).replace(UPSTREAM_PRODUCT_PATTERN, "ExaCode"),
        ) as string | ReadonlyArray<unknown>;
        const dataFormat = (["ICU", "JSX"] as const).find(
          (format) => hashSource({ source, dataFormat: format }) === key,
        )!;
        const renamedKey = hashSource({ source: renamedSource, dataFormat });
        expect(
          renamed[renamedKey],
          `${locale}: ${JSON.stringify(source).slice(0, 60)}`,
        ).toBeDefined();
        expect(namesUpstream(renamed[renamedKey])).toBe(false);
      }
    },
  );
});
