import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";

import { PROJECT_REPOSITORY_URL } from "./branding";

// A fork build is not covered by T3 Tools' policy; what it sends is written up in the
// repository's telemetry notes.
export const PRIVACY_POLICY_URL = IS_FORK_PRODUCT
  ? `${PROJECT_REPOSITORY_URL}/blob/main/docs/user/telemetry.md`
  : "https://t3.codes/privacy-policy";
