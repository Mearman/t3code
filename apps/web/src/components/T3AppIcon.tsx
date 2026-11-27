import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";
import { ShieldCheckIcon } from "lucide-react";

// The production icon, as GitHub shows the T3 Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";

/**
 * The icon beside the prompts to install T3's GitHub App. A fork build shows a neutral glyph, so
 * it neither ships T3's icon nor pairs its own mark with an app it does not own.
 */
export function T3AppIcon(props: { readonly className?: string }) {
  return IS_FORK_PRODUCT ? (
    <ShieldCheckIcon aria-hidden className={props.className} />
  ) : (
    <img src={appIconUrl} alt="" className={props.className} />
  );
}
