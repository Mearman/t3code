import Constants from "expo-constants";

import { FORK_PRODUCT_NAME } from "../lib/productName";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  FORK_PRODUCT_NAME !== undefined
    ? require("../../../../assets/mearcode/mearcode-universal-1024.png")
    : appVariant === "development"
      ? require("../../../../assets/dev/blueprint-ios-1024.png")
      : appVariant === "preview"
        ? require("../../../../assets/nightly/nightly-ios-1024.png")
        : require("../../../../assets/prod/black-ios-1024.png");
