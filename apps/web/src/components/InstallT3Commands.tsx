import {
  UPSTREAM_INSTALL_POWERSHELL_URL,
  UPSTREAM_INSTALL_SCRIPT_URL,
} from "@t3tools/shared/cliRelease";
import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";
import { T } from "gt-react";
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
  // T3's installers install T3's CLI, which a fork build does not point at.
  if (IS_FORK_PRODUCT) return null;
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">macOS, Linux</p>
      <CommandBlock command={`curl -fsSL ${UPSTREAM_INSTALL_SCRIPT_URL} | sh`} />
      <p className="text-xs text-muted-foreground">Windows (PowerShell)</p>
      <CommandBlock command={`irm ${UPSTREAM_INSTALL_POWERSHELL_URL} | iex`} />
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
