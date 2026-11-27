// @effect-diagnostics nodeBuiltinImport:off - Builds a temporary repository tree for the plugin.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  CatalogKeyNotReproducibleError,
  productNameTransformPlugin,
  renameCatalog,
  renameProductInSource,
  type HashSource,
} from "./product-name-transform.ts";

const identity = { name: "ExaCode", repository: "owner/fork" };

it("renames the name and repository except on marked lines and in T3's GitHub App name", () => {
  const source = [
    'const a = "Open T3 Code now";',
    'const b = "T3 Code"; // product-name: keep',
    'const c = "Install T3 Code for GitHub";',
    "const d = `T3-Code's logs at https://github.com/pingdotgg/t3code/issues`;",
    'const e = "See https://t3.codes for more, or https://t3.codes/install.sh";',
  ].join("\n");
  expect(renameProductInSource(source, identity)).toBe(
    [
      'const a = "Open ExaCode now";',
      'const b = "T3 Code"; // product-name: keep',
      'const c = "Install T3 Code for GitHub";',
      "const d = `ExaCode's logs at https://github.com/owner/fork/issues`;",
      'const e = "See https://github.com/owner/fork for more, or https://t3.codes/install.sh";',
    ].join("\n"),
  );
});

// A stand-in for GT's hash that keys a string and a structured entry differently, as GT does.
const hashSource: HashSource = ({ source, dataFormat }) =>
  `${dataFormat}:${JSON.stringify(source)}`;

it("re-keys an entry in the format it was keyed with, plain text or structured", () => {
  const plainJsx = "Welcome to T3 Code";
  const structured = ["Get T3 Code", { t: "code", i: 1, c: "t3 pair" }];
  const english = {
    [hashSource({ source: plainJsx, dataFormat: "JSX" })]: plainJsx,
    [hashSource({ source: structured, dataFormat: "JSX" })]: structured,
    [hashSource({ source: "Close", dataFormat: "ICU" })]: "Close",
    [hashSource({ source: "Open T3 Code", dataFormat: "ICU" })]: "Open T3 Code",
  };
  const translated = Object.fromEntries(
    Object.entries(english).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  const renamed = renameCatalog({ english, translated, name: "ExaCode", hashSource });
  expect(Object.keys(renamed).toSorted()).toEqual(
    [
      hashSource({ source: "Welcome to ExaCode", dataFormat: "JSX" }),
      hashSource({ source: ["Get ExaCode", { t: "code", i: 1, c: "t3 pair" }], dataFormat: "JSX" }),
      hashSource({ source: "Close", dataFormat: "ICU" }),
      hashSource({ source: "Open ExaCode", dataFormat: "ICU" }),
    ].toSorted(),
  );
});

it("fails the build for an entry whose key the hash cannot reproduce", () => {
  expect(() =>
    renameCatalog({
      english: { opaque: "Open T3 Code" },
      translated: { opaque: "T3 Code öffnen" },
      name: "ExaCode",
      hashSource,
    }),
  ).toThrow(CatalogKeyNotReproducibleError);
});

const withTree = (run: (root: string) => void) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "product-name-plugin-"));
  try {
    run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
};
const write = (root: string, file: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, file), text);
  return NodePath.join(root, file);
};

it("stubs T3's icon images and wordmark and leaves other files alone", () => {
  withTree((root) => {
    const plugin = productNameTransformPlugin({ identity, repositoryRoot: root });
    expect(plugin.load(NodePath.join(root, "assets/prod/black-ios-1024.png"))).toEqual({
      code: 'export default "";',
      map: null,
    });
    expect(plugin.load(NodePath.join(root, "assets/nightly/x.ico"))).not.toBeNull();
    expect(plugin.load(NodePath.join(root, "apps/web/src/components/T3Wordmark.tsx"))).toEqual({
      code: "export const T3Wordmark = () => null;",
      map: null,
    });
    expect(plugin.load(NodePath.join(root, "assets/exacode/logo.svg"))).toBeNull();
    expect(plugin.load(NodePath.join(root, "apps/web/src/other.ts"))).toBeNull();
  });
});

it("renames shipped source and skips desktop, dependencies, vendored code and tests", () => {
  withTree((root) => {
    const plugin = productNameTransformPlugin({ identity, repositoryRoot: root });
    const text = 'export const name = "T3 Code";';
    const renamed = (file: string) => plugin.transform(text, NodePath.join(root, file));
    expect(renamed("apps/web/src/a.ts")?.code).toBe('export const name = "ExaCode";');
    expect(renamed("packages/shared/src/b.tsx")?.code).toBe('export const name = "ExaCode";');
    expect(renamed("apps/desktop/src/c.ts")).toBeNull();
    expect(renamed("node_modules/pkg/index.js")).toBeNull();
    expect(renamed(".repos/vendored/index.ts")).toBeNull();
    expect(renamed("apps/web/src/a.test.ts")).toBeNull();
    expect(renamed("apps/web/src/a.browser.test.tsx")).toBeNull();
    expect(renamed("apps/web/src/readme.md")).toBeNull();
    expect(plugin.transform(text, "/elsewhere/apps/web/src/a.ts")).toBeNull();
  });
});

it("renames a locale catalogue through the English one beside it", async () => {
  await withTreeAsync(async (root) => {
    const english = { [hashSource({ source: "Open T3 Code", dataFormat: "ICU" })]: "Open T3 Code" };
    const [key] = Object.keys(english) as [string];
    write(root, "apps/web/src/i18n/translations/en.json", JSON.stringify(english));
    const german = JSON.stringify({ [key]: "T3 Code öffnen" });
    const path = write(root, "apps/web/src/i18n/translations/de.json", german);
    const plugin = productNameTransformPlugin({
      identity,
      repositoryRoot: root,
      hashSource: async () => hashSource,
    });
    await plugin.buildStart();
    const out = plugin.transform(german, path);
    expect(JSON.parse(out?.code ?? "{}")).toEqual({
      [hashSource({ source: "Open ExaCode", dataFormat: "ICU" })]: "ExaCode öffnen",
    });
  });
});

const withTreeAsync = async (run: (root: string) => Promise<void>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "product-name-plugin-"));
  try {
    await run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
};

it("renames the page shell and the written web manifest", () => {
  withTree((root) => {
    const plugin = productNameTransformPlugin({ identity, repositoryRoot: root });
    expect(plugin.transformIndexHtml("<title>T3 Code</title>")).toBe("<title>ExaCode</title>");
    const dir = NodePath.join(root, "dist");
    write(root, "dist/manifest.webmanifest", '{"name":"T3 Code","short_name":"T3 Code"}');
    plugin.writeBundle({ dir });
    expect(NodeFS.readFileSync(NodePath.join(dir, "manifest.webmanifest"), "utf8")).toBe(
      '{"name":"ExaCode","short_name":"ExaCode"}',
    );
    plugin.writeBundle({ dir: NodePath.join(root, "missing") });
    plugin.writeBundle({ dir: undefined });
  });
});
