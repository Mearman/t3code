/** The Claude session sync writes this notice, and clients show it in the user's language by its id. */
export function isClaudeHistoryNoticeId(itemId: string): boolean {
  return itemId.startsWith("x:") && itemId.endsWith(":history");
}
