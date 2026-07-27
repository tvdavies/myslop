#!/usr/bin/env bash
# myslop-mail client setup: run with
#   curl -fsS https://mail.myslop.app/setup.sh | bash
set -euo pipefail

BASE="https://mail.myslop.app"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail"
TOKEN_FILE="$CONFIG_DIR/token"

say() { printf '%s\n' "$*" >/dev/tty; }

if ! (exec </dev/tty >/dev/tty) 2>/dev/null; then
  echo "setup.sh needs an interactive terminal" >&2
  exit 1
fi

# Token name from user@host so the minted token is identifiable in the dashboard.
NAME="$(printf '%s@%s' "${USER:-user}" "$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo host)" | tr -cd 'A-Za-z0-9._@-' | cut -c1-64)"
URL="$BASE/setup?name=$NAME"

say "myslop-mail setup"
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
    msm_?*) ;;
    *) say "  not an msm_ token — try again"; continue ;;
  esac
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/verify" >/dev/null 2>&1; then
    break
  fi
  say "  didn't verify — try again (Ctrl-C to abort)"
done

mkdir -p "$CONFIG_DIR"
(umask 077; printf '%s\n' "$TOKEN" >"$TOKEN_FILE")

# Persist MYSLOP_MAIL_TOKEN for common shells. The token file above is the
# shell-agnostic source of truth; tools can always read it directly.
EXPORT_LINE='export MYSLOP_MAIL_TOKEN="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail/token")"'
MARKER="# myslop-mail token"
WROTE_RC=0

for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  grep -qF "$MARKER" "$rc" || printf '\n%s\n%s\n' "$MARKER" "$EXPORT_LINE" >>"$rc"
  WROTE_RC=1
done
if [ "$WROTE_RC" = 0 ]; then
  printf '%s\n%s\n' "$MARKER" "$EXPORT_LINE" >>"$HOME/.profile"
fi

if [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ]; then
  FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/myslop-mail.fish"
  mkdir -p "$(dirname "$FISH_CONF")"
  cat >"$FISH_CONF" <<'FISH'
# myslop-mail token
set -l _msm_dir $HOME/.config
test -n "$XDG_CONFIG_HOME"; and set _msm_dir $XDG_CONFIG_HOME
if test -r $_msm_dir/myslop-mail/token
    set -gx MYSLOP_MAIL_TOKEN (cat $_msm_dir/myslop-mail/token)
end
FISH
fi

say ""
say "✓ done — MYSLOP_MAIL_TOKEN is set in new shells (token: $TOKEN_FILE)"
say "  this shell: export MYSLOP_MAIL_TOKEN=\"\$(cat $TOKEN_FILE)\""
