/**
 * The bundler `define` that names a build's own product, read from `T3CODE_DESKTOP_PRODUCT_NAME`
 * like the packaging identity. Empty when unset, so the code keeps its upstream default.
 */
export function productNameDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  return productName === undefined || productName === ""
    ? {}
    : { __T3CODE_DESKTOP_PRODUCT_NAME__: JSON.stringify(productName) };
}

/** The fork's product name, or undefined for a build that keeps upstream's. */
export function forkProductName(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  return productName === undefined || productName === "" ? undefined : productName;
}
