#!/bin/sh
# Pare-feu du CT des sites PHP, seconde couche (docs/cadrage.md, section 11.2). La première est le pare-feu
# Proxmox sur l'interface du CT, que le CT ne peut pas modifier (README, section 9).
#
# Seuls les comptes des sites (UID KP_SITE_UID_MIN à KP_SITE_UID_MAX) sont filtrés, en sortie :
#   - en local, seul le capteur d'e-mails (127.0.0.1:KP_MAIL_PORT) ; ni l'agent, ni nginx, ni rien d'autre ;
#   - DNS vers les serveurs du CT ;
#   - rien vers le réseau local (box, NAS, ERP, hub) ;
#   - SMTP (25, 465, 587) jamais : les e-mails sont capturés (11.6) ;
#   - IMAP (993) seulement pour les comptes de l'ensemble « imap_open » (relève activée pour ce site) ;
#   - HTTPS (443) sauf pour les comptes de l'ensemble « https_closed » ; tout le reste refusé.
# Les ensembles sont remplis par l'agent (lot P2) depuis /etc/kouziaphp/net/ ; vides à l'installation.
#
# Usage : sh firewall.sh   (code 0 : posé ; 1 : refusé par le CT)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

require_root
command -v nft >/dev/null 2>&1 || die "nftables absent (apk add nftables)."

_net="${KP_ETC_DIR}/net"
mkdir -p "$_net"
chmod 700 "$_net"
touch "${_net}/imap-open" "${_net}/https-closed"

# Liste d'UID d'un fichier (un par ligne), dans la plage des sites seulement, au format d'un ensemble nft.
uid_elements() {
  awk -v lo="$KP_SITE_UID_MIN" -v hi="$KP_SITE_UID_MAX" '/^[0-9]+$/ && $1 >= lo && $1 <= hi { printf "%s%s", sep, $1; sep = ", " }' "$1"
}

_v4=""
_v6=""
for _ns in $(dns_servers); do
  case "$_ns" in
    *:*) _v6="${_v6:+${_v6}, }${_ns}" ;;
    *.*) _v4="${_v4:+${_v4}, }${_ns}" ;;
  esac
done
# Ensemble nft : « elements = { ... }; » seulement s'il a des membres (un ensemble vide n'en a pas).
set_elements() {
  if [ -n "$1" ]; then
    printf 'elements = { %s }; ' "$1"
  fi
}
_imap="$(set_elements "$(uid_elements "${_net}/imap-open")")"
_closed="$(set_elements "$(uid_elements "${_net}/https-closed")")"

_tmp="$(mktemp "${KP_NFT_FILE}.XXXXXX")"
{
  echo "# CT des sites PHP : sortie réseau des comptes des sites. Généré par kouziaphpctl, ne pas modifier."
  echo "table inet kouziaphp"
  echo "delete table inet kouziaphp"
  echo "table inet kouziaphp {"
  echo "  set imap_open { typeof meta skuid; ${_imap}}"
  echo "  set https_closed { typeof meta skuid; ${_closed}}"
  echo "  chain output {"
  echo "    type filter hook output priority filter; policy accept;"
  echo "    meta skuid ${KP_SITE_UID_MIN}-${KP_SITE_UID_MAX} jump sites"
  echo "  }"
  echo "  chain sites {"
  echo "    ct state established,related accept"
  echo "    oif \"lo\" ip daddr 127.0.0.1 tcp dport ${KP_MAIL_PORT} accept"
  echo "    oif \"lo\" counter drop"
  if [ -n "$_v4" ]; then
    echo "    ip daddr { ${_v4} } meta l4proto { tcp, udp } th dport 53 accept"
  fi
  if [ -n "$_v6" ]; then
    echo "    ip6 daddr { ${_v6} } meta l4proto { tcp, udp } th dport 53 accept"
  fi
  echo "    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } counter drop"
  echo "    ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8 } counter drop"
  echo "    tcp dport { 25, 465, 587 } counter drop"
  echo "    meta skuid @imap_open tcp dport 993 accept"
  echo "    meta skuid @https_closed counter drop"
  echo "    tcp dport 443 accept"
  echo "    counter drop"
  echo "  }"
  echo "}"
} > "$_tmp"
chmod 600 "$_tmp"
mv -f "$_tmp" "$KP_NFT_FILE"

# Chargée par le service OpenRC kouziaphp-firewall, pas par « nft -f » direct : OpenRC le sait démarré (état lu par
# l'agent et status) et le relance au démarrage du CT. Pas le service « nftables » d'Alpine : son
# /etc/nftables.nft commence par « flush ruleset » et refuse toute entrée (le port de l'agent avec).
rc-update add "$KP_FIREWALL_SERVICE" default >/dev/null 2>&1 || true
if rc_service "$KP_FIREWALL_SERVICE" restart >/dev/null 2>&1 && nft list table inet kouziaphp 2>/dev/null | grep -q "jump sites"; then
  ok "Pare-feu du CT posé (table inet kouziaphp) : comptes des sites limités au DNS, à HTTPS et au capteur d'e-mails."
  exit 0
fi
rc-update del "$KP_FIREWALL_SERVICE" default >/dev/null 2>&1 || true
warn "Le CT refuse nftables (CT non privilégié sans droit réseau, ou module absent)."
exit 1
