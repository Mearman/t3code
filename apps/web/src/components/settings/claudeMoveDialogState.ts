import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** What a move dialog moves: one thread, or every thread on an account. */
export interface ClaudeMoveRequest {
  readonly environmentId: EnvironmentId;
  readonly sourceInstanceId: ProviderInstanceId;
  readonly threadId?: ThreadId;
}

/** The open move dialog; the thread menu and the provider card set it, the root renders it. */
export const claudeMoveDialogAtom = Atom.make<ClaudeMoveRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("claude-account-move:dialog"),
);

export function openClaudeMoveDialog(request: ClaudeMoveRequest): void {
  appAtomRegistry.set(claudeMoveDialogAtom, request);
}
