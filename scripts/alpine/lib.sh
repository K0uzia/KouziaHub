# Fonctions partagées des scripts du CT Alpine du hub (sh POSIX, BusyBox ash).
# Chargé par « . lib.sh » : ne s'exécute pas seul.
# Réglages des scripts (préfixe KH_, jamais dans le .env de l'application) :
#   KH_APP_DIR, KH_USER, KH_GROUP, KH_BACKUP_DIR, KH_BACKUP_KEEP, KH_REPO_URL, KH_REPO_BRANCH.
# shellcheck disable=SC2034

# crond lance les scripts avec un PATH réduit ; GNU tar (/usr/bin) doit passer avant celui de BusyBox.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

KH_APP_DIR="${KH_APP_DIR:-/opt/kouziahub}"
KH_USER="${KH_USER:-kouziahub}"
KH_GROUP="${KH_GROUP:-kouziahub}"
KH_SERVICE="kouziahub"
KH_TUNNEL_SERVICE="cloudflared"
KH_LOG_DIR="${KH_LOG_DIR:-/var/log/kouziahub}"
KH_ETC_DIR="${KH_ETC_DIR:-/etc/kouziahub}"
KH_BACKUP_DIR="${KH_BACKUP_DIR:-/var/backup/kouziahub}"
# Nombre de sauvegardes gardées (les plus récentes). Chacune contient tous les fichiers des sites.
KH_BACKUP_KEEP="${KH_BACKUP_KEEP:-14}"
KH_STATE_DIR="${KH_STATE_DIR:-${KH_APP_DIR}/.deploy-state}"
KH_ENV_FILE="${KH_APP_DIR}/.env"
KH_TUNNEL_TOKEN_FILE="${KH_ETC_DIR}/tunnel.token"
KH_REPO_URL="${KH_REPO_URL:-https://github.com/K0uzia/KouziaHub.git}"
KH_REPO_BRANCH="${KH_REPO_BRANCH:-main}"
KH_DEFAULT_PORT=3000
KH_NODE_MIN=22
KH_CLOUDFLARED_BIN=/usr/local/bin/cloudflared

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

disk_guard() {
  # disk_guard <chemin> <Mo minimum>
  _avail="$(df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ "${_avail:-0}" -lt "$2" ]; then
    die "Pas assez de place sur le disque pour $1 (${_avail:-0} Mo libres, il en faut $2). Agrandir le disque du CT dans Proxmox."
  fi
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
    trap 'stty echo 2>/dev/null; exit 130' INT TERM
    IFS= read -r _sec || _sec=""
    stty echo 2>/dev/null || true
    trap - INT TERM
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

env_fix_perms() {
  chown "${KH_USER}:${KH_GROUP}" "$KH_ENV_FILE" 2>/dev/null || true
  chmod 600 "$KH_ENV_FILE"
}

api_port() {
  env_get API_PORT "$KH_DEFAULT_PORT"
}

health_url() {
  printf 'http://127.0.0.1:%s/api/health' "$(api_port)"
}

# Dossier des fichiers des sites (HUB_DATA_DIR du .env).
data_dir() {
  env_get HUB_DATA_DIR "${KH_APP_DIR}/data"
}

# Chemin de la base SQLite, tiré de DATABASE_URL (relatif au dossier prisma/, comme Prisma).
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
    _d="$(cd "$_d" && pwd)"
  fi
  printf '%s/%s' "$_d" "$(basename "$_p")"
}

# sqlite3 lancé en root peut créer les fichiers -wal et -shm à son nom : le service ne pourrait
# plus écrire. On les rend au compte du service après chaque accès.
sqlite_fix_owner() {
  for _f in "$1" "$1-wal" "$1-shm" "$1-journal"; do
    if [ -e "$_f" ]; then
      chown "${KH_USER}:${KH_GROUP}" "$_f" 2>/dev/null || true
    fi
  done
}

# --- Exécution sous le compte du service ---

run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    su -s /bin/sh "$KH_USER" -c "export npm_config_libc=musl HOME='${KH_APP_DIR}'; cd '${KH_APP_DIR}' && $*"
  else
    sh -c "cd '${KH_APP_DIR}' && $*"
  fi
}

