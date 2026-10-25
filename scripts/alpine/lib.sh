# Fonctions partagées des scripts du CT Alpine du hub (sh POSIX, BusyBox ash).
# Chargé par « . lib.sh » : ne s'exécute pas seul.
# Réglages des scripts (préfixe KH_, jamais dans le .env de l'application) :
#   KH_APP_DIR, KH_USER, KH_GROUP, KH_BACKUP_DIR, KH_BACKUP_KEEP, KH_REPO_URL, KH_REPO_BRANCH.
#
# Modèle de droits (matrice complète dans le README, « Droits des fichiers ») :
#   - tout ce que root exécute ou lit pour décider appartient à root et n'est pas modifiable par le
#     compte du service : sources, .git, node_modules, interface compilée, .env (root:kouziahub 640),
#     état des mises à jour, copie des scripts dans /usr/local/lib/kouziahub ;
#   - le compte du service n'écrit que dans le dossier des données (HUB_DATA_DIR), son dossier
#     personnel /var/lib/kouziahub et ses journaux ;
#   - root ne lance jamais un fichier modifiable par le compte, et ne suit jamais un lien qu'il a pu poser.
# shellcheck disable=SC2034

# crond lance les scripts avec un PATH réduit ; GNU tar (/usr/bin) doit passer avant celui de BusyBox.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

KH_APP_DIR="${KH_APP_DIR:-/opt/kouziahub}"
KH_USER="${KH_USER:-kouziahub}"
KH_GROUP="${KH_GROUP:-kouziahub}"
KH_HOME_DIR="/var/lib/kouziahub"
KH_SERVICE="kouziahub"
KH_TUNNEL_SERVICE="cloudflared"
KH_FIREWALL_SERVICE="kouziahub-firewall"
KH_LOG_DIR="${KH_LOG_DIR:-/var/log/kouziahub}"
KH_ETC_DIR="${KH_ETC_DIR:-/etc/kouziahub}"
# Copie des scripts lancés par root (hubctl, sauvegarde, OpenRC) : root, lecture seule.
KH_LIB_DIR="/usr/local/lib/kouziahub"
KH_BACKUP_DIR="${KH_BACKUP_DIR:-/var/backup/kouziahub}"
KH_EXPORT_DIR="${KH_BACKUP_DIR}/export"
# Nombre de sauvegardes gardées (les plus récentes). Chacune contient tous les fichiers des sites.
KH_BACKUP_KEEP="${KH_BACKUP_KEEP:-14}"
KH_PASSPHRASE_FILE="${KH_ETC_DIR}/backup-pass"
KH_STATE_DIR="${KH_STATE_DIR:-${KH_APP_DIR}/.deploy-state}"
KH_ENV_FILE="${KH_APP_DIR}/.env"
KH_TUNNEL_TOKEN_FILE="${KH_ETC_DIR}/tunnel.token"
# Jeton GitHub en lecture seule (dépôt privé) : root:root 600, lu seulement par git_fetch_origin.
KH_GITHUB_TOKEN_FILE="${KH_ETC_DIR}/github-token"
# Clés privées Ed25519 des licences, une par logiciel (docs/licences-logiciels.md, section 4) : <slug>-ed25519.pem,
# root:kouziahub 640, jamais remplacées. Tracebay garde son fichier historique, de la même forme.
KH_TRACEBAY_KEY_FILE="${KH_ETC_DIR}/tracebay-ed25519.pem"
KH_LICENCE_KEY_GLOB="*-ed25519.pem"
KH_LOCK_FILE="${KH_LOCK_FILE:-/run/kouziahub-ops.lock}"
KH_REPO_URL="${KH_REPO_URL:-https://github.com/K0uzia/KouziaHub.git}"
KH_REPO_BRANCH="${KH_REPO_BRANCH:-main}"
KH_DEFAULT_PORT=3000
KH_NODE_MIN=22
# Dernier correctif de sécurité par ligne maintenue (21/10/2026, CVE-2026-111497, Brotli). Même liste que « engines ».
KH_NODE_FIXED="22.23.4 24.22.1 26.12.1"
KH_CLOUDFLARED_BIN=/usr/local/bin/cloudflared
# Chromium des vignettes et de la mesure de vitesse : compte dédié, sans accès au .env ni aux données.
KH_CHROMIUM_USER="kouziahub-chromium"
KH_CHROMIUM_HOME="/var/lib/kouziahub-chromium"
KH_CHROMIUM_LAUNCH="${KH_LIB_DIR}/chromium-launch"
KH_DOAS_CONF="/etc/doas.d/kouziahub-chromium.conf"
KH_NFT_FILE="${KH_ETC_DIR}/nftables.nft"

# Alpine = musl : sans cela, npm peut installer des binaires glibc (Bus error au build).
if [ -f /etc/alpine-release ]; then
  export npm_config_libc=musl
fi

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

# Sous ash, le piège EXIT n'est pas garanti sur un signal : chaque signal passe par exit, donc par EXIT.
trap_signals() {
  trap 'exit 130' INT TERM HUP
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "À lancer en root (dans la console du CT)."
}

require_alpine() {
  [ -f /etc/alpine-release ] || die "Ce script est fait pour Alpine Linux (fichier /etc/alpine-release absent)."
}

require_cmd() {
  for _c in "$@"; do
    command -v "$_c" >/dev/null 2>&1 || die "Commande introuvable : $_c (relancer « hubctl install »)."
  done
}

# Arrêt AVANT toute modification si Node est trop ancien : une mise à jour ne reste jamais à moitié faite.
require_node_min() {
  _major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$_major" -lt "$KH_NODE_MIN" ]; then
    printf '%s\n' "${C_RED}ERREUR${C_RESET} Node.js ${KH_NODE_MIN} ou plus est nécessaire (installé : $(node -v 2>/dev/null || echo aucun)). Rien n'a été modifié." >&2
    printf '%s\n' "  Corriger : apk add --no-cache nodejs-current npm   (ou passer le CT en Alpine 3.21 ou plus)" >&2
    exit 1
  fi
}

