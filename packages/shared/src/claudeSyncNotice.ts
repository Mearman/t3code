/** The Claude session sync writes this notice, and clients show it in the user's language by its id. */
export function isClaudeHistoryNoticeId(itemId: string): boolean {
  return itemId.startsWith("x:") && itemId.endsWith(":history");
}

const SECOND_WRITER_NOTICE_PREFIX = "x:held-send:";

/** The notice on a run T3 Code sent beside another process holding its Claude session. */
export function claudeSecondWriterNoticeId(runId: string): string {
  return `${SECOND_WRITER_NOTICE_PREFIX}${runId}`;
}

const BRIDGE_FAILURE_NOTICE_PREFIX = "x:bridge-failed:";

/** The notice on a run whose prompt the T3 bridge took but never got into the terminal. */
export function claudeBridgeFailureNoticeId(runId: string): string {
  return `${BRIDGE_FAILURE_NOTICE_PREFIX}${runId}`;
}

export function isClaudeBridgeFailureNoticeId(itemId: string): boolean {
  return itemId.startsWith(BRIDGE_FAILURE_NOTICE_PREFIX);
}

export function isClaudeSecondWriterNoticeId(itemId: string): boolean {
  return itemId.startsWith(SECOND_WRITER_NOTICE_PREFIX);
}
