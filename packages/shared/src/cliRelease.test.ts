import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliArchiveTarCommand,
  cliInstallScriptUrl,
  newestCliReleaseVersion,
  parseChecksums,
  projectNoreplyEmail,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("reads releases from upstream unless a bundle defines another repository", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/pingdotgg/t3code/releases");
    expect(cliInstallScriptUrl("1.2.3")).toBe("https://t3.codes/install.sh");
  });

  it("installs another repository's build with the installer attached to its release", () => {
    expect(cliInstallScriptUrl("1.2.4-nightly.20261127.7", "owner/fork")).toBe(
      "https://github.com/owner/fork/releases/download/v1.2.4-nightly.20261127.7/install.sh",
    );
    expect(cliInstallScriptUrl("1.2.3", "pingdotgg/t3code")).toBe("https://t3.codes/install.sh");
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});

describe("projectNoreplyEmail", () => {
  it("keeps upstream's address and gives a fork one no account can own", () => {
    expect(projectNoreplyEmail(true, "T3 Code")).toBe("noreply@t3.codes");
    expect(projectNoreplyEmail(false, "MearCode")).toBe("noreply@mearcode.invalid");
    expect(projectNoreplyEmail(false, "My  Fork!")).toBe("noreply@my-fork.invalid");
    expect(projectNoreplyEmail(false, "!!!")).toBe("noreply@fork.invalid");
    expect(projectNoreplyEmail(false, "MearCode")).not.toContain("users.noreply.github.com");
  });
});