# Vrai si le Node installé n'a pas le dernier correctif de sécurité connu (KH_NODE_FIXED : une version par ligne
# maintenue). Une ligne absente de la liste et plus ancienne que la plus récente (impaire, ou en fin de vie) n'a
# reçu aucun correctif : elle compte comme vulnérable.
node_vulnerable() {
  _v="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [ -n "$_v" ] || return 0
  _maj="${_v%%.*}"
  _top=0
  for _f in $KH_NODE_FIXED; do
    [ "${_f%%.*}" -gt "$_top" ] && _top="${_f%%.*}"
    if [ "${_f%%.*}" = "$_maj" ]; then
      _vr="${_v#*.}" _fr="${_f#*.}"
      _vmin="${_vr%%.*}" _fmin="${_fr%%.*}"
      _vpat="${_vr#*.}" _fpat="${_fr#*.}"
      [ "$_vmin" -lt "$_fmin" ] && return 0
      [ "$_vmin" -gt "$_fmin" ] && return 1
      [ "${_vpat%%[!0-9]*}" -lt "$_fpat" ]
      return $?
    fi
  done
  [ "$_maj" -le "$_top" ]
}

# Dernière version publiée de chaque ligne corrigée, pour les messages.
node_fixed_text() {
  printf '%s' "$KH_NODE_FIXED" | sed 's/ / ou /g'
}

# Tente d'amener Node au correctif (paquets nodejs déjà installés seulement), puis le dit clairement.
# Code 1 : Node reste vulnérable (Alpine ne fournit pas encore la version corrigée).
ensure_node_patched() {
  node_vulnerable || return 0
  log "Node $(node -v 2>/dev/null) a une faille corrigée en $(node_fixed_text) : mise à jour par apk..."
  _pkgs=""
  for _p in nodejs nodejs-current npm; do
    apk info -e "$_p" >/dev/null 2>&1 && _pkgs="$_pkgs $_p"
  done
  # Liste vide (Node hors apk) : surtout pas « apk upgrade » seul, qui mettrait tout le système à jour.
  if [ -n "$_pkgs" ]; then
    apk update >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    apk upgrade --no-cache $_pkgs >/dev/null 2>&1 || true
  fi
  if node_vulnerable; then
    printf '%s\n' "${C_RED}ALERTE${C_RESET} Node $(node -v 2>/dev/null || echo absent) reste vulnérable : Alpine ne fournit pas encore $(node_fixed_text) (version proposée : $(apk policy nodejs 2>/dev/null | sed -n 's/^  \([0-9][^:]*\):.*/\1/p' | head -n 1))." >&2
    printf '%s\n' "  Relancer « hubctl update » dès que le paquet arrive (apk policy nodejs), ou passer le CT à une branche d'Alpine qui l'a." >&2
    return 1
  fi
  ok "Node $(node -v) : correctif de sécurité appliqué (redémarrage du hub pour le charger)."
}

# Mise à jour complète du système dans la branche d'Alpine installée (/etc/apk/repositories n'est jamais
# modifié : pas de changement de version). Paquets listés à l'écran et dans system-upgrade.log ; services
# du CT dont un paquet a changé relancés. Le hub, lui, est relancé et contrôlé par update.sh.
system_upgrade() {
  log "Système : apk update puis apk upgrade (même version d'Alpine)..."
  if ! apk update >/dev/null 2>&1; then
    warn "apk update a échoué (réseau ou dépôt) : système non mis à jour."
    return 1
  fi
  _list="$(apk version -l '<' 2>/dev/null | sed '1d')"
  if [ -z "$_list" ]; then
    ok "Système déjà à jour."
    return 0
  fi
  _slog="${KH_LOG_DIR}/system-upgrade.log"
  {
    echo "== $(date '+%Y-%m-%d %H:%M:%S') : apk upgrade =="
    printf '%s\n' "$_list"
  } >> "$_slog"
  printf '%s\n' "$_list" | sed 's/^/  /'
  if ! apk upgrade --no-cache >> "$_slog" 2>&1; then
    warn "apk upgrade a échoué : détail dans ${_slog}."
    return 1
  fi
  ok "Système mis à jour ($(printf '%s\n' "$_list" | wc -l | tr -d ' ') paquet(s), liste dans ${_slog})."
  # Les bibliothèques remplacées (musl, openssl, nftables) ne sont chargées qu'au redémarrage d'un service.
  if service_running "$KH_TUNNEL_SERVICE"; then
    log "Tunnel : redémarrage (bibliothèques du système à jour)..."
    rc_service "$KH_TUNNEL_SERVICE" restart >/dev/null 2>&1 || warn "Le tunnel n'a pas redémarré : hubctl logs tunnel."
  fi
  if printf '%s\n' "$_list" | grep -q '^nftables-' && service_exists "$KH_FIREWALL_SERVICE"; then
    rc_service "$KH_FIREWALL_SERVICE" restart >/dev/null 2>&1 || warn "Pare-feu de Chromium non reposé : hubctl status."
  fi
  if printf '%s\n' "$_list" | grep -q '^busybox-'; then
    rc_service crond restart >/dev/null 2>&1 || true
  fi
  if printf '%s\n' "$_list" | grep -q '^chromium-'; then
    echo "  Chromium mis à jour : la prochaine vignette utilise la nouvelle version (aucun service à relancer)."
  fi
}

# Jours restants avant l'expiration du jeton GitHub (date saisie à la pose), vide si inconnue.
# Calcul par Node (déjà requis) : « date -d » de BusyBox ne lit pas tous les formats.
github_token_days_left() {
  _exp="$(state_get github-token-expires)"
  iso_day_ok "$_exp" || return 0
  KH_DAY="$_exp" node -p 'Math.floor((Date.parse(process.env.KH_DAY + "T00:00:00Z") - Date.now()) / 864e5)' 2>/dev/null || true
}

# Vrai si $1 est une date réelle AAAA-MM-JJ (2027-02-30 refusé).
iso_day_ok() {
  printf '%s' "${1:-}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || return 1
  KH_DAY="$1" node -e 'const d = new Date(process.env.KH_DAY + "T00:00:00Z"); process.exit(!isNaN(d) && d.toISOString().slice(0, 10) === process.env.KH_DAY ? 0 : 1)' 2>/dev/null
}

