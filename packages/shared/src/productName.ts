// Bundles define this from the build's product name (scripts/lib/product-name-define.ts).
declare const __T3CODE_DESKTOP_PRODUCT_NAME__: string | undefined;

// Set by scripts/lib/product-name-define.ts: true only for a build that is provably upstream's.
declare const __T3CODE_BUILD_PROVABLY_UPSTREAM__: boolean | undefined;

/**
 * Whether this build is provably upstream's: built with no product name of its own and with
 * upstream's release repository. Anything else, including a build with no such fact at all, is
 * not, so a feature that must stay off outside upstream (usage data) fails closed.
 */
export const IS_PROVABLY_UPSTREAM_BUILD: boolean =
  typeof __T3CODE_BUILD_PROVABLY_UPSTREAM__ === "undefined"
    ? false
    : __T3CODE_BUILD_PROVABLY_UPSTREAM__;

export const UPSTREAM_PRODUCT_NAME = "T3 Code"; // product-name: keep

/**
 * Upstream's product name in any spelling (spaced or hyphenated). T3's own GitHub App keeps its
 * real name, so "T3 Code for GitHub" is not matched. Global, so use it with `replace` or
 * `matchAll`, never `test`.
 */
export const UPSTREAM_PRODUCT_PATTERN = /T3[ -]Code(?! for GitHub)/g; // product-name: keep

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
