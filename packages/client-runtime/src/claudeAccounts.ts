/**
 * The account a new Claude account shares history with. `choice` undefined follows the default,
 * the first Claude account, including one that loads after the form opened; "" keeps history
 * separate; anything else names an account.
 */
export function claudeShareSource<Account extends { readonly instanceId: string }>(
  accounts: ReadonlyArray<Account>,
  choice: string | undefined,
): Account | undefined {
  return choice === undefined
    ? accounts[0]
    : accounts.find((account) => account.instanceId === choice);
}
