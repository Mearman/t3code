#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A standalone build script reading and writing asset files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

import { EXACODE_ICON_PATHS, EXACODE_ICON_SOURCE_SVG } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
// The classic macOS safe area: an 824px body inset 100px on every side of the 1024px canvas.
const MAC_CANVAS = 1024;
const MAC_BODY = 824;
const MAC_INSET = (MAC_CANVAS - MAC_BODY) / 2;

const renderSquare = (svg: Buffer, size: number) =>
  sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

const renderMacOs = async (svg: Buffer) =>
  sharp({
    create: {
      width: MAC_CANVAS,
      height: MAC_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: await renderSquare(svg, MAC_BODY), left: MAC_INSET, top: MAC_INSET }])
    .png()
    .toBuffer();

/** Every ExaCode icon, by repository-relative path, rendered from the logo SVG. */
export async function renderExacodeIcons(): Promise<ReadonlyMap<string, Buffer>> {
  const svg = NodeFS.readFileSync(NodePath.join(REPO_ROOT, EXACODE_ICON_SOURCE_SVG));
  const ico = encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await renderSquare(svg, size) })),
    ),
  );
  return new Map<string, Buffer>([
    [EXACODE_ICON_PATHS.macIconPng, await renderMacOs(svg)],
    [EXACODE_ICON_PATHS.linuxIconPng, await renderSquare(svg, 1024)],
    [EXACODE_ICON_PATHS.webIcon512Png, await renderSquare(svg, 512)],
    [EXACODE_ICON_PATHS.webIcon192Png, await renderSquare(svg, 192)],
    [EXACODE_ICON_PATHS.webAppleTouchIconPng, await renderSquare(svg, 180)],
    [EXACODE_ICON_PATHS.webFavicon32Png, await renderSquare(svg, 32)],
    [EXACODE_ICON_PATHS.webFavicon16Png, await renderSquare(svg, 16)],
    [EXACODE_ICON_PATHS.windowsIconIco, ico],
    [EXACODE_ICON_PATHS.webFaviconIco, ico],
  ]);
}

const decodePixels = async (contents: Buffer) => {
  const { data, info } = await sharp(contents)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};

// Compares decoded pixels, not bytes, so a different PNG encoder build cannot fail the check.
const samePixels = async (left: Buffer, right: Buffer) => {
  const [a, b] = await Promise.all([decodePixels(left), decodePixels(right)]);
  return a.width === b.width && a.height === b.height && a.data.equals(b.data);
};

const icoRenditions = (ico: Buffer): ReadonlyArray<Buffer> =>
  Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const offset = ico.readUInt32LE(entry + 12);
    return ico.subarray(offset, offset + ico.readUInt32LE(entry + 8));
  });

const matches = async (path: string, expected: Buffer, committed: Buffer) => {
  if (!path.endsWith(".ico")) return samePixels(committed, expected);
  const [a, b] = [icoRenditions(committed), icoRenditions(expected)];
  if (a.length !== b.length) return false;
  const same = await Promise.all(a.map((rendition, index) => samePixels(rendition, b[index]!)));
  return same.every(Boolean);
};

/** The paths whose committed file is missing or no longer matches the logo SVG. */
export async function staleExacodeIcons(): Promise<ReadonlyArray<string>> {
  const stale: Array<string> = [];
  for (const [path, expected] of await renderExacodeIcons()) {
    const absolute = NodePath.join(REPO_ROOT, path);
    if (!NodeFS.existsSync(absolute) || !(await matches(path, expected, NodeFS.readFileSync(absolute)))) {
      stale.push(path);
    }
  }
  return stale;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const stale = await staleExacodeIcons();
    if (stale.length > 0) {
      console.error(`These ExaCode icons are stale; run vp run icons:export:exacode:\n${stale.join("\n")}`);
      process.exit(1);
    }
  } else {
    for (const [path, contents] of await renderExacodeIcons()) {
      NodeFS.writeFileSync(NodePath.join(REPO_ROOT, path), contents);
    }
  }
}
