#!/bin/sh
# AXIOM installer — downloads the standalone binary for this OS/arch from the GitHub release,
# verifies it against SHA256SUMS and installs it to $AXIOM_INSTALL_DIR (default ~/.local/bin).
#
#   curl -fsSL https://dragoscv.github.io/axiom/install.sh | sh
#   AXIOM_VERSION=v2.2.1 AXIOM_INSTALL_DIR=/usr/local/bin sh install.sh
set -eu

REPO="dragoscv/axiom"
VERSION="${AXIOM_VERSION:-latest}"
INSTALL_DIR="${AXIOM_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "axiom-install: $*" >&2; }
die() { say "error: $*"; exit 1; }

fetch() {
  # fetch <url> <out-file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "need curl or wget to download files"
  fi
}

fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    die "need curl or wget to download files"
  fi
}

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os=linux ;;
  darwin) os=darwin ;;
  *) die "unsupported OS '$os' — on Windows use: irm https://dragoscv.github.io/axiom/install.ps1 | iex; elsewhere use: npx @codai/axiom-mcp" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture '$arch' (supported: x86_64, arm64) — use: npx @codai/axiom-mcp" ;;
esac

asset="axiom-$os-$arch"

if [ "$VERSION" = "latest" ]; then
  say "resolving latest release"
  tag=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || die "could not resolve the latest release tag (GitHub API rate-limited?). Set AXIOM_VERSION=vX.Y.Z and retry."
else
  tag="$VERSION"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
fi

base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t axiom)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($tag)"
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset (does release $tag ship a binary for $os-$arch?)"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

expected=$(grep -E "[[:space:]]\*?$asset\$" "$tmp/SHA256SUMS" | head -n 1 | cut -d ' ' -f 1)
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS for $tag"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | cut -d ' ' -f 1)
else
  die "need sha256sum or shasum to verify the download"
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $asset: expected $expected, got $actual — refusing to install"
say "checksum verified"

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/axiom"
say "installed to $INSTALL_DIR/axiom"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say "note: $INSTALL_DIR is not on your PATH. Add it, e.g.:"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

"$INSTALL_DIR/axiom" --version
say "done. Verify provenance with: gh attestation verify $INSTALL_DIR/axiom --repo $REPO"
