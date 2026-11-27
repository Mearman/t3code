import type { DesktopAppBranding } from "@t3tools/contracts";
import {
  formatAppDisplayName,
  resolveHostedAppChannelLabel,
  resolveWebAppStageLabel,
} from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL = resolveHostedAppChannelLabel(HOSTED_APP_CHANNEL);
// Bundles define this from the build's product name (scripts/lib/desktop-product-name.ts).
declare const __T3CODE_DESKTOP_PRODUCT_NAME__: string | undefined;
const UPSTREAM_APP_BASE_NAME = "T3 Code";
export const APP_BASE_NAME =
  injectedDesktopAppBranding?.baseName ??
  (typeof __T3CODE_DESKTOP_PRODUCT_NAME__ === "undefined"
    ? UPSTREAM_APP_BASE_NAME
    : __T3CODE_DESKTOP_PRODUCT_NAME__);
/** Whether this build is a fork under its own name, so T3's wordmark and name are not shown. */
export const IS_FORK_BRAND = APP_BASE_NAME !== UPSTREAM_APP_BASE_NAME;

/** Names this build's product wherever translated copy names upstream's, hyphenated spellings included. */
export function brandText(text: string): string {
  return IS_FORK_BRAND ? text.replace(/T3[ -]Code/g, APP_BASE_NAME) : text;
}
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  resolveWebAppStageLabel({
    hostedAppChannel: HOSTED_APP_CHANNEL,
    development: import.meta.env.DEV,
  });
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
export const DESKTOP_DOWNLOAD_URL = "https://t3.codes/download";
// Redirects to the App Store or Google Play to match the phone that opens it.
export const MOBILE_APP_URL = "https://t3.codes/mobile";
