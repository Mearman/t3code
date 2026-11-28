import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { claudeSessionIdOfThread } from "@t3tools/client-runtime/state/claude-session-replication";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Which thread's Claude session the move dialog is open for; the app root renders it once. */
export const claudeSessionMoveDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("claude-session-move:dialog-thread"),
);

export function openClaudeSessionMoveDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(claudeSessionMoveDialogThreadAtom, threadRef);
}

/**
 * Whether to offer moving a thread's Claude Code session: its server can move sessions and this
 * client holds the scopes a move needs (`permitted`, from the move command's permission), so a
 * dialog never opens on a Move it cannot press.
 */
export function canMoveClaudeSession(
  threadId: string,
  capabilities: { readonly claudeSessionMove?: boolean } | undefined,
  permitted: boolean,
): boolean {
  return (
    permitted &&
    claudeSessionIdOfThread(threadId) !== null &&
    capabilities?.claudeSessionMove === true
  );
}
