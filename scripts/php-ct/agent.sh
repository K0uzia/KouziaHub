#!/bin/sh
# Réglage de l'agent (README, section 11.8) : IP du CT du hub, seule autorisée, et secret partagé.
# Lit deux lignes : l'IP, puis le secret. Pensé pour être alimenté depuis le Shell du nœud Proxmox,
# sans que le secret ne s'affiche nulle part :
#   printf '%s\n%s\n' "$HUB_IP" "$SECRET" | pct exec <CT PHP> -- kouziaphpctl agent
# À la main, dans le CT : les deux questions sont posées, le secret sans écho.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

trap_signals
require_root

title "Agent des sites PHP"
if [ -t 0 ]; then
  printf '  %s : ' "IP du CT du hub (seule autorisée)"
fi
_ip=""
IFS= read -r _ip || _ip=""
printf '%s' "$_ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "IP du hub invalide (4 nombres séparés par des points). Rien n'a changé."
ask_secret _secret "Secret partagé avec le hub (invisible)"
printf '%s' "$_secret" | grep -Eq '^[A-Za-z0-9+/=_-]{32,200}$' || die "Secret invalide (32 caractères au moins). Rien n'a changé."

command -v node >/dev/null 2>&1 || apk add --no-cache nodejs >/dev/null || die "Node.js introuvable (apk add nodejs)."

mkdir -p "$KP_ETC_DIR"
chmod 700 "$KP_ETC_DIR"
_tmp="$(mktemp "${KP_ETC_DIR}/agent.secret.XXXXXX")"
printf '%s\n' "$_secret" > "$_tmp"
_secret=""
chmod 600 "$_tmp"
mv -f "$_tmp" "${KP_ETC_DIR}/agent.secret"
printf 'KP_AGENT_HUB_IP=%s\nKP_AGENT_PORT=%s\n' "$_ip" "$KP_AGENT_PORT" > "${KP_ETC_DIR}/agent.env"
chmod 600 "${KP_ETC_DIR}/agent.env"
ok "Agent réglé : hub ${_ip} seul autorisé, port ${KP_AGENT_PORT}, secret dans ${KP_ETC_DIR}/agent.secret (root, 600)."

install -o root -g root -m 755 "${KP_LIB_DIR}/openrc/kouziaphp-agent" /etc/init.d/kouziaphp-agent
rc-update add kouziaphp-agent default >/dev/null 2>&1 || true
rc_service kouziaphp-agent restart >/dev/null 2>&1 || rc_service kouziaphp-agent start >/dev/null 2>&1 || true
if service_running kouziaphp-agent; then
  ok "Agent démarré. Côté hub : hubctl secrets php (même IP de ce CT, même secret), puis Réglages > Serveur des sites PHP."
else
  warn "L'agent ne démarre pas. Dernières lignes :"
  tail -n 15 "${KP_LOG_DIR}/agent.err" 2>/dev/null | sed 's/^/    /' || true
  exit 1
fi
