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

/** Whether a thread shows a Claude Code session its server, by its capabilities, can move. */
export function canMoveClaudeSession(
  threadId: string,
  capabilities: { readonly claudeSessionMove?: boolean } | undefined,
): boolean {
  return claudeSessionIdOfThread(threadId) !== null && capabilities?.claudeSessionMove === true;
}
