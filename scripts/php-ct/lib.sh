# Fonctions partagées des scripts du CT Alpine des sites PHP (« kouziaphp », docs/cadrage.md section 11).
# sh POSIX, BusyBox ash. Chargé par « . lib.sh » : ne s'exécute pas seul. Copié des scripts du hub
# (scripts/alpine/lib.sh) pour ce qui est commun ; préfixe KP_ pour ne rien mélanger.
#
# Ce CT exécute le code des clients. Rien de sensible du hub n'y entre : ni jeton Cloudflare de l'API, ni clés
# de licence, ni base du hub. Seuls le jeton de SON tunnel et, au lot P2, le secret de l'agent y sont posés.
# shellcheck disable=SC2034

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

KP_ETC_DIR="${KP_ETC_DIR:-/etc/kouziaphp}"
KP_LIB_DIR="/usr/local/lib/kouziaphp"
KP_LOG_DIR="${KP_LOG_DIR:-/var/log/kouziaphp}"
KP_STATE_DIR="/var/lib/kouziaphp"
KP_SITES_DIR="${KP_SITES_DIR:-/srv/sites}"
# Comptes des sites (un par site, lot P3) : UID dans cette plage réservée, que le pare-feu du CT filtre en sortie.
# Chaque compte garde son groupe à lui : un groupe commun ouvrirait les fichiers d'un site aux autres.
KP_SITE_UID_MIN=20000
KP_SITE_UID_MAX=29999
KP_TUNNEL_SERVICE="cloudflared"
KP_TUNNEL_TOKEN_FILE="${KP_ETC_DIR}/tunnel.token"
KP_CLOUDFLARED_BIN=/usr/local/bin/cloudflared
KP_FIREWALL_SERVICE="kouziaphp-firewall"
KP_NFT_FILE="${KP_ETC_DIR}/nftables.nft"
KP_LOCK_FILE="${KP_LOCK_FILE:-/run/kouziaphp-ops.lock}"
# nginx n'écoute qu'en local : seul cloudflared (même CT) le joint. Les blocs des sites (lot P3) vont dans ce dossier.
KP_NGINX_PORT=8080
KP_NGINX_SITES_DIR="/etc/nginx/kouziaphp-sites"
# Agent piloté par le hub (lot P2) : port réservé dès maintenant pour le pare-feu Proxmox.
KP_AGENT_PORT=8790
# Capteur d'e-mails (lot P5) : seule adresse locale que les comptes des sites peuvent joindre.
KP_MAIL_PORT=1025
# PHP : version par défaut des sites (décision du 24/10/2026, MyTakumi en 8.3) et extensions installées.
KP_PHP_DEFAULT="83"
KP_PHP_EXTENSIONS="ctype curl exif fileinfo gd intl mbstring opcache openssl pdo pdo_mysql pdo_sqlite session sodium tokenizer xml zip"
# Alpine minimum : 3.22 fournit php82, php83 et php84 (dépôt community, vérifié le 24/10/2026).
KP_ALPINE_MIN="3.22"

if [ -t 1 ]; then
  _esc="$(printf '\033')"
  C_RESET="${_esc}[0m"
  C_BOLD="${_esc}[1m"
  C_GREEN="${_esc}[32m"
  C_YELLOW="${_esc}[33m"
  C_RED="${_esc}[31m"
  C_CYAN="${_esc}[36m"
else
  C_RESET="" C_BOLD="" C_GREEN="" C_YELLOW="" C_RED="" C_CYAN=""
fi

log()  { printf '%s\n' "${C_CYAN}[$(date '+%H:%M:%S')]${C_RESET} $*"; }
ok()   { printf '%s\n' "${C_GREEN}OK${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}ATTENTION${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}ERREUR${C_RESET} $*" >&2; exit 1; }
title() { printf '\n%s\n' "${C_BOLD}== $* ==${C_RESET}"; }

trap_signals() {
  trap 'exit 130' INT TERM HUP
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "À lancer en root (dans la console du CT)."
}

require_alpine() {
  [ -f /etc/alpine-release ] || die "Ce script est fait pour Alpine Linux (fichier /etc/alpine-release absent)."
}

# Version d'Alpine (« 3.22.2 ») ramenée à « 3.22 » ; comparée numériquement à KP_ALPINE_MIN.
alpine_branch() {
  cut -d. -f1,2 /etc/alpine-release 2>/dev/null
}

alpine_at_least() {
  _have="$(alpine_branch)"
  [ -n "$_have" ] || return 1
  awk -v a="$_have" -v b="$1" 'BEGIN { split(a, x, "."); split(b, y, "."); exit !((x[1] > y[1]) || (x[1] == y[1] && x[2] >= y[2])) }'
}

service_exists() {
  [ -f "/etc/init.d/$1" ]
}

service_running() {
  service_exists "$1" && rc-service "$1" status >/dev/null 2>&1
}

# Services lancés pendant une opération : sans le descripteur 9, sinon le démon garde le verrou à vie.
rc_service() {
  rc-service "$@" 9>&-
}

# Un seul kouziaphpctl à la fois (installation, mise à jour) ; hérité par les scripts enfants.
ops_lock() {
  if [ "${KP_OPS_LOCKED:-0}" = "1" ]; then
    return 0
  fi
  if [ -L "$KP_LOCK_FILE" ]; then
    rm -f "$KP_LOCK_FILE"
  fi
  exec 9>>"$KP_LOCK_FILE"
  chmod 600 "$KP_LOCK_FILE" 2>/dev/null || true
  flock -n 9 || die "Une autre opération kouziaphpctl est en cours. Réessayer quand elle sera terminée."
  KP_OPS_LOCKED=1
  export KP_OPS_LOCKED
}

# ask_secret <variable> <question> : saisie masquée, rien n'est affiché ni journalisé.
ask_secret() {
  printf '  %s : ' "$2"
  _sec=""
  if [ -t 0 ]; then
    stty -echo 2>/dev/null || true
    IFS= read -r _sec || _sec=""
    stty echo 2>/dev/null || true
    printf '\n'
  else
    IFS= read -r _sec || _sec=""
  fi
  eval "$1=\$_sec"
}

# Paquet présent dans les dépôts configurés (après apk update).
apk_available() {
  apk search -x "$1" 2>/dev/null | grep -q .
}

# Versions de PHP installées, « 82 83 84 » (paquets phpXY-fpm présents). Code 0 toujours : appelée dans
# « $(...) » sous set -e, un dernier test faux arrêterait le script (status.sh, recette du 25/10/2026).
php_versions_installed() {
  for _v in 82 83 84 85; do
    if [ -x "/usr/sbin/php-fpm${_v}" ]; then printf '%s ' "$_v"; fi
  done
}

dns_servers() {
  awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf 2>/dev/null
}