# Données ICU complètes : avec icu-data-en seul, Intl fr-FR de Node retombe sur l'anglais (« € » avant
# le montant, mois en anglais). Idempotent ; icu-data-full remplace icu-data-en.
ensure_icu_full() {
  apk info -e icu-data-full >/dev/null 2>&1 && return 0
  log "Données ICU complètes (dates et montants en français)..."
  if apk add --no-cache icu-data-full >/dev/null 2>&1; then
    ok "icu-data-full installé."
  else
    warn "icu-data-full introuvable : Intl fr-FR reste en anglais (hubctl status)."
    return 1
  fi
}

# Vrai si le Node du système formate un montant en français et connaît l'heure d'été de Paris.
intl_fr_ok() {
  _intl="$(node -p 'new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(1234.5).replace(/[\u00a0\u202f]/g," ")+"|"+new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",hour:"2-digit",hourCycle:"h23"}).format(Date.UTC(2026,6,15,12))' 2>/dev/null || true)"
  [ "$_intl" = "1 234,50 €|14" ]
}

disk_guard() {
  # disk_guard <chemin> <Mo minimum>
  _avail="$(df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ "${_avail:-0}" -lt "$2" ]; then
    die "Pas assez de place sur le disque pour $1 (${_avail:-0} Mo libres, il en faut $2). Agrandir le disque du CT dans Proxmox."
  fi
}

# --- Verrou des opérations (mise à jour, restauration, installation, sauvegarde) ---

# ops_lock refuse|cron : un seul à la fois. « refuse » : refus avec un message. « cron » : la sauvegarde
# quotidienne saute son tour (ligne au journal, code 0). Le verrou est hérité par les scripts enfants
# (KH_OPS_LOCKED) et par « exec » (descripteur 9 gardé ouvert).
ops_lock() {
  if [ "${KH_OPS_LOCKED:-0}" = "1" ]; then
    return 0
  fi
  # /run appartient à root : un lien posé là par un autre compte est impossible ; on vérifie quand même.
  if [ -L "$KH_LOCK_FILE" ]; then
    rm -f "$KH_LOCK_FILE"
  fi
  exec 9>>"$KH_LOCK_FILE"
  chmod 600 "$KH_LOCK_FILE" 2>/dev/null || true
  if ! flock -n 9; then
    if [ "${1:-refuse}" = "cron" ]; then
      return 2
    fi
    _holders="$(exec 9>&-; lock_holders)"
    printf '%s\n' "${C_RED}ERREUR${C_RESET} Une autre opération du hub est en cours (mise à jour, restauration ou sauvegarde)." >&2
    if [ -n "$_holders" ]; then
      printf '%s\n' "  Verrou ${KH_LOCK_FILE} tenu par :" >&2
      printf '%s\n' "$_holders" | sed 's/^/    /' >&2
      if printf '%s\n' "$_holders" | grep -Eqv "$KH_OPS_SCRIPTS_RE"; then
        printf '%s\n' "  Un service a hérité du verrou (ce n'est pas une opération hubctl) : le relancer depuis un shell neuf," >&2
        printf '%s\n' "  par exemple « rc-service kouziahub restart » (hub, node), « rc-service cloudflared restart » ou « rc-service crond restart »." >&2
        printf '%s\n' "  Ne jamais supprimer ${KH_LOCK_FILE} : le verrou resterait tenu par ce processus." >&2
      else
        printf '%s\n' "  Réessayer quand elle sera terminée (hubctl logs pour la suivre)." >&2
      fi
    else
      printf '%s\n' "  Réessayer dans quelques minutes." >&2
    fi
    exit 1
  fi
  KH_OPS_LOCKED=1
  export KH_OPS_LOCKED
}

# Scripts d'opération (détenteurs légitimes du verrou), pour distinguer un service qui l'a hérité par erreur.
KH_OPS_SCRIPTS_RE='(update|install|restore|backup|configure)\.sh|hubctl'

