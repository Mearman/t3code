#!/usr/bin/env bash
# Renders the ExaCode "E" monogram from assets/exacode/logo.svg into every raster the desktop
# packaging and the bundled web client read (macOS, Linux, Windows, favicons).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/assets/exacode"
src="$out/logo.svg"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() { rsvg-convert -w "$2" -h "$2" "$src" -o "$1"; }

# macOS keeps the classic safe area: an 824px body inset 100px on every side.
body="$(sed -n '/<rect/p;/<path/p' "$src" | tr -d '\n')"
cat > "$tmp/macos.svg" <<SVG
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(100 100) scale(0.8046875)">$body</g>
</svg>
SVG
rsvg-convert -w 1024 -h 1024 "$tmp/macos.svg" -o "$out/exacode-macos-1024.png"

render "$out/exacode-universal-1024.png" 1024
render "$out/exacode-web-icon-512x512.png" 512
render "$out/exacode-web-icon-192x192.png" 192
render "$out/exacode-web-apple-touch-180.png" 180
render "$out/exacode-web-favicon-32x32.png" 32
render "$out/exacode-web-favicon-16x16.png" 16

ico_sizes=256,128,64,48,32,24,16
magick "$out/exacode-universal-1024.png" -define icon:auto-resize="$ico_sizes" "$out/exacode-windows.ico"
magick "$out/exacode-universal-1024.png" -define icon:auto-resize="$ico_sizes" "$out/exacode-web-favicon.ico"
