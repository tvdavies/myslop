#!/usr/bin/env bash
# myslop-files client setup: run with
#   curl -fsS https://files.myslop.app/setup.sh | bash
set -euo pipefail

BASE="https://files.myslop.app"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files"
TOKEN_FILE="$CONFIG_DIR/token"

say() { printf '%s\n' "$*" >/dev/tty; }

if ! (exec </dev/tty >/dev/tty) 2>/dev/null; then
  echo "setup.sh needs an interactive terminal" >&2
  exit 1
fi

say ""
say "── myslop-files setup ─────────────────────────────"
say "1. Sign in at $BASE/dashboard"
say "2. Generate a token and copy it"
say "3. Paste it below"
say ""

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$BASE/dashboard" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$BASE/dashboard" >/dev/null 2>&1 || true
fi

TOKEN=""
while :; do
  printf 'token (msf_…): ' >/dev/tty
  IFS= read -r TOKEN </dev/tty
  TOKEN="${TOKEN//[[:space:]]/}"
  case "$TOKEN" in
    msf_?*) ;;
    "") continue ;;
    *) say "that doesn't look like an msf_ token, try again"; continue ;;
  esac
  if WHO=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/verify" 2>/dev/null); then
    break
  fi
  say "token didn't verify — paste it again (Ctrl-C to abort)"
done

NAME=$(printf '%s' "$WHO" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
say "verified${NAME:+ — hi $NAME}"

mkdir -p "$CONFIG_DIR"
(umask 077; printf '%s\n' "$TOKEN" >"$TOKEN_FILE")
say "token saved to $TOKEN_FILE"

EXPORT_LINE='export MYSLOP_FILES_TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-files/token")"'
MARKER="# myslop-files token"

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if ! grep -qF "$MARKER" "$rc"; then
    printf '\n%s\n%s\n' "$MARKER" "$EXPORT_LINE" >>"$rc"
    say "added MYSLOP_FILES_TOKEN to $rc"
  fi
done

if [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ]; then
  FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/myslop-files.fish"
  mkdir -p "$(dirname "$FISH_CONF")"
  cat >"$FISH_CONF" <<'FISH'
# myslop-files token
set -l _msf_dir $HOME/.config
test -n "$XDG_CONFIG_HOME"; and set _msf_dir $XDG_CONFIG_HOME
if test -r $_msf_dir/myslop-files/token
    set -gx MYSLOP_FILES_TOKEN (cat $_msf_dir/myslop-files/token)
end
FISH
  say "added MYSLOP_FILES_TOKEN to fish ($FISH_CONF)"
fi

say ""
say "done. restart your shell (or export it now):"
say "  export MYSLOP_FILES_TOKEN=\"\$(cat $TOKEN_FILE)\""
say ""
say "upload with:"
say "  curl -sS --fail-with-body -X PUT -T ./file.png \\"
say "    -H \"Authorization: Bearer \$MYSLOP_FILES_TOKEN\" \\"
say "    $BASE/file.png"
say ""
say "agents: install the skill from $BASE/skill.md"