# Processus qui ont le fichier du verrou ouvert (donc le tiennent : un descripteur hérité partage le verrou),
# une ligne chacun : PID, nom, démarrage, commande. Sous verrou, l'appeler en « $(exec 9>&-; lock_holders) » pour ne pas se compter soi-même.
lock_holders() {
  for _fd in /proc/[0-9]*/fd/*; do
    [ "$(readlink "$_fd" 2>/dev/null)" = "$KH_LOCK_FILE" ] || continue
    _pid="${_fd#/proc/}"
    _pid="${_pid%%/*}"
    printf '%s\n' "$_pid"
  done 2>/dev/null | sort -un | while IFS= read -r _pid; do
    [ "$_pid" != "$$" ] || continue
    # Processus déjà terminé depuis la lecture de son descripteur : ignoré.
    [ -r "/proc/${_pid}/cmdline" ] || continue
    _name="$(cat "/proc/${_pid}/comm" 2>/dev/null || echo '?')"
    _since="$(date -d "@$(stat -c %Y "/proc/${_pid}" 2>/dev/null || echo 0)" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
    _cmd="$(tr '\0' ' ' < "/proc/${_pid}/cmdline" 2>/dev/null | cut -c1-120)"
    printf 'PID %s (%s), depuis %s : %s\n' "$_pid" "$_name" "$_since" "$_cmd"
  done
}

# Services lancés pendant une opération : sans le descripteur 9, sinon le démon garde le verrou à vie.
rc_service() {
  rc-service "$@" 9>&-
}

# --- Questions (français simple, valeurs par défaut sûres) ---

# ask <variable> <question> [défaut]
ask() {
  if [ -n "${3:-}" ]; then
    printf '  %s [%s] : ' "$2" "$3"
  else
    printf '  %s : ' "$2"
  fi
  _ans=""
  IFS= read -r _ans || _ans=""
  [ -n "$_ans" ] || _ans="${3:-}"
  eval "$1=\$_ans"
}

# ask_secret <variable> <question> : saisie masquée, rien n'est affiché ni journalisé.
ask_secret() {
  printf '  %s : ' "$2"
  _sec=""
  if [ -t 0 ]; then
    stty -echo 2>/dev/null || true
    trap 'stty echo 2>/dev/null; exit 130' INT TERM HUP
    IFS= read -r _sec || _sec=""
    stty echo 2>/dev/null || true
    trap_signals
    printf '\n'
  else
    IFS= read -r _sec || _sec=""
  fi
  _sec="$(printf '%s' "$_sec" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  eval "$1=\$_sec"
  _sec=""
}

# confirm <question> [o|n] : vrai si oui. Défaut « n » (le plus sûr).
confirm() {
  if [ "${2:-n}" = "o" ]; then _hint="[O/n]"; else _hint="[o/N]"; fi
  printf '  %s %s : ' "$1" "$_hint"
  _ans=""
  IFS= read -r _ans || _ans=""
  [ -n "$_ans" ] || _ans="${2:-n}"
  case "$_ans" in
    o|O|oui|Oui|OUI|y|Y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

pause_enter() {
  printf '\n  Entrée pour continuer... '
  IFS= read -r _ans || true
}

# --- Fichier .env (jamais affiché) ---

# env_get <CLÉ> [défaut] : dernière valeur, guillemets retirés.
env_get() {
  _line=""
  if [ -f "$KH_ENV_FILE" ]; then
    _line="$(grep -E "^$1=" "$KH_ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  fi
  if [ -z "$_line" ]; then
    printf '%s' "${2:-}"
    return 0
  fi
  _val="${_line#*=}"
  _val="$(printf '%s' "$_val" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"
  [ -n "$_val" ] || _val="${2:-}"
  printf '%s' "$_val"
}

# env_has <CLÉ> : vrai si la clé a une valeur non vide.
env_has() {
  [ -n "$(env_get "$1")" ]
}

# env_set <CLÉ> <valeur> : remplace ou ajoute la ligne. La valeur passe par l'environnement
# d'awk (jamais en argument, donc jamais visible dans la liste des processus).
env_set() {
  [ -f "$KH_ENV_FILE" ] || die "Fichier .env introuvable : $KH_ENV_FILE (lancer « hubctl install »)."
  # shellcheck disable=SC1003
  case "$2" in
    *'"'*|*'\'*|*'$'*|*'`'*) die "Valeur refusée pour $1 : caractère interdit." ;;
  esac
  _tmp="$(mktemp "${KH_ENV_FILE}.XXXXXX")"
  chmod 600 "$_tmp"
  KH_K="$1" KH_V="$2" awk '
    BEGIN { k = ENVIRON["KH_K"]; v = ENVIRON["KH_V"]; done = 0 }
    $0 ~ ("^" k "=") { if (!done) { print k "=\"" v "\""; done = 1 }; next }
    { print }
    END { if (!done) print k "=\"" v "\"" }
  ' "$KH_ENV_FILE" > "$_tmp"
  mv -f "$_tmp" "$KH_ENV_FILE"
  env_fix_perms
}

# .env : root:kouziahub 640. Le service le lit (groupe) mais ne peut pas le modifier : il ne doit pas
# pouvoir changer sa propre configuration (NODE_ENV, Access, HUB_DATA_DIR que root utilise). Seuls
# root, hubctl et les scripts lancés en root par hubctl (push-keys, veille deploy) l'écrivent.
env_fix_perms() {
  [ -L "$KH_ENV_FILE" ] && rm -f "$KH_ENV_FILE"
  [ -f "$KH_ENV_FILE" ] || return 0
  chown root:"$KH_GROUP" "$KH_ENV_FILE"
  chmod 640 "$KH_ENV_FILE"
}

api_port() {
  env_get API_PORT "$KH_DEFAULT_PORT"
}

health_url() {
  printf 'http://127.0.0.1:%s/api/health' "$(api_port)"
}

# Dossier des fichiers des sites (HUB_DATA_DIR du .env). Root y change des droits : le chemin est
# limité à une liste blanche, jamais un lien symbolique, jamais le dossier du code lui-même.
data_dir() {
  _dd="$(env_get HUB_DATA_DIR "${KH_APP_DIR}/data")"
  case "$_dd" in
    *..*|*' '*) die "HUB_DATA_DIR refusé : $_dd" ;;
    "${KH_APP_DIR}/"?*|/var/lib/kouziahub/?*|/srv/kouziahub/?*) ;;
    *) die "HUB_DATA_DIR doit être dans ${KH_APP_DIR}/, /var/lib/kouziahub/ ou /srv/kouziahub/ (actuel : $_dd)." ;;
  esac
  case "$_dd" in
    "${KH_APP_DIR}/node_modules"*|"${KH_APP_DIR}/apps"*|"${KH_APP_DIR}/scripts"*|"${KH_APP_DIR}/.git"*|"${KH_APP_DIR}/prisma"*|"$KH_STATE_DIR"*)
      die "HUB_DATA_DIR ne peut pas être un dossier du code : $_dd" ;;
  esac
  if [ -L "$_dd" ]; then
    die "HUB_DATA_DIR est un lien symbolique : refusé ($_dd)."
  fi
  printf '%s' "${_dd%/}"
}

# Chemin de la base SQLite, tiré de DATABASE_URL (relatif au dossier prisma/, comme Prisma).
# Elle doit se trouver dans le dossier des données.
db_path() {
  _url="$(env_get DATABASE_URL "file:../data/hub.db")"
  _p="${_url#file:}"
  _p="${_p%%\?*}"
  case "$_p" in
    /*) ;;
    *) _p="${KH_APP_DIR}/prisma/${_p}" ;;
  esac
  _d="$(dirname "$_p")"
  if [ -d "$_d" ]; then
    _d="$(cd -P "$_d" && pwd)"
  fi
  _p="${_d}/$(basename "$_p")"
  _dd="$(data_dir)" || exit 1
  case "$_p" in
    "$_dd"/*) ;;
    *) die "La base ($_p) doit être dans le dossier des données ($_dd)." ;;
  esac
  printf '%s' "$_p"
}

# --- Exécution : compte du service ou root, jamais du code modifiable par le compte en root ---

# Code du dépôt (root:root, lecture seule pour le compte) exécuté SOUS LE COMPTE DU SERVICE :
# tout ce qui écrit la base (migrations, compte, double authentification).
run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    su -s /bin/sh "$KH_USER" -c "export npm_config_libc=musl HOME='${KH_HOME_DIR}'; cd '${KH_APP_DIR}' && $*"
  else
    sh -c "cd '${KH_APP_DIR}' && $*"
  fi
}

# Code du dépôt exécuté EN ROOT (npm ci, prisma generate, build, scripts qui écrivent le .env) :
# seulement après fix_ownership, qui garantit que le compte du service n'a pu le modifier.
run_as_root() {
  require_root
  ownership_ok || die "Le code n'appartient pas à root : lancer « hubctl update » (reprise des droits) avant."
  sh -c "export npm_config_libc=musl; cd '${KH_APP_DIR}' && $*"
}

# Vrai si aucun fichier du code (hors données et .env) n'est modifiable par le compte du service.
# Une fois le code à root, le compte ne peut plus le reprendre (seul root change un propriétaire) :
# le résultat positif est gardé pour la durée du processus.
ownership_ok() {
  [ "${KH_OWNERSHIP_OK:-0}" = "1" ] && return 0
  _data="$(data_dir)" || exit 1
  [ "$(stat -c %u "$KH_APP_DIR")" = "0" ] || return 1
  _bad="$(find "$KH_APP_DIR" -path "$_data" -prune -o -path "$KH_ENV_FILE" -prune -o \( ! -user root -o \( ! -type l \( -perm -020 -o -perm -002 \) \) \) -print 2>/dev/null | head -n 1)"
  [ -z "$_bad" ] || return 1
  KH_OWNERSHIP_OK=1
}

# Reprise des droits, idempotente : installation neuve, mise à jour, ancienne installation où le
# compte du service possédait le code. Liens symboliques jamais suivis (-h, find sans -L).
fix_ownership() {
  require_root
  _data="$(data_dir)" || exit 1
  log "Droits des fichiers : code à root, données au compte du service..."
  find "$KH_APP_DIR" -path "$_data" -prune -o -exec chown -h root:root {} + 2>/dev/null
  # Personne d'autre que root n'écrit dans le code ; aucun bit setuid ou setgid.
  find "$KH_APP_DIR" -path "$_data" -prune -o ! -type l -exec chmod go-w,ug-s {} + 2>/dev/null
  chmod 755 "$KH_APP_DIR"
  # Crochets git d'une ancienne installation : jamais exécutés (core.hooksPath), retirés quand même.
  if [ -d "${KH_APP_DIR}/.git/hooks" ]; then
    find "${KH_APP_DIR}/.git/hooks" -mindepth 1 -maxdepth 1 ! -name '*.sample' -exec rm -rf {} + 2>/dev/null || true
  fi
  mkdir -p "$KH_STATE_DIR"
  chown -h root:root "$KH_STATE_DIR"
  chmod 755 "$KH_STATE_DIR"
  env_fix_perms
  fix_data_perms
  fix_service_dirs
  KH_OWNERSHIP_OK=0
  ownership_ok || die "Reprise des droits incomplète : un fichier du code reste modifiable par le compte du service."
}

fix_data_perms() {
  _data="$(data_dir)" || exit 1
  mkdir -p "$_data"
  chown -hR "${KH_USER}:${KH_GROUP}" "$_data"
  chmod 750 "$_data"
}

# Dossiers propres au compte du service et dossiers de root (aucun n'est partagé).
fix_service_dirs() {
  mkdir -p "$KH_HOME_DIR" "$KH_LOG_DIR" "$KH_ETC_DIR" "$KH_BACKUP_DIR"
  chown -h "${KH_USER}:${KH_GROUP}" "$KH_HOME_DIR"
  chmod 700 "$KH_HOME_DIR"
  chown -h root:root "$KH_LOG_DIR" "$KH_BACKUP_DIR"
  chmod 755 "$KH_LOG_DIR"
  chmod 700 "$KH_BACKUP_DIR"
  etc_dir_perms
}

# /etc/kouziahub : traversable par le groupe du service (710, sans lister), pour qu'il lise les clés de signature
# des licences (<slug>-ed25519.pem, 640 root:kouziahub, fichiers ordinaires seulement). Tout le reste (jetons du
# tunnel et de GitHub, phrase de passe, règle nftables, fichiers temporaires), lu par root seul, n'a aucun droit de
# groupe ni d'autres : le dossier traversable ne doit rien ouvrir d'autre.
etc_dir_perms() {
  mkdir -p "$KH_ETC_DIR"
  chown -h "root:${KH_GROUP}" "$KH_ETC_DIR"
  chmod 710 "$KH_ETC_DIR"
  find "$KH_ETC_DIR" -mindepth 1 -maxdepth 1 ! \( -type f -name "$KH_LICENCE_KEY_GLOB" \) -exec chmod go-rwx {} +
  find "$KH_ETC_DIR" -mindepth 1 -maxdepth 1 -type f -name "$KH_LICENCE_KEY_GLOB" -exec chown "root:${KH_GROUP}" {} + -exec chmod 640 {} +
}

# Identifiant d'un logiciel (même règle que l'API) : 2 à 32 caractères, minuscules, chiffres, tirets isolés.
valid_software_slug() {
  printf '%s' "$1" | grep -Eqx '[a-z][a-z0-9-]{0,30}[a-z0-9]' && case "$1" in *--*) return 1 ;; esac
}

# licence_key_file <slug> : chemin de la clé privée d'un logiciel.
licence_key_file() {
  printf '%s/%s-ed25519.pem' "$KH_ETC_DIR" "$1"
}

# --- git en root : aucun crochet, aucun programme lancé par la configuration du dépôt ---

# Clés de configuration du dépôt qui lancent un programme : refusées (dépôt d'une ancienne
# installation possédée par le compte du service, à refaire si l'une d'elles apparaît).
git_config_guard() {
  _cfg="${KH_APP_DIR}/.git/config"
  [ -f "$_cfg" ] || return 0
  if grep -Eiq '^[[:space:]]*(\[(filter|diff|merge|credential|url|include|includeif)([[:space:]"]|])|(fsmonitor|hookspath|sshcommand|askpass|pager|editor|gitproxy|textconv|external|helper|command|worktree|sparsecheckout|attributesfile|excludesfile)[[:space:]]*=)' "$_cfg"; then
    die "Configuration git inattendue dans ${_cfg} (peut lancer un programme) : dépôt à refaire (voir le README, « Droits des fichiers »)."
  fi
  if [ -s "${KH_APP_DIR}/.git/info/attributes" ]; then
    die "Fichier ${KH_APP_DIR}/.git/info/attributes inattendu : dépôt à refaire (voir le README)."
  fi
}

git_in_app() {
  git_config_guard
  GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat -c core.editor=true \
    -c core.sshCommand=false -c core.askPass= -c credential.helper= -c diff.external= \
    -c protocol.ext.allow=never -c protocol.file.allow=never -c core.gitProxy= \
    -c "safe.directory=${KH_APP_DIR}" -C "$KH_APP_DIR" "$@"
}

is_git_install() {
  [ -d "${KH_APP_DIR}/.git" ]
}

current_commit() {
  if is_git_install; then
    git_in_app rev-parse --short HEAD 2>/dev/null || echo "?"
  else
    echo "(copie sans git)"
  fi
}

# Aligne le code sur GitHub (source de vérité). .env et data/ ne sont pas suivis par git : conservés.
# L'adresse est celle des scripts (KH_REPO_URL), jamais celle écrite dans la configuration du dépôt.
# git_with_github_token <commande git...> : git_in_app, plus le jeton du dépôt privé s'il est posé.
# Le programme d'identification est écrit ici, jamais lu dans la configuration du dépôt (garde
# [credential] maintenu) ; il lit le fichier root à chaque appel : le jeton n'est ni dans argv, ni dans
# ps, ni dans .git/config.
git_with_github_token() {
  if [ -s "$KH_GITHUB_TOKEN_FILE" ]; then
    git_in_app -c "credential.helper=!f() { [ \"\$1\" = get ] || exit 0; echo username=x-access-token; printf 'password=%s\\n' \"\$(cat '${KH_GITHUB_TOKEN_FILE}')\"; }; f" "$@"
  else
    git_in_app "$@"
  fi
}

github_fetch_hint() {
  if [ -s "$KH_GITHUB_TOKEN_FILE" ]; then
    printf '%s' "Jeton GitHub refusé ou expiré ? En créer un nouveau (README 1.2), puis : hubctl secrets github"
  else
    printf '%s' "Le dépôt est privé : poser le jeton GitHub en lecture seule avec « hubctl secrets github » (README 1.2), puis relancer « hubctl update »"
  fi
}

git_sync_from_origin() {
  _branch="${1:-$KH_REPO_BRANCH}"
  log "Récupération de la dernière version (GitHub, branche ${_branch})..."
  git_with_github_token fetch --no-tags --depth 1 "$KH_REPO_URL" "+${_branch}:refs/remotes/origin/${_branch}" \
    || die "Impossible de joindre GitHub (réseau ou droits d'accès au dépôt). $(github_fetch_hint)."
  git_in_app checkout -f -B "$_branch" "origin/${_branch}" \
    || die "Impossible de placer le code sur origin/${_branch}."
  fix_ownership
  ok "Code à jour : $(current_commit)"
}

file_sha256() {
  if [ -f "$1" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "absent"
  fi
}

# État des mises à jour : dossier root (755), fichiers root ; jamais suivi s'il devient un lien.
state_get() {
  if [ -f "${KH_STATE_DIR}/$1" ] && [ ! -L "${KH_STATE_DIR}/$1" ]; then
    cat "${KH_STATE_DIR}/$1"
  fi
}

state_set() {
  mkdir -p "$KH_STATE_DIR"
  [ ! -L "${KH_STATE_DIR}/$1" ] || rm -f "${KH_STATE_DIR}/$1"
  printf '%s\n' "$2" > "${KH_STATE_DIR}/$1"
}

# --- Étapes de construction ---

# npm ci et build en root, dans un code à root : le compte du service n'a que la lecture.
npm_ci() {
  log "Installation des dépendances (npm ci, quelques minutes)..."
  if ! run_as_root "node scripts/check-lockfile.mjs"; then
    warn "package-lock.json incomplet (souvent un npm install sous Windows) : npm ci risque d'échouer, à corriger dans le dépôt."
  fi
  # --include=dev : tsx (lancement de l'API) et vite (build) sont des dépendances de développement.
  run_as_root "npm ci --include=dev --no-audit --no-fund" || return 1
  state_set package-lock "$(file_sha256 "${KH_APP_DIR}/package-lock.json")"
  ok "Dépendances installées"
}

deps_needed() {
  [ ! -x "${KH_APP_DIR}/node_modules/.bin/tsx" ] && return 0
  [ "$(file_sha256 "${KH_APP_DIR}/package-lock.json")" != "$(state_get package-lock)" ]
}

# Migrations : sous le compte du service (la base lui appartient).
db_deploy() {
  run_as_app "npm run --silent db:deploy"
}

# Client Prisma : écrit dans node_modules, donc en root.
db_generate() {
  run_as_root "npm run --silent db:generate"
}

db_migrate() {
  log "Base de données : migrations puis client Prisma..."
  db_deploy || return 1
  db_generate || return 1
  ok "Base de données à jour"
}

build_web() {
  log "Construction de l'interface (npm run build)..."
  run_as_root "npm run --silent build" || return 1
  ok "Interface construite"
}

# Requête SQLite en lecture, sous le compte du service : root n'ouvre jamais la base lui-même.
sqlite_as_app() {
  _db="$(db_path)" || exit 1
  run_as_app "sqlite3 -readonly -cmd '.timeout 3000' '${_db}' \"$1\""
}

# --- Services OpenRC ---

service_exists() {
  [ -f "/etc/init.d/$1" ]
}

service_running() {
  service_exists "$1" && rc-service "$1" status >/dev/null 2>&1
}

# Cloudflare Access est facultatif (décision du 19/10/2026) : le hub démarre sans, protégé par son login
# (mot de passe et code à 6 chiffres). Sert seulement à l'affichage (hubctl status).
access_configured() {
  env_has CF_ACCESS_TEAM_DOMAIN && env_has CF_ACCESS_AUD
}

stop_app() {
  if service_exists "$KH_SERVICE"; then
    log "Arrêt du hub..."
    rc_service "$KH_SERVICE" stop >/dev/null 2>&1 || true
  fi
  _i=0
  while [ "$_i" -lt 15 ] && pgrep -u "$KH_USER" -f 'apps/api/src/index\.ts' >/dev/null 2>&1; do
    sleep 1
    _i=$((_i + 1))
  done
  if pgrep -u "$KH_USER" -f 'apps/api/src/index\.ts' >/dev/null 2>&1; then
    warn "Processus du hub encore présents : arrêt forcé."
    pkill -u "$KH_USER" -f 'apps/api/src/index\.ts' 2>/dev/null || true
    sleep 1
  fi
}

start_app() {
  rc_service "$KH_SERVICE" start >/dev/null 2>&1 || rc_service "$KH_SERVICE" restart >/dev/null 2>&1 || true
  wait_health
}

restart_app() {
  log "Redémarrage du hub..."
  rc_service "$KH_SERVICE" restart >/dev/null 2>&1 || true
  wait_health
}

# wait_health : attend jusqu'à 90 s {"ok":true} sur /api/health (ouvert sans session).
wait_health() {
  _tries=90
  _url="$(health_url)"
  _i=0
  HEALTH_BODY=""
  while [ "$_i" -lt "$_tries" ]; do
    if HEALTH_BODY="$(curl -4 -fsS --connect-timeout 2 --max-time 5 "$_url" 2>/dev/null)"; then
      case "$HEALTH_BODY" in
        *'"ok":true'*)
          _pending="$(printf '%s' "$HEALTH_BODY" | sed -n 's/.*"pendingMigrations":\([0-9]*\).*/\1/p')"
          if [ -n "$_pending" ] && [ "$_pending" -gt 0 ]; then
            warn "Le hub répond, mais ${_pending} migration(s) de base ne sont pas appliquées (hubctl update)."
          fi
          ok "Le hub répond (${_url})"
          return 0
          ;;
      esac
    fi
    sleep 1
    _i=$((_i + 1))
  done
  warn "Le hub ne répond pas après ${_tries} s (${_url})."
  return 1
}

