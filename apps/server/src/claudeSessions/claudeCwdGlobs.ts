/**
 * Whether a working directory matches an exclusion glob: `*` and `?` stay within one path segment, `**` spans segments, a leading `~` is the home directory, and `<dir>/**` also matches `<dir>` itself.
 */
export function matchesCwdGlob(input: {
  readonly glob: string;
  readonly cwd: string;
  readonly home: string;
}): boolean {
  const glob = input.glob.startsWith("~") ? `${input.home}${input.glob.slice(1)}` : input.glob;
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? "";
    if (char === "*" && glob[index + 1] === "*") {
      // `/**` at the end also matches the directory itself.
      if (index === glob.length - 2 && pattern.endsWith("/")) {
        pattern = `${pattern.slice(0, -1)}(?:/.*)?`;
      } else {
        pattern += ".*";
      }
      index++;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`).test(input.cwd);
}
