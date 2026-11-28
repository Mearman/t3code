#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone asset script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp from "sharp";

import {
  MEARCODE_ICON_BACKGROUND_COLOR,
  MEARCODE_ICON_PATHS,
  MEARCODE_ICON_SOURCE_SVG,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
// The classic macOS safe area: an 824px body inset 100px on every side of the 1024px canvas.
const MAC_CANVAS = 1024;
const MAC_BODY = 824;
const MAC_INSET = (MAC_CANVAS - MAC_BODY) / 2;

const renderSquare = (svg: Buffer, size: number) =>
  sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

// Android draws MEARCODE_ICON_BACKGROUND_COLOR behind the adaptive foreground and masks the
// central 72dp of 108dp, inside which the logo's mark already sits; the splash shows the whole
// logo within the inner two thirds of its canvas (scripts/export-android-icons.ts).
const ANDROID_ADAPTIVE_CANVAS = 432;
const ANDROID_SPLASH_CANVAS = 1152;
const ANDROID_SPLASH_BODY = 576;

const withoutBackground = (svg: Buffer) => {
  const background = `<rect width="1024" height="1024" rx="230" fill="${MEARCODE_ICON_BACKGROUND_COLOR}"/>`;
  const source = svg.toString("utf8");
  if (source.split(background).length !== 2) {
    throw new Error(`${MEARCODE_ICON_SOURCE_SVG} no longer has exactly one ${background}.`);
  }
  return Buffer.from(source.replace(background, ""));
};

const renderCentred = async (svg: Buffer, canvas: number, body: number) =>
  sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: await renderSquare(svg, body), left: (canvas - body) / 2, top: (canvas - body) / 2 },
    ])
    .png()
    .toBuffer();

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

/** Every MearCode icon, by repository-relative path, rendered from the logo SVG. */
export async function renderMearcodeIcons(): Promise<ReadonlyMap<string, Buffer>> {
  const svg = NodeFS.readFileSync(NodePath.join(REPO_ROOT, MEARCODE_ICON_SOURCE_SVG));
  const ico = encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await renderSquare(svg, size) })),
    ),
  );
  return new Map<string, Buffer>([
    [MEARCODE_ICON_PATHS.macIconPng, await renderMacOs(svg)],
    [MEARCODE_ICON_PATHS.linuxIconPng, await renderSquare(svg, 1024)],
    [MEARCODE_ICON_PATHS.webIcon512Png, await renderSquare(svg, 512)],
    [MEARCODE_ICON_PATHS.webIcon192Png, await renderSquare(svg, 192)],
    [MEARCODE_ICON_PATHS.webAppleTouchIconPng, await renderSquare(svg, 180)],
    [MEARCODE_ICON_PATHS.webFavicon32Png, await renderSquare(svg, 32)],
    [MEARCODE_ICON_PATHS.webFavicon16Png, await renderSquare(svg, 16)],
    [MEARCODE_ICON_PATHS.windowsIconIco, ico],
    [MEARCODE_ICON_PATHS.webFaviconIco, ico],
    [
      MEARCODE_ICON_PATHS.androidForegroundPng,
      await renderSquare(withoutBackground(svg), ANDROID_ADAPTIVE_CANVAS),
    ],
    [
      MEARCODE_ICON_PATHS.androidSplashPng,
      await renderCentred(svg, ANDROID_SPLASH_CANVAS, ANDROID_SPLASH_BODY),
    ],
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
export async function staleMearcodeIcons(): Promise<ReadonlyArray<string>> {
  const stale: Array<string> = [];
  for (const [path, expected] of await renderMearcodeIcons()) {
    const absolute = NodePath.join(REPO_ROOT, path);
    if (
      !NodeFS.existsSync(absolute) ||
      !(await matches(path, expected, NodeFS.readFileSync(absolute)))
    ) {
      stale.push(path);
    }
  }
  return stale;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const stale = await staleMearcodeIcons();
    if (stale.length > 0) {
      console.error(
        `These MearCode icons are stale; run vp run icons:export:mearcode:\n${stale.join("\n")}`,
      );
      process.exit(1);
    }
  } else {
    for (const [path, contents] of await renderMearcodeIcons()) {
      NodeFS.writeFileSync(NodePath.join(REPO_ROOT, path), contents);
    }
  }
}
