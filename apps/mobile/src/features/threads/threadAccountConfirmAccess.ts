import { useAtomValue } from "@effect/atom-react";
import { canConfirmThreadAccount } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";

/** Whether this client can show the confirm button for a changed Claude account. */
export function useThreadAccountConfirmAccess(environmentId: EnvironmentId) {
  const permitted = useAtomValue(
    serverEnvironment.confirmClaudeThreadAccount.permissionAtom(environmentId),
  );
  const serverConfirms =
    useServerConfigs().get(environmentId)?.environment.capabilities.claudeThreadAccounts === true;
  return canConfirmThreadAccount({ serverConfirms, permitted });
}
