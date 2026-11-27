// @effect-diagnostics nodeBuiltinImport:off - A bundler plugin reads source and catalog files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { renameProduct, UPSTREAM_PRODUCT_PATTERN } from "@t3tools/shared/productName";

/** A line carrying this marker names upstream on purpose and is never renamed. */
export const KEEP_UPSTREAM_NAME_MARKER = "product-name: keep";

/** The repository upstream's links and agent instructions name; a fork build names its own. */
export const UPSTREAM_REPOSITORY = "pingdotgg/t3code"; // product-name: keep
const UPSTREAM_REPOSITORY_PATTERN = /pingdotgg\/t3code/g; // product-name: keep
// The bare site address, as in prose or a home link; its paths (installer, schema) are kept.
const UPSTREAM_SITE_PATTERN = /https:\/\/t3\.codes(?![\w/.-])/g; // product-name: keep

export interface ProductIdentity {
  readonly name: string;
  /** The `owner/name` repository whose releases and tracker the build belongs to. */
  readonly repository: string;
}

/** `code` with upstream's name and repository replaced, except on lines marked to keep them. */
export function renameProductInSource(code: string, identity: ProductIdentity): string {
  return code
    .split("\n")
    .map((line) =>
      line.includes(KEEP_UPSTREAM_NAME_MARKER)
        ? line
        : line
            .replace(UPSTREAM_PRODUCT_PATTERN, () => identity.name)
            .replace(UPSTREAM_REPOSITORY_PATTERN, () => identity.repository)
            .replace(UPSTREAM_SITE_PATTERN, () => `https://github.com/${identity.repository}`),
    )
    .join("\n");
}

type CatalogValue = string | ReadonlyArray<unknown>;
type Catalog = Readonly<Record<string, CatalogValue>>;
type DataFormat = "ICU" | "JSX";
export type HashSource = (input: {
  readonly source: CatalogValue;
  readonly dataFormat: DataFormat;
}) => string;

export class CatalogKeyNotReproducibleError extends Schema.TaggedError<CatalogKeyNotReproducibleError>()(
  "CatalogKeyNotReproducibleError",
  { keys: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return (
      "GT's hash does not reproduce these catalogue keys from their English source, so a " +
      `renamed translation cannot be re-keyed: ${this.keys.slice(0, 5).join(", ")}`
    );
  }
}

const renameDeep = (value: unknown, name: string): unknown => {
  if (typeof value === "string") return renameProduct(value, name);
  if (Array.isArray(value)) return value.map((entry) => renameDeep(entry, name));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renameDeep(entry, name)]),
    );
  }
  return value;
};

// GT keys a string by the format it was extracted with: a `<T>` of plain text is stored as a
// string but keyed as JSX, so the format cannot be read off the value's type.
const formatOf = (hashSource: HashSource, source: CatalogValue, key: string) =>
  (["ICU", "JSX"] as const).find((dataFormat) => hashSource({ source, dataFormat }) === key);

/**
 * A locale catalog for a build whose source names the product `name`: each entry whose English
 * source names upstream moves to the key of the renamed source, in the format the entry was
 * keyed with, and carries the renamed translation, so translations still resolve. An entry whose
 * key the hash cannot reproduce fails the build instead of silently losing its translation.
 */
export function renameCatalog(input: {
  readonly english: Catalog;
  readonly translated: Catalog;
  readonly name: string;
  readonly hashSource: HashSource;
}): Catalog {
  const result: Record<string, CatalogValue> = {};
  const unreproducible: Array<string> = [];
  for (const [key, value] of Object.entries(input.translated)) {
    const source = input.english[key];
    const renamedSource = source === undefined ? undefined : renameDeep(source, input.name);
    const renamedValue = renameDeep(value, input.name) as CatalogValue;
    if (source === undefined || JSON.stringify(renamedSource) === JSON.stringify(source)) {
      result[key] = renamedValue;
      continue;
    }
    const dataFormat = formatOf(input.hashSource, source, key);
    if (dataFormat === undefined) {
      unreproducible.push(key);
      continue;
    }
    result[input.hashSource({ source: renamedSource as CatalogValue, dataFormat })] = renamedValue;
  }
  if (unreproducible.length > 0) throw new CatalogKeyNotReproducibleError({ keys: unreproducible });
  return result;
}

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const NOT_SHIPPED = /(?:\.test|\.browser\.test|\.fixture|\.testkit|\.d)\.(?:ts|tsx)$/;
const T3_ICON_ASSET = /[\\/]assets[\\/](?:prod|dev|nightly)[\\/][^\\/]+\.(?:png|svg|ico)$/;
const T3_WORDMARK_SOURCE = NodePath.join("apps", "web", "src", "components", "T3Wordmark.tsx");
const CATALOG_DIRECTORY = /[\\/]src[\\/]i18n[\\/]translations$/;

/**
 * A bundler plugin that names a fork build's own product and repository wherever repository
 * source, a locale catalog, the page shell or the web manifest names upstream's. Desktop source
 * is excluded: it resolves the name at run time (`PRODUCT_NAME`, `brandText`).
 */
export function productNameTransformPlugin(options: {
  readonly identity: ProductIdentity;
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
  const cleanPath = (id: string) => NodePath.resolve(id.split("?")[0] ?? id);
  return {
    name: "t3code:product-name",
    enforce: "pre" as const,
    async buildStart() {
      hashSource = await options.hashSource?.();
    },
    // A fork build ships none of T3's icon images or its wordmark, which no fork screen shows.
    load(id: string) {
      const path = cleanPath(id);
      if (!isRepositorySource(path)) return null;
      if (T3_ICON_ASSET.test(path)) return { code: 'export default "";', map: null };
      if (path.endsWith(T3_WORDMARK_SOURCE)) {
        return { code: "export const T3Wordmark = () => null;", map: null };
      }
      return null;
    },
    transform(code: string, id: string) {
      const path = cleanPath(id);
      if (!isRepositorySource(path)) return null;
      if (path.endsWith(".json") && CATALOG_DIRECTORY.test(NodePath.dirname(path))) {
        if (hashSource === undefined) return null;
        const english = JSON.parse(
          NodeFS.readFileSync(NodePath.join(NodePath.dirname(path), "en.json"), "utf8"),
        ) as Catalog;
        const translated = JSON.parse(code) as Catalog;
        const renamed = renameCatalog({
          english,
          translated,
          name: options.identity.name,
          hashSource,
        });
        return { code: JSON.stringify(renamed), map: null };
      }
      if (!SOURCE_FILE.test(path) || NOT_SHIPPED.test(path)) return null;
      const renamed = renameProductInSource(code, options.identity);
      return renamed === code ? null : { code: renamed, map: null };
    },
    transformIndexHtml(html: string) {
      return renameProductInSource(html, options.identity);
    },
    writeBundle(outputOptions: { readonly dir?: string | undefined }) {
      if (outputOptions.dir === undefined) return;
      const manifestPath = NodePath.join(outputOptions.dir, "manifest.webmanifest");
      if (!NodeFS.existsSync(manifestPath)) return;
      NodeFS.writeFileSync(
        manifestPath,
        renameProductInSource(NodeFS.readFileSync(manifestPath, "utf8"), options.identity),
      );
    },
  };
}
