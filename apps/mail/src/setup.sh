#!/usr/bin/env bash
# myslop-mail client setup: run with
#   curl -fsS https://mail.myslop.app/setup.sh | bash
set -euo pipefail

BASE="https://mail.myslop.app"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-mail"
TOKEN_FILE="$CONFIG_DIR/token"
PLATFORM_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/myslop-apps/token"

say() { printf '%s\n' "$*" >&2; }

verify() {
  curl -fsS -H "Authorization: Bearer $1" "$BASE/api/verify" >/dev/null 2>&1
}

persist() {
  mkdir -p "$CONFIG_DIR"
  (umask 077; printf '%s\n' "$1" >"$TOKEN_FILE")

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
}

# Preferred: the myslop platform token (from myslop.cloud/setup.sh)
# authenticates here directly — no per-app token, no browser dance.
PLATFORM_TOKEN="${MYSLOP_APPS_TOKEN:-}"
if [ -z "$PLATFORM_TOKEN" ] && [ -r "$PLATFORM_TOKEN_FILE" ]; then
  PLATFORM_TOKEN="$(cat "$PLATFORM_TOKEN_FILE")"
fi
if [ -n "$PLATFORM_TOKEN" ] && verify "$PLATFORM_TOKEN"; then
  say "using your myslop platform token"
  persist "$PLATFORM_TOKEN"
  exit 0
fi

# Fallback: mint a token in the dashboard (a pasted platform msa_ token works
# too). Needs an interactive terminal.
if ! (exec </dev/tty >/dev/tty) 2>/dev/null; then
  say "no working platform token found and no interactive terminal."
  say "run the platform setup first, then retry:"
  say "  curl -fsS https://myslop.cloud/setup.sh | bash"
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
    msm_?*|msa_?*) ;;
    *) say "  not an msm_ or msa_ token — try again"; continue ;;
  esac
  if verify "$TOKEN"; then
    break
  fi
  say "  didn't verify — try again (Ctrl-C to abort)"
done

persist "$TOKEN"