show_app_errors() {
  printf '\n  Dernières lignes du journal d'"'"'erreurs :\n'
  tail -n 25 "${KH_LOG_DIR}/app.err" 2>/dev/null | sed 's/^/    /' || echo "    (vide)"
}

# --- Copie des scripts lancés par root, hors du code ---

# Copie scripts/alpine (code à root, vérifié) vers /usr/local/lib/kouziahub, remplacée d'un bloc
# (renommage) : un script en cours d'exécution continue de lire l'ancienne version.
install_root_scripts() {
  require_root
  ownership_ok || die "Le code n'appartient pas à root : copie des scripts refusée."
  _src="${KH_APP_DIR}/scripts/alpine"
  _tmp="$(mktemp -d /usr/local/lib/.kouziahub.XXXXXX)"
  cp -R "${_src}/." "${_tmp}/"
  chown -hR root:root "$_tmp"
  find "$_tmp" -type d -exec chmod 755 {} +
  find "$_tmp" -type f -exec chmod 644 {} +
  for _x in hubctl chromium-launch chromium-sandboxed; do
    if [ -f "${_tmp}/${_x}" ]; then chmod 755 "${_tmp}/${_x}"; fi
  done
  rm -rf "${KH_LIB_DIR}.old"
  if [ -d "$KH_LIB_DIR" ]; then mv "$KH_LIB_DIR" "${KH_LIB_DIR}.old"; fi
  mv "$_tmp" "$KH_LIB_DIR"
  rm -rf "${KH_LIB_DIR}.old"
  mkdir -p /usr/local/bin
  ln -sfn "${KH_LIB_DIR}/hubctl" /usr/local/bin/hubctl
}

