// Bundles define this from the build's product name (scripts/lib/product-name-define.ts).
declare const __T3CODE_DESKTOP_PRODUCT_NAME__: string | undefined;

export const UPSTREAM_PRODUCT_NAME = "T3 Code"; // product-name: keep

const UPSTREAM_PRODUCT_PATTERN = /T3[ -]Code/g; // product-name: keep

/** The product name this build shows: upstream's, or the fork build's own. */
export const PRODUCT_NAME: string =
  typeof __T3CODE_DESKTOP_PRODUCT_NAME__ === "undefined"
    ? UPSTREAM_PRODUCT_NAME
    : __T3CODE_DESKTOP_PRODUCT_NAME__;

/** Whether this build is a fork under its own name, so T3's marks and channels are not shown. */
export const IS_FORK_PRODUCT = PRODUCT_NAME !== UPSTREAM_PRODUCT_NAME;

/** `text` with upstream's product name, hyphenated spellings included, replaced by `name`. */
export function renameProduct(text: string, name: string): string {
  return name === UPSTREAM_PRODUCT_NAME ? text : text.replace(UPSTREAM_PRODUCT_PATTERN, name);
}

/** Names this build's own product wherever `text` names upstream's. */
export function brandText(text: string): string {
  return renameProduct(text, PRODUCT_NAME);
}
