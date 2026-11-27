import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";

import { PROJECT_REPOSITORY_URL } from "./branding";

// T3 Tools' policy covers T3's own services, which a fork build does not use.
export const PRIVACY_POLICY_URL = IS_FORK_PRODUCT
  ? PROJECT_REPOSITORY_URL
  : "https://t3.codes/privacy-policy";