# Scripts OpenRC réinstallés seulement s'ils diffèrent de la copie root.
install_openrc_scripts() {
  for _svc in "$KH_SERVICE" "$KH_TUNNEL_SERVICE" "$KH_FIREWALL_SERVICE"; do
    _src="${KH_LIB_DIR}/openrc/${_svc}"
    [ -f "$_src" ] || continue
    if [ "$_svc" != "$KH_SERVICE" ] && [ ! -f "/etc/init.d/${_svc}" ]; then
      continue   # posés par « hubctl cloudflare » et « hubctl chromium » seulement
    fi
    if ! cmp -s "$_src" "/etc/init.d/${_svc}"; then
      install -o root -g root -m 755 "$_src" "/etc/init.d/${_svc}"
      ok "Service OpenRC installé : ${_svc}"
    fi
  done
}

install_system_conf() {
  mkdir -p /etc/logrotate.d /etc/periodic/daily
  install -o root -g root -m 644 "${KH_LIB_DIR}/conf/logrotate.kouziahub" /etc/logrotate.d/kouziahub
  cat > /etc/periodic/daily/kouziahub-backup <<EOF
#!/bin/sh
# Sauvegarde quotidienne du hub (crond d'Alpine : /etc/periodic/daily). Journal : ${KH_LOG_DIR}/backup.log
# Copie root des scripts : jamais un fichier modifiable par le compte du service.
exec /bin/sh ${KH_LIB_DIR}/backup.sh --cron --tag quotidienne >/dev/null 2>&1
EOF
  chown root:root /etc/periodic/daily/kouziahub-backup
  chmod 755 /etc/periodic/daily/kouziahub-backup
}

