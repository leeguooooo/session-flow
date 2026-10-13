#!/bin/sh
set -eu
repo=leeguooooo/session-flow
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64|Linux-arm64) platform=linux-arm64 ;;
  *) echo "unsupported platform (tmux runtime requires macOS/Linux)" >&2; exit 1 ;;
esac
base="https://github.com/$repo/releases/latest/download"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
archive="sflow-$platform.tar.gz"
curl -fsSL "$base/$archive" -o "$stage/$archive"
curl -fsSL "$base/$archive.sha256" -o "$stage/$archive.sha256"
(
  cd "$stage"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$archive.sha256"; else shasum -a 256 -c "$archive.sha256"; fi
  tar -xzf "$archive"
)
destination="${SFLOW_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$destination"
install -m 755 "$stage/sflow" "$destination/sflow"
echo "installed $destination/sflow"
"$destination/sflow" version
