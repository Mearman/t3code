import type { SVGProps } from "react";

import { IS_FORK_PRODUCT } from "@t3tools/shared/productName";
import { T3Wordmark } from "./T3Wordmark";

/** The "E" of the MearCode monogram, as a glyph that takes the surrounding text colour. */
function MearCodeMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="337 272 350 480" xmlns="http://www.w3.org/2000/svg">
      <path d="M337 272H687V372H437V462H647V562H437V652H687V752H337V272Z" fill="currentColor" />
    </svg>
  );
}

/** The product's glyph: T3's wordmark upstream, MearCode's monogram in a fork build. */
export function AppWordmark(props: SVGProps<SVGSVGElement>) {
  return IS_FORK_PRODUCT ? <MearCodeMark {...props} /> : <T3Wordmark {...props} />;
}
