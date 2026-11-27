/**
 * The bundler `define` that names the desktop app in its own window title and About panel, read
 * like the packaging identity: `T3CODE_DESKTOP_PRODUCT_NAME`. Empty when unset, so the code keeps
 * its upstream default.
 */
export function desktopProductNameDefine(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const productName = env.T3CODE_DESKTOP_PRODUCT_NAME?.trim();
  return productName === undefined || productName === ""
    ? {}
    : { __T3CODE_DESKTOP_PRODUCT_NAME__: JSON.stringify(productName) };
}
