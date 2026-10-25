#!/bin/sh
# État du CT des sites PHP : système, services, PHP, pare-feu, tunnel, limites par site, dernière mise à jour.
# Lecture seule. Usage : sh status.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

svc_state() {
  if ! service_exists "$1"; then
    echo "non installé"
  elif service_running "$1"; then
    echo "en marche"
  else
    echo "${C_RED}arrêté${C_RESET}"
  fi
}

title "CT des sites PHP"
_alpine="$(cat /etc/alpine-release 2>/dev/null || true)"
if [ -z "$_alpine" ]; then
  echo "  Alpine                 : ${C_RED}illisible${C_RESET} (/etc/alpine-release absent)"
elif alpine_at_least "$KP_ALPINE_MIN"; then
  echo "  Alpine                 : ${_alpine} (minimum ${KP_ALPINE_MIN} : OK)"
else
  echo "  Alpine                 : ${C_RED}${_alpine}${C_RESET} (minimum ${KP_ALPINE_MIN} : trop ancienne)"
fi
_versions="$(php_versions_installed)"
echo "  PHP installés          : ${_versions:-aucun} (défaut des sites : ${KP_PHP_DEFAULT})"
_noargon="$(php_without_argon2)"
if [ -n "$_noargon" ]; then
  echo "                           ${C_YELLOW}sans argon2id : ${_noargon}${C_RESET}(password_hash(PASSWORD_ARGON2ID) échouera)"
fi
echo "  Sites                  : $(find "$KP_SITES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ') (lot P3)"
echo "  Disque /srv/sites      : $(df -Ph "$KP_SITES_DIR" 2>/dev/null | awk 'NR==2 { print $4 " libres sur " $2 }')"

title "Services"
echo "  nginx                  : $(svc_state nginx)"
if [ "$(id -u)" -eq 0 ]; then
  if nginx -t >/dev/null 2>&1; then
    echo "  Configuration nginx    : valide"
  else
    echo "  Configuration nginx    : ${C_RED}refusée${C_RESET} (nginx -t)"
  fi
fi
echo "  MariaDB                : $(svc_state mariadb)"
echo "  Tunnel (cloudflared)   : $(svc_state "$KP_TUNNEL_SERVICE")"
echo "  Agent (hub)            : $(svc_state kouziaphp-agent)"
if [ "$(id -u)" -eq 0 ] && [ ! -s "${KP_ETC_DIR}/agent.secret" ]; then
  echo "                           pas encore réglé : kouziaphpctl agent (README, 11.8)"
fi
if [ ! -s "$KP_TUNNEL_TOKEN_FILE" ]; then
  echo "                           jeton absent : kouziaphpctl tunnel"
fi

title "Sécurité"
_table=0
if command -v nft >/dev/null 2>&1 && nft list table inet kouziaphp 2>/dev/null | grep -q "jump sites"; then _table=1; fi
if [ "$_table" -eq 1 ] && service_running "$KP_FIREWALL_SERVICE" && rc-update show default 2>/dev/null | grep -q "$KP_FIREWALL_SERVICE"; then
  echo "  Pare-feu du CT         : posé (comptes des sites : DNS, HTTPS, capteur d'e-mails), relancé au démarrage"
elif [ "$_table" -eq 1 ]; then
  echo "  Pare-feu du CT         : ${C_YELLOW}règles chargées, service ${KP_FIREWALL_SERVICE} arrêté ou hors démarrage${C_RESET} (perdues au redémarrage : kouziaphpctl firewall)"
else
  echo "  Pare-feu du CT         : ${C_YELLOW}absent${C_RESET} (kouziaphpctl firewall ; la règle Proxmox reste la première protection)"
fi
if [ -f "${KP_STATE_DIR}/cgroups" ]; then
  _cg="$(awk '$1 == "resultat" { print $2 }' "${KP_STATE_DIR}/cgroups")"
  _cgd="$(awk '$1 == "date" { print $2 " " $3 }' "${KP_STATE_DIR}/cgroups")"
  if [ "$_cg" = "ok" ]; then
    echo "  Limites par site       : effectives (contrôlé le ${_cgd})"
  else
    echo "  Limites par site       : ${C_YELLOW}non effectives${C_RESET} (contrôlé le ${_cgd}, détail : kouziaphpctl cgroups)"
  fi
else
  echo "  Limites par site       : pas encore contrôlées (kouziaphpctl cgroups)"
fi
if [ -f "${KP_STATE_DIR}/last-upgrade" ]; then
  _last="$(cat "${KP_STATE_DIR}/last-upgrade")"
  _days="$(( ($(date +%s) - $(date -d "$_last" +%s 2>/dev/null || date +%s)) / 86400 ))"
  if [ "$_days" -gt 14 ]; then
    echo "  Mises à jour           : ${C_RED}ALERTE${C_RESET} dernière le ${_last}, il y a ${_days} jours (kouziaphpctl upgrade)"
  else
    echo "  Mises à jour           : dernière le ${_last}"
  fi
else
  echo "  Mises à jour           : ${C_YELLOW}jamais lancées${C_RESET} (kouziaphpctl upgrade)"
fi
