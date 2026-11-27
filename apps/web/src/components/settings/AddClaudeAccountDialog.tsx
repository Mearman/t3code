import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsRow } from "./settingsLayout";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** Adds a Claude account on a config folder the server creates, then signs it in. */
export function AddClaudeAccountDialog({
  environmentId,
  environmentLabel,
  onClose,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onAccountCreated?: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const create = useAtomCommand(serverEnvironment.createClaudeAccount, {
    reportFailure: false,
    reportDefect: false,
  });
  const claudeInstances = (providers ?? []).filter(
    (provider) => provider.driver === CLAUDE_DRIVER_KIND,
  );
  const [name, setName] = useState("");
  const [shareWith, setShareWith] = useState<string>(() => claudeInstances[0]?.instanceId ?? "");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  const signedIn = provider?.auth.status === "authenticated";
  const source = claudeInstances.find((candidate) => candidate.instanceId === shareWith);

  const createAccount = async () => {
    const displayName = name.trim();
    if (pending || !displayName || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: { displayName, ...(source ? { shareHistoryWith: source.instanceId } : {}) },
    });
    setPending(false);
    if (result._tag === "Success") {
      onAccountCreated?.(result.value.instanceId);
      setInstanceId(result.value.instanceId);
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error
        ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
        : gt("Could not add the {provider} account.", { provider: "Claude" }),
    );
  };

  return (
    <Dialog
      open={!signedIn}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && signedIn) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={gt("Add {provider} account", { provider: "Claude" })}
          description={gt(
            "Each account has its own config folder and sign-in. Sharing history lets both accounts resume the same sessions.",
          )}
        />
        <WizardPanel>
          {instanceId ? (
            provider ? (
              <ProviderAuthenticationSection
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                instanceId={instanceId}
                provider={provider}
                readOnly={!canManageProviders}
              />
            ) : (
              <SettingsRow title={gt("Account")} description={gt("Preparing the new account.")} />
            )
          ) : (
            <form
              id="add-claude-account"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title={gt("Account name")}
                description={gt("Shown in the provider list and model picker.")}
                control={
                  <Input
                    aria-label={gt("Account name")}
                    value={name}
                    disabled={pending}
                    maxLength={64}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={gt("e.g. Personal or Work")}
                  />
                }
              />
              <SettingsRow
                title={gt("Share history with")}
                description={gt(
                  "Projects, sessions, file history and tasks stay in one place, so either account can resume them.",
                )}
                control={
                  <Select
                    value={source ? source.instanceId : ""}
                    disabled={pending}
                    onValueChange={(value) => setShareWith(value ?? "")}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Share history with")} className="w-48">
                      <SelectValue>
                        {source ? (source.displayName ?? "Claude") : gt("Keep history separate")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {claudeInstances.map((candidate) => (
                        <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                          {candidate.displayName ?? "Claude"}
                        </SelectItem>
                      ))}
                      <SelectItem value="">
                        <T>Keep history separate</T>
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
              {error ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              <T>Finish later</T>
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                <T>Cancel</T>
              </Button>
              <Button
                type="submit"
                form="add-claude-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                {pending ? gt("Adding account…") : gt("Continue")}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
