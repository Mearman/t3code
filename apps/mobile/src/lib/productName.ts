import { UPSTREAM_PRODUCT_NAME } from "@t3tools/shared/productName";
import Constants from "expo-constants";

// app.config.ts records a fork build's product name; Metro substitutes no bundle defines.
const configuredProductName: unknown = Constants.expoConfig?.extra?.productName;

/** The fork build's own product name, or undefined for T3 Code itself. */
export const FORK_PRODUCT_NAME =
  typeof configuredProductName === "string" ? configuredProductName : undefined;

/** The product name this build shows. */
export const MOBILE_PRODUCT_NAME = FORK_PRODUCT_NAME ?? UPSTREAM_PRODUCT_NAME;
