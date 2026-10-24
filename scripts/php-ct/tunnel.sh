#!/bin/sh
# Jeton du tunnel Cloudflare « kouziaphp » (README, section 9), saisi sans affichage, jamais journalisé.
# Le collage peut être le jeton seul ou toute la commande « cloudflared service install eyJ... ».
#
# Usage, en root : sh tunnel.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

trap_signals
require_root

extract_tunnel_token() {
  set -f
  for _w in $1; do
    _w="$(printf '%s' "$_w" | tr -d "\"'")"
    _w="${_w#--token=}"
    case "$_w" in
      eyJ*)
        if printf '%s' "$_w" | grep -Eq '^[A-Za-z0-9_=+/-]{50,}$'; then
          set +f
          printf '%s' "$_w"
          return 0
        fi
        ;;
    esac
  done
  set +f
  return 1
}

install_cloudflared() {
  if [ -x "$KP_CLOUDFLARED_BIN" ]; then
    return 0
  fi
  case "$(uname -m)" in
    x86_64|amd64) _arch=amd64 ;;
    aarch64|arm64) _arch=arm64 ;;
    *) die "Processeur $(uname -m) non prévu pour cloudflared." ;;
  esac
  log "Téléchargement de cloudflared (GitHub, version officielle de Cloudflare)..."
  _tmp="$(mktemp)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${_arch}" -o "$_tmp" \
    || { rm -f "$_tmp"; die "Téléchargement de cloudflared impossible (réseau)."; }
  install -o root -g root -m 755 "$_tmp" "$KP_CLOUDFLARED_BIN"
  rm -f "$_tmp"
  ok "cloudflared installé : $("$KP_CLOUDFLARED_BIN" --version 2>/dev/null | head -n 1)"
}

title "Tunnel Cloudflare des sites PHP"
cat <<EOF
  Dans Cloudflare : Zero Trust > Réseaux > Tunnels > tunnel « kouziaphp » > Installer et lancer un connecteur.
  Copier la commande affichée (elle contient le jeton) et la coller ici. Rien ne s'affiche pendant la saisie.
EOF
ask_secret _paste "Jeton ou commande"
_token="$(extract_tunnel_token "$_paste" || true)"
_paste=""
[ -n "$_token" ] || die "Aucun jeton reconnu (il commence par « eyJ »). Rien n'a changé."

mkdir -p "$KP_ETC_DIR"
chmod 700 "$KP_ETC_DIR"
_tmp="$(mktemp "${KP_TUNNEL_TOKEN_FILE}.XXXXXX")"
printf '%s\n' "$_token" > "$_tmp"
_token=""
chmod 600 "$_tmp"
mv -f "$_tmp" "$KP_TUNNEL_TOKEN_FILE"
ok "Jeton enregistré dans ${KP_TUNNEL_TOKEN_FILE} (root, 600)."

install_cloudflared
install -o root -g root -m 755 "${KP_LIB_DIR}/openrc/cloudflared" /etc/init.d/cloudflared
rc-update add cloudflared default >/dev/null 2>&1 || true
rc_service cloudflared restart >/dev/null 2>&1 || rc_service cloudflared start >/dev/null 2>&1 || true
sleep 3
if service_running cloudflared; then
  ok "Tunnel démarré. Dans Cloudflare, il doit passer « Sain » (HEALTHY) en moins d'une minute."
else
  warn "Le tunnel ne démarre pas. Dernières lignes :"
  tail -n 15 "${KP_LOG_DIR}/cloudflared.err" 2>/dev/null | sed 's/^/    /' || true
  exit 1
fi
