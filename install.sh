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
# sflow itself is installed; say what a first run will still need.
missing=0
command -v tmux >/dev/null 2>&1 || { missing=1; echo "note: tmux not found; install it with 'brew install tmux' (macOS) or 'sudo apt install tmux' (Debian/Ubuntu)"; }
command -v ocs >/dev/null 2>&1 || { missing=1; echo "note: ocs not found; install it with: curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh"; }
command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || { missing=1; echo "note: neither claude nor codex found; install and sign in to the agent CLIs your workflows use"; }
[ "$missing" = 0 ] && echo "tmux, ocs and an agent CLI found"
exit 0
