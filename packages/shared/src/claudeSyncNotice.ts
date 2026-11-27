/** The Claude session sync writes this notice, and clients show it in the user's language by its id. */
export function isClaudeHistoryNoticeId(itemId: string): boolean {
  return itemId.startsWith("x:") && itemId.endsWith(":history");
}

const SECOND_WRITER_NOTICE_PREFIX = "x:held-send:";

/** The notice on a run T3 Code sent beside another process holding its Claude session. */
export function claudeSecondWriterNoticeId(runId: string): string {
  return `${SECOND_WRITER_NOTICE_PREFIX}${runId}`;
}

export function isClaudeSecondWriterNoticeId(itemId: string): boolean {
  return itemId.startsWith(SECOND_WRITER_NOTICE_PREFIX);
}
