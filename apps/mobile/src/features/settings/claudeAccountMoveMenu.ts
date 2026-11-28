import { claudeAccountLabel, claudeMoveTargets } from "@t3tools/client-runtime/claudeAccountMove";
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

const MOVE_ACTION_PREFIX = "claude-move-to:";

/**
 * The menu item for moving threads off `sourceInstanceId`: the one other account itself, or a
 * submenu listing every other account. Native menus take any number of items, unlike alerts.
 */
export function claudeMoveMenuAction(
  providers: ReadonlyArray<ServerProvider>,
  sourceInstanceId: ProviderInstanceId,
  item: Omit<MenuAction, "id" | "subactions">,
  sharedHistoryOnly: boolean,
): MenuAction | undefined {
  const targets = claudeMoveTargets(providers, sourceInstanceId, sharedHistoryOnly);
  const [only] = targets;
  if (only === undefined) return undefined;
  if (targets.length === 1) return { ...item, id: `${MOVE_ACTION_PREFIX}${only.instanceId}` };
  return {
    ...item,
    id: `${MOVE_ACTION_PREFIX}menu`,
    subactions: targets.map((target) => ({
      id: `${MOVE_ACTION_PREFIX}${target.instanceId}`,
      title: claudeAccountLabel(target),
    })),
  };
}

/**
 * The account a `claudeMoveMenuAction` id names: undefined for an id it did not make, null when
 * that account can no longer take the threads.
 */
export function claudeMoveMenuTarget(
  providers: ReadonlyArray<ServerProvider>,
  sourceInstanceId: ProviderInstanceId,
  id: string,
  sharedHistoryOnly: boolean,
): ServerProvider | null | undefined {
  if (!id.startsWith(MOVE_ACTION_PREFIX)) return undefined;
  const instanceId = id.slice(MOVE_ACTION_PREFIX.length);
  return (
    claudeMoveTargets(providers, sourceInstanceId, sharedHistoryOnly).find(
      (target) => target.instanceId === instanceId,
    ) ?? null
  );
}
