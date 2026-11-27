import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";
import { T } from "gt-react";
import { DESKTOP_DOWNLOAD_URL } from "~/branding";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `t3`, then run `command`. Both installers are shown
 * because the browser showing this is often not the computer being set up.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {IS_FORK_PRODUCT ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Download <code className="font-mono">install.sh</code> from the{" "}
            <a className="underline" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              releases page
            </a>{" "}
            and run it with <code className="font-mono">sh</code>.
          </T>
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">macOS, Linux</p>
          <CommandBlock command="curl -fsSL https://t3.codes/install.sh | sh" />
          <p className="text-xs text-muted-foreground">Windows (PowerShell)</p>
          <CommandBlock command="irm https://t3.codes/install.ps1 | iex" />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        <T>Then</T>
      </p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        <T>
          Skip the install if you already have <code className="font-mono">t3</code>. If{" "}
          <code className="font-mono">t3</code> is not found after installing, add the folder the
          installer names to your PATH.
        </T>
      </p>
    </div>
  );
}