git_in_app() {
  git -c "safe.directory=${KH_APP_DIR}" -C "$KH_APP_DIR" "$@"
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
git_sync_from_origin() {
  _branch="${1:-$KH_REPO_BRANCH}"
  log "Récupération de la dernière version (GitHub, branche ${_branch})..."
  git_in_app fetch --depth 1 origin "+${_branch}:refs/remotes/origin/${_branch}" \
    || die "Impossible de joindre GitHub (réseau ou droits d'accès au dépôt)."
  git_in_app checkout -f -B "$_branch" "origin/${_branch}" \
    || die "Impossible de placer le code sur origin/${_branch}."
  chown_sources
  ok "Code à jour : $(current_commit)"
}

# Droits sur les sources seulement (pas tout node_modules à chaque fois).
chown_sources() {
  for _p in .git apps prisma scripts package.json package-lock.json tsconfig.json Makefile; do
    if [ -e "${KH_APP_DIR}/${_p}" ]; then
      chown -R "${KH_USER}:${KH_GROUP}" "${KH_APP_DIR}/${_p}" 2>/dev/null || true
    fi
  done
}

file_sha256() {
  if [ -f "$1" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "absent"
  fi
}

state_get() {
  if [ -f "${KH_STATE_DIR}/$1" ]; then
    cat "${KH_STATE_DIR}/$1"
  fi
}

state_set() {
  mkdir -p "$KH_STATE_DIR"
  printf '%s\n' "$2" > "${KH_STATE_DIR}/$1"
}

# --- Étapes de construction (compte du service) ---

npm_ci() {
  log "Installation des dépendances (npm ci, quelques minutes)..."
  if ! run_as_app "node scripts/check-lockfile.mjs"; then
    warn "package-lock.json incomplet (souvent un npm install sous Windows) : npm ci risque d'échouer, à corriger dans le dépôt."
  fi
  # --include=dev : tsx (lancement de l'API) et vite (build) sont des dépendances de développement.
  run_as_app "npm ci --include=dev --no-audit --no-fund" || return 1
  state_set package-lock "$(file_sha256 "${KH_APP_DIR}/package-lock.json")"
  ok "Dépendances installées"
}

deps_needed() {
  [ ! -x "${KH_APP_DIR}/node_modules/.bin/tsx" ] && return 0
  [ "$(file_sha256 "${KH_APP_DIR}/package-lock.json")" != "$(state_get package-lock)" ]
}

db_migrate() {
  log "Base de données : migrations puis client Prisma..."
  run_as_app "npm run --silent db:deploy" || return 1
  run_as_app "npm run --silent db:generate" || return 1
  sqlite_fix_owner "$(db_path)"
  ok "Base de données à jour"
}

build_web() {
  log "Construction de l'interface (npm run build)..."
  run_as_app "npm run --silent build" || return 1
  ok "Interface construite"
}

# --- Services OpenRC ---

service_exists() {
  [ -f "/etc/init.d/$1" ]
}

service_running() {
  service_exists "$1" && rc-service "$1" status >/dev/null 2>&1
}

access_configured() {
  env_has CF_ACCESS_TEAM_DOMAIN && env_has CF_ACCESS_AUD
}

stop_app() {
  if service_exists "$KH_SERVICE"; then
    log "Arrêt du hub..."
    rc-service "$KH_SERVICE" stop >/dev/null 2>&1 || true
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
  if ! access_configured; then
    warn "Cloudflare Access n'est pas encore renseigné : le hub ne peut pas démarrer (hubctl secrets access)."
    return 1
  fi
  rc-service "$KH_SERVICE" start >/dev/null 2>&1 || rc-service "$KH_SERVICE" restart >/dev/null 2>&1 || true
  wait_health
}

restart_app() {
  if ! access_configured; then
    warn "Cloudflare Access n'est pas encore renseigné : le hub reste arrêté (hubctl secrets access)."
    return 1
  fi
  log "Redémarrage du hub..."
  rc-service "$KH_SERVICE" restart >/dev/null 2>&1 || true
  wait_health
}

# wait_health : attend jusqu'à 90 s {"ok":true} sur /api/health (ouvert sans jeton Access).
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

# Scripts OpenRC réinstallés seulement s'ils diffèrent de ceux du dépôt.
install_openrc_scripts() {
  for _svc in "$KH_SERVICE" "$KH_TUNNEL_SERVICE"; do
    _src="${KH_APP_DIR}/scripts/alpine/openrc/${_svc}"
    [ -f "$_src" ] || continue
    if [ "$_svc" = "$KH_TUNNEL_SERVICE" ] && [ ! -f "/etc/init.d/${_svc}" ]; then
      continue   # posé par « hubctl cloudflare » seulement
    fi
    if ! cmp -s "$_src" "/etc/init.d/${_svc}"; then
      install -m 755 "$_src" "/etc/init.d/${_svc}"
      ok "Service OpenRC installé : ${_svc}"
    fi
  done
}

install_hubctl_link() {
  chmod 755 "${KH_APP_DIR}/scripts/alpine/hubctl" 2>/dev/null || true
  ln -sfn "${KH_APP_DIR}/scripts/alpine/hubctl" /usr/local/bin/hubctl
}

install_system_conf() {
  install -m 644 "${KH_APP_DIR}/scripts/alpine/conf/logrotate.kouziahub" /etc/logrotate.d/kouziahub
  cat > /etc/periodic/daily/kouziahub-backup <<EOF
#!/bin/sh
# Sauvegarde quotidienne du hub (crond d'Alpine : /etc/periodic/daily). Journal : ${KH_LOG_DIR}/backup.log
exec /bin/sh ${KH_APP_DIR}/scripts/alpine/backup.sh --tag quotidienne >/dev/null 2>&1
EOF
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
