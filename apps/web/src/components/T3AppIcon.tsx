import exacodeIconUrl from "../../../../assets/exacode/exacode-web-apple-touch-180.png";
// The production icon, as GitHub shows the T3 Code app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";
import { IS_FORK_BRAND } from "../branding";

/** The icon beside the source-control app prompts: T3's upstream, the fork's own in a fork build. */
export function T3AppIcon(props: { readonly className?: string }) {
  return (
    <img src={IS_FORK_BRAND ? exacodeIconUrl : appIconUrl} alt="" className={props.className} />
  );
}
