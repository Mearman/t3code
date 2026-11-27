export const UPSTREAM_APP_BASE_NAME = "T3 Code";

// Bundles define this from the build's product name (scripts/lib/desktop-product-name.ts).
declare const __T3CODE_DESKTOP_PRODUCT_NAME__: string | undefined;

const UPSTREAM_PATTERN = /T3[ -]Code/g;

/** The product name shown in the app's own text: upstream's, or the fork build's. */
export const APP_BASE_NAME =
  typeof __T3CODE_DESKTOP_PRODUCT_NAME__ === "undefined"
    ? UPSTREAM_APP_BASE_NAME
    : __T3CODE_DESKTOP_PRODUCT_NAME__;

/** `text` with upstream's product name, hyphenated spellings included, replaced by `name`. */
export function renameProduct(text: string, name: string): string {
  return name === UPSTREAM_APP_BASE_NAME ? text : text.replace(UPSTREAM_PATTERN, name);
}

/** Names the build's own product wherever `text` names upstream's. */
export function brandText(text: string): string {
  return renameProduct(text, APP_BASE_NAME);
}
