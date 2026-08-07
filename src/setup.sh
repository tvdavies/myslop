#!/usr/bin/env bash
# Myslop Apps client setup:
#   curl -fsS https://apps.myslop.app/setup.sh | bash
set -euo pipefail

BASE="https://apps.myslop.app"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps"
TOKEN_FILE="$CONFIG_DIR/token"
BIN_DIR="$HOME/.local/bin"
CLI_FILE="$BIN_DIR/myslop-apps"

say() { printf '%s\n' "$*" >/dev/tty; }

if ! (exec </dev/tty >/dev/tty) 2>/dev/null; then
  echo "setup.sh needs an interactive terminal" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  say "Bun is required. Install it from https://bun.sh, then run setup again."
  exit 1
fi

NAME="$(printf '%s@%s' "${USER:-user}" "$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo host)" | tr -cd 'A-Za-z0-9._@-' | cut -c1-64)"
URL="$BASE/setup?name=$NAME"

say "Myslop Apps setup"
say "opening $URL"
say "sign in if asked, then copy the token shown."

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
fi

TOKEN=""
while :; do
  printf 'token: ' >/dev/tty
  IFS= read -r TOKEN </dev/tty
  TOKEN="${TOKEN//[[:space:]]/}"
  [ -z "$TOKEN" ] && continue
  case "$TOKEN" in
    msa_?*) ;;
    *) say "  not an msa_ token — try again"; continue ;;
  esac
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/verify" >/dev/null 2>&1; then
    break
  fi
  say "  didn't verify — try again (Ctrl-C to abort)"
done

mkdir -p "$CONFIG_DIR" "$BIN_DIR"
(umask 077; printf '%s\n' "$TOKEN" >"$TOKEN_FILE")
chmod 0600 "$TOKEN_FILE"
curl -fsS "$BASE/cli" -o "$CLI_FILE"
chmod 0755 "$CLI_FILE"

EXPORT_LINE='export MYSLOP_APPS_TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token")"'
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
MARKER="# myslop-apps"
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  touch "$rc"
  if ! grep -qF "$MARKER" "$rc"; then
    printf '\n%s\n%s\n%s\n' "$MARKER" "$EXPORT_LINE" "$PATH_LINE" >>"$rc"
  fi
done

FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/myslop-apps.fish"
mkdir -p "$(dirname "$FISH_CONF")"
cat >"$FISH_CONF" <<'FISH'
# myslop-apps
set -l _msa_dir $HOME/.config
test -n "$XDG_CONFIG_HOME"; and set _msa_dir $XDG_CONFIG_HOME
if test -r $_msa_dir/myslop-apps/token
    set -gx MYSLOP_APPS_TOKEN (cat $_msa_dir/myslop-apps/token)
end
fish_add_path $HOME/.local/bin
FISH

say ""
say "✓ token saved to $TOKEN_FILE"
say "✓ CLI installed at $CLI_FILE"
say "  bash/zsh now: export MYSLOP_APPS_TOKEN=\"\$(cat $TOKEN_FILE)\"; export PATH=\"$BIN_DIR:\$PATH\""
say "  fish now: set -gx MYSLOP_APPS_TOKEN (cat $TOKEN_FILE); fish_add_path $BIN_DIR"
say "  try: myslop-apps apps"
