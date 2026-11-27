import { UPSTREAM_PRODUCT_NAME } from "@t3tools/shared/productName";
import { useGT } from "gt-react-native";

import { FORK_PRODUCT_NAME } from "../lib/productName";
import { AppText as Text } from "./ui/AppText";

/** TRADEMARK.md: a fork build says plainly that it is unofficial wherever it shows its name. */
export function UnofficialForkNotice(props: { readonly className?: string }) {
  const gt = useGT();
  if (FORK_PRODUCT_NAME === undefined) return null;
  return (
    <Text className={props.className ?? "text-xs text-foreground-muted"}>
      {gt(
        "An unofficial fork based on the {upstream} source code. Not affiliated with, endorsed by or maintained by T3 Tools, Inc.",
        { upstream: UPSTREAM_PRODUCT_NAME },
      )}
    </Text>
  );
}