# Dernières sauvegardes complètes, la plus récente d'abord.
list_backups() {
  # Noms horodatés (kouziahub-AAAA-MM-JJ_HHMMSS...) : l'ordre alphabétique est l'ordre chronologique.
  for _b in "$KH_BACKUP_DIR"/kouziahub-*; do
    [ -d "$_b" ] && [ -f "$_b/manifest.txt" ] && printf '%s\n' "$_b"
  done | sort -r
}

# Empreinte du code de la veille Cloudflare : « hubctl update » prévient quand il faut la redéployer.
veille_src_hash() {
  (
    cd "$KH_APP_DIR" || exit 0
    find workers/veille/src workers/veille/schema.sql workers/veille/package.json apps/api/src/lib/monitor/core.ts -type f 2>/dev/null \
      | LC_ALL=C sort | while IFS= read -r _f; do sha256sum "$_f"; done
  ) | sha256sum | awk '{print $1}'
}

# --- Chromium isolé (vignettes, vitesse) ---

chromium_installed() {
  id -u "$KH_CHROMIUM_USER" >/dev/null 2>&1 && [ -f "$KH_DOAS_CONF" ]
}

# Compte dédié, règle doas limitée à une seule commande, enrobages root dans KH_LIB_DIR.
setup_chromium_isolation() {
  require_root
  if ! id -u "$KH_CHROMIUM_USER" >/dev/null 2>&1; then
    addgroup -S "$KH_CHROMIUM_USER" 2>/dev/null || true
    adduser -S -D -H -h "$KH_CHROMIUM_HOME" -s /sbin/nologin -G "$KH_CHROMIUM_USER" "$KH_CHROMIUM_USER"
  fi
  mkdir -p "$KH_CHROMIUM_HOME"
  chown -h "${KH_CHROMIUM_USER}:${KH_CHROMIUM_USER}" "$KH_CHROMIUM_HOME"
  chmod 700 "$KH_CHROMIUM_HOME"
  mkdir -p /etc/doas.d
  _conf_tmp="$(mktemp /etc/doas.d/.kouziahub.XXXXXX)"
  cat > "$_conf_tmp" <<EOF
# Hub Kouzia : le compte du service lance Chromium sous un compte dédié, par cette seule commande.
permit nopass ${KH_USER} as ${KH_CHROMIUM_USER} cmd ${KH_LIB_DIR}/chromium-sandboxed
EOF
  chown root:root "$_conf_tmp"
  chmod 400 "$_conf_tmp"
  if ! doas -C "$_conf_tmp" >/dev/null 2>&1; then
    rm -f "$_conf_tmp"
    die "Règle doas refusée par « doas -C » : Chromium reste désactivé."
  fi
  mv -f "$_conf_tmp" "$KH_DOAS_CONF"
  env_set HUB_CHROMIUM_PATH "$KH_CHROMIUM_LAUNCH"
  env_set HUB_CHROMIUM_USER "$KH_CHROMIUM_USER"
}

