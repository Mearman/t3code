// @effect-diagnostics nodeBuiltinImport:off - A bundler plugin reads source and catalog files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** A line carrying this marker names upstream's product on purpose and is never renamed. */
export const KEEP_UPSTREAM_NAME_MARKER = "product-name: keep";

// T3's own GitHub App keeps its real name wherever it is shown.
const UPSTREAM_NAME = /T3 Code(?! for GitHub)/g; // product-name: keep
const UPSTREAM_NAME_ANY_SEPARATOR = /T3[ -]Code(?! for GitHub)/g; // product-name: keep

/** `code` with upstream's product name replaced by `name`, except on lines marked to keep it. */
export function renameProductInSource(code: string, name: string): string {
  return code
    .split("\n")
    .map((line) =>
      line.includes(KEEP_UPSTREAM_NAME_MARKER) ? line : line.replace(UPSTREAM_NAME, () => name),
    )
    .join("\n");
}

type CatalogValue = string | ReadonlyArray<unknown>;
type Catalog = Readonly<Record<string, CatalogValue>>;
export type HashSource = (input: {
  readonly source: CatalogValue;
  readonly dataFormat: "ICU" | "JSX";
}) => string;

const renameDeep = (value: unknown, name: string): unknown => {
  if (typeof value === "string") return value.replace(UPSTREAM_NAME_ANY_SEPARATOR, () => name);
  if (Array.isArray(value)) return value.map((entry) => renameDeep(entry, name));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renameDeep(entry, name)]),
    );
  }
  return value;
};

const hashed = (hashSource: HashSource, source: CatalogValue) =>
  hashSource({ source, dataFormat: typeof source === "string" ? "ICU" : "JSX" });

/**
 * A locale catalog for a build whose source names the product `name`: each entry whose English
 * source names upstream moves to the key of the renamed source and carries the renamed
 * translation, so translations still resolve. An entry whose key the hash cannot reproduce (it
 * was keyed with extra context) is dropped, so that text falls back to the English source.
 */
export function renameCatalog(input: {
  readonly english: Catalog;
  readonly translated: Catalog;
  readonly name: string;
  readonly hashSource: HashSource;
}): Catalog {
  const result: Record<string, CatalogValue> = {};
  for (const [key, value] of Object.entries(input.translated)) {
    const source = input.english[key];
    const renamedSource = source === undefined ? undefined : renameDeep(source, input.name);
    const renamedValue = renameDeep(value, input.name) as CatalogValue;
    if (source === undefined || JSON.stringify(renamedSource) === JSON.stringify(source)) {
      result[key] = renamedValue;
    } else if (hashed(input.hashSource, source) === key) {
      result[hashed(input.hashSource, renamedSource as CatalogValue)] = renamedValue;
    }
  }
  return result;
}

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const NOT_SHIPPED = /(?:\.test|\.browser\.test|\.fixture|\.testkit|\.d)\.(?:ts|tsx)$/;
const T3_ICON_ASSET = /[\\/]assets[\\/](?:prod|dev|nightly)[\\/][^\\/]+\.(?:png|svg|ico)$/;
const T3_WORDMARK_SOURCE = NodePath.join("apps", "web", "src", "components", "T3Wordmark.tsx");
const CATALOG_DIRECTORY = /[\\/]src[\\/]i18n[\\/]translations$/;

/**
 * A bundler plugin that names a fork build's own product wherever repository source, a locale
 * catalog, the page shell or the web manifest names upstream's. Desktop source is excluded: it
 * resolves the name at run time (`PRODUCT_NAME`, `brandText`).
 */
export function productNameTransformPlugin(options: {
  readonly name: string;
  readonly repositoryRoot: string;
  /** Loads GT's hash; needed only for a build that ships locale catalogs. */
  readonly hashSource?: () => Promise<HashSource>;
}) {
  let hashSource: HashSource | undefined;
  const root = NodePath.resolve(options.repositoryRoot);
  const isRepositorySource = (path: string) =>
    path.startsWith(`${root}${NodePath.sep}`) &&
    !path.includes(`${NodePath.sep}node_modules${NodePath.sep}`) &&
    !path.startsWith(NodePath.join(root, ".repos")) &&
    !path.startsWith(NodePath.join(root, "apps", "desktop"));
  return {
    name: "t3code:product-name",
    enforce: "pre" as const,
    async buildStart() {
      hashSource = await options.hashSource?.();
    },
    // A fork build ships none of T3's icon images or its wordmark, which no fork screen shows.
    load(id: string) {
      const path = NodePath.resolve(id.split("?")[0] ?? id);
      if (!isRepositorySource(path)) return null;
      if (T3_ICON_ASSET.test(path)) return { code: 'export default "";', map: null };
      if (path.endsWith(T3_WORDMARK_SOURCE)) {
        return { code: "export const T3Wordmark = () => null;", map: null };
      }
      return null;
    },
    transform(code: string, id: string) {
      const path = NodePath.resolve(id.split("?")[0] ?? id);
      if (!isRepositorySource(path)) return null;
      if (path.endsWith(".json") && CATALOG_DIRECTORY.test(NodePath.dirname(path))) {
        if (hashSource === undefined) return null;
        const english = JSON.parse(
          NodeFS.readFileSync(NodePath.join(NodePath.dirname(path), "en.json"), "utf8"),
        ) as Catalog;
        const translated = JSON.parse(code) as Catalog;
        return {
          code: JSON.stringify(
            renameCatalog({ english, translated, name: options.name, hashSource }),
          ),
          map: null,
        };
      }
      if (!SOURCE_FILE.test(path) || NOT_SHIPPED.test(path)) return null;
      const renamed = renameProductInSource(code, options.name);
      return renamed === code ? null : { code: renamed, map: null };
    },
    transformIndexHtml(html: string) {
      return renameProductInSource(html, options.name);
    },
    writeBundle(outputOptions: { readonly dir?: string | undefined }) {
      if (outputOptions.dir === undefined) return;
      const manifestPath = NodePath.join(outputOptions.dir, "manifest.webmanifest");
      if (!NodeFS.existsSync(manifestPath)) return;
      NodeFS.writeFileSync(
        manifestPath,
        renameProductInSource(NodeFS.readFileSync(manifestPath, "utf8"), options.name),
      );
    },
  };
}
