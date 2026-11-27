import { IS_PROVABLY_UPSTREAM_BUILD } from "@t3tools/shared/productName";

import { PROJECT_REPOSITORY_URL } from "./branding";

// T3 Tools' policy covers T3's own services; any other build sends nothing there, and what it
// does send is written up in its repository's telemetry notes.
export const PRIVACY_POLICY_URL = IS_PROVABLY_UPSTREAM_BUILD
  ? "https://t3.codes/privacy-policy"
  : `${PROJECT_REPOSITORY_URL}/blob/main/docs/user/telemetry.md`;