# Lancement d'essai, comme le fera le hub : compte du service > doas > compte Chromium.
chromium_selftest() {
  su -s /bin/sh "$KH_USER" -c "'${KH_CHROMIUM_LAUNCH}' --headless --no-sandbox --version" >/dev/null 2>&1
}

# --- Pare-feu de sortie de Chromium (nftables, compte Chromium seulement) ---

# Résolveurs DNS du CT (souvent la box, donc une adresse privée) : seuls autorisés, port 53.
dns_servers() {
  awk '$1 == "nameserver" { print $2 }' "${KH_RESOLV_CONF:-/etc/resolv.conf}" 2>/dev/null
}

# Écrit la règle (table dédiée, recréée d'un bloc à chaque pose).
write_nft_rules() {
  _v4=""
  _v6=""
  for _ns in $(dns_servers); do
    case "$_ns" in
      *:*) _v6="${_v6:+${_v6}, }${_ns}" ;;
      *.*) _v4="${_v4:+${_v4}, }${_ns}" ;;
    esac
  done
  # Serveur éphémère des vignettes (hub, 127.0.0.1, port choisi par le système) : plage éphémère.
  _range="$(awk '{ print $1 "-" $2 }' "${KH_PORT_RANGE_FILE:-/proc/sys/net/ipv4/ip_local_port_range}" 2>/dev/null)"
  [ -n "$_range" ] || _range="32768-60999"
  _tmp="$(mktemp "${KH_NFT_FILE}.XXXXXX")"
  {
    echo "# Hub Kouzia : sortie réseau du compte ${KH_CHROMIUM_USER} (Chromium). Généré par hubctl, ne pas modifier."
    echo "table inet kouziahub"
    echo "delete table inet kouziahub"
    echo "table inet kouziahub {"
    echo "  chain output {"
    echo "    type filter hook output priority filter; policy accept;"
    echo "    meta skuid \"${KH_CHROMIUM_USER}\" jump chromium"
    echo "  }"
    echo "  chain chromium {"
    echo "    ct state established,related accept"
    echo "    ip daddr 127.0.0.1 tcp dport ${_range} accept"
    if [ -n "$_v4" ]; then
      echo "    ip daddr { ${_v4} } udp dport 53 accept"
      echo "    ip daddr { ${_v4} } tcp dport 53 accept"
    fi
    if [ -n "$_v6" ]; then
      echo "    ip6 daddr { ${_v6} } udp dport 53 accept"
      echo "    ip6 daddr { ${_v6} } tcp dport 53 accept"
    fi
    echo "    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } counter drop"
    echo "    ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8 } counter drop"
    echo "  }"
    echo "}"
  } > "$_tmp"
  chown root:root "$_tmp"
  chmod 600 "$_tmp"
  mv -f "$_tmp" "$KH_NFT_FILE"
}

# Pose et contrôle (lecture de la table). Code 0 : posée ; 1 : impossible ici (repli Proxmox, README).
apply_firewall() {
  chromium_installed || return 0
  if ! command -v nft >/dev/null 2>&1; then
    apk add --no-cache nftables >/dev/null 2>&1 || { warn "nftables introuvable : pare-feu de Chromium non posé (README, repli Proxmox)."; return 1; }
  fi
  write_nft_rules
  if nft -f "$KH_NFT_FILE" 2>/dev/null && nft list table inet kouziahub 2>/dev/null | grep -q "skuid"; then
    # Reposé au démarrage du CT par le service OpenRC dédié.
    if service_exists "$KH_FIREWALL_SERVICE"; then
      rc-update add "$KH_FIREWALL_SERVICE" default >/dev/null 2>&1 || true
    fi
    ok "Pare-feu de Chromium posé (table inet kouziahub)."
    return 0
  fi
  if service_exists "$KH_FIREWALL_SERVICE"; then
    rc-update del "$KH_FIREWALL_SERVICE" default >/dev/null 2>&1 || true
  fi
  warn "Le CT refuse le pare-feu nftables (CT non privilégié sans droit réseau, ou module absent)."
  warn "Chromium reste isolé par son compte, mais sa sortie réseau n'est pas filtrée : poser la règle Proxmox (README, « Pare-feu de Chromium »)."
  return 1
}

firewall_active() {
  command -v nft >/dev/null 2>&1 && nft list table inet kouziahub 2>/dev/null | grep -q "skuid"
}
