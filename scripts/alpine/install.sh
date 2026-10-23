#!/bin/sh
# Installation du hub sur un CT Alpine dédié « kouziahub » (Proxmox, OpenRC). Rejouable sans risque :
# le .env, la base et les fichiers existants sont gardés.
#
#   hubctl install                       questions en français, valeurs par défaut sûres
#   sh install.sh --yes [--chromium] [--from DOSSIER] [--no-start]   sans question (hors menu)

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

YES=0
WANT_CHROMIUM=ask
FROM_DIR=""
NO_START=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --chromium) WANT_CHROMIUM=1; shift ;;
    --no-chromium) WANT_CHROMIUM=0; shift ;;
    --from) FROM_DIR="${2:-}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) sed -n '2,7p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done
INTERACTIVE=0
if [ -t 0 ] && [ "$YES" -eq 0 ]; then INTERACTIVE=1; fi
if [ "$WANT_CHROMIUM" = "ask" ] && [ "$INTERACTIVE" -eq 0 ]; then WANT_CHROMIUM=0; fi

require_root
require_alpine
disk_guard / 1500
ops_lock refuse

# Le hub, s'il tournait, n'est jamais laissé arrêté par une installation interrompue.
STOPPED=0
on_exit() {
  _rc=$?
  if [ "$_rc" -ne 0 ] && [ "$STOPPED" -eq 1 ] && service_exists "$KH_SERVICE"; then
    rc-service "$KH_SERVICE" start >/dev/null 2>&1 || true
  fi
}
trap on_exit EXIT
trap_signals

title "Installation du hub Kouzia"
cat <<EOF
  Ce qui va être fait sur ce CT :
    - installer Node.js, git, sqlite et les outils nécessaires ;
    - créer le compte de service « ${KH_USER} » (sans droits root) ;
    - placer le hub dans ${KH_APP_DIR} et générer son fichier .env (secrets aléatoires) ;
    - construire l'application, créer le service qui la relance seule en cas de panne ;
    - programmer une sauvegarde chaque nuit dans ${KH_BACKUP_DIR}.
  Durée : 5 à 15 minutes. Rien n'est envoyé chez Cloudflare.
EOF
if [ "$INTERACTIVE" -eq 1 ]; then
  confirm "Lancer l'installation ?" o || { echo "  Annulé."; exit 0; }
fi

# --- Paquets ---
title "1/6 Paquets du système"
apk update
# icu-data-full : Intl fr-FR complet (avec icu-data-en seul, dates et montants sortent en anglais).
# python3, make, g++ : secours si un module natif (argon2, sharp) doit être compilé.
apk add --no-cache \
  nodejs npm git sqlite curl openssl ca-certificates tzdata icu-data-full \
  tar gzip procps logrotate rsync gnupg \
  python3 make g++ linux-headers
_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$_major" -lt "$KH_NODE_MIN" ]; then
  warn "Node ${_major} trop ancien : essai de nodejs-current."
  apk add --no-cache nodejs-current npm || die "Node.js ${KH_NODE_MIN} ou plus introuvable : passer le CT en Alpine 3.21 ou plus."
fi
require_node_min
ensure_node_patched || true
ok "Node $(node -v), npm $(npm -v)"
intl_fr_ok || warn "Node ne formate pas encore en français (données ICU) : hubctl status après l'installation."

# --- Compte et dossiers ---
title "2/6 Compte de service et dossiers"
if ! id -u "$KH_USER" >/dev/null 2>&1; then
  addgroup -S "$KH_GROUP" 2>/dev/null || true
  adduser -S -D -H -h "$KH_HOME_DIR" -s /sbin/nologin -G "$KH_GROUP" "$KH_USER"
  ok "Compte ${KH_USER} créé."
fi
mkdir -p "$KH_APP_DIR"
fix_service_dirs

# --- Code ---
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || die "Dossier introuvable : $FROM_DIR"
  log "Copie du code depuis $FROM_DIR..."
  rsync -a --no-owner --no-group --delete --exclude-from="${SCRIPT_DIR}/conf/rsync-exclude.txt" "${FROM_DIR%/}/" "${KH_APP_DIR}/"
elif [ ! -f "${KH_APP_DIR}/package.json" ]; then
  log "Téléchargement du code (${KH_REPO_URL})..."
  _tmp="$(mktemp -d)"
  git clone --depth 1 --branch "$KH_REPO_BRANCH" "$KH_REPO_URL" "${_tmp}/repo" \
    || die "Impossible de télécharger le code (réseau, ou dépôt privé : voir le README)."
  rsync -a "${_tmp}/repo/" "${KH_APP_DIR}/"
  rm -rf "$_tmp"
fi
[ -f "${KH_APP_DIR}/package.json" ] || die "Code du hub absent de ${KH_APP_DIR}."
# Code à root (lecture seule pour le service) puis copie root des scripts, avant toute exécution.
fix_ownership
install_root_scripts
ok "Code en place : $(current_commit)"

# --- .env ---
title "3/6 Fichier de configuration (.env)"
DATA_DIR_DEFAULT="${KH_APP_DIR}/data"
if [ ! -f "$KH_ENV_FILE" ]; then
  [ -f "${KH_APP_DIR}/.env.example" ] || die ".env.example absent du dépôt."
  umask 077
  # Valeurs passées par l'environnement d'awk : jamais en argument, jamais affichées.
  V_SESSION_SECRET="$(openssl rand -base64 32)" \
  V_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  V_NODE_ENV=production \
  V_DATABASE_URL="file:../data/hub.db" \
  V_API_PORT="$KH_DEFAULT_PORT" \
  V_HUB_DATA_DIR="$DATA_DIR_DEFAULT" \
  V_HUB_PUBLIC_ORIGIN="https://hub.kouzia.com" \
  V_COOKIE_SECURE=true \
  V_TRUST_PROXY=true \
  awk '
    /^[A-Z0-9_]+=$/ {
      k = substr($0, 1, length($0) - 1)
      if (("V_" k) in ENVIRON) { print k "=\"" ENVIRON["V_" k] "\""; next }
    }
    { print }
  ' "${KH_APP_DIR}/.env.example" > "$KH_ENV_FILE"
  umask 022
  env_fix_perms
  ok ".env créé (secrets aléatoires ; root:${KH_GROUP} 640 : le service le lit, ne le modifie pas)."
else
  env_fix_perms
  ok ".env existant gardé."
  for _k in SESSION_SECRET ENCRYPTION_KEY; do
    env_has "$_k" || die "$_k est vide dans le .env existant : à corriger avant de continuer (ne jamais le changer si la base contient déjà des données)."
  done
fi
fix_data_perms

# --- Chromium (facultatif) ---
if [ "$WANT_CHROMIUM" = "ask" ]; then
  sh "${KH_LIB_DIR}/configure.sh" chromium --no-restart || warn "Chromium non installé (plus tard : hubctl chromium)."
elif [ "$WANT_CHROMIUM" = "1" ]; then
  KH_ASSUME_YES=1 sh "${KH_LIB_DIR}/configure.sh" chromium --no-restart || warn "Chromium non installé (plus tard : hubctl chromium)."
fi

# --- Construction ---
title "4/6 Construction de l'application"
stop_app
STOPPED=1
# Installation rejouée sur un hub qui a déjà des données : sauvegarde avant migration, comme update.
_db="$(db_path)" || exit 1
if [ -f "$_db" ]; then
  log "Base existante : sauvegarde avant migration..."
  BAK="$(sh "${KH_LIB_DIR}/backup.sh" --tag avant-installation)" \
    || die "La sauvegarde a échoué : installation arrêtée avant toute migration (hubctl logs sauvegarde)."
  ok "Sauvegarde : $BAK"
fi
npm_ci || die "npm ci a échoué (voir le message ci-dessus)."
db_migrate || die "Les migrations de la base ont échoué."
build_web || die "La construction de l'interface a échoué."

# --- Services ---
title "5/6 Service, sauvegardes, journaux"
install -o root -g root -m 755 "${KH_LIB_DIR}/openrc/kouziahub" "/etc/init.d/${KH_SERVICE}"
cat > "/etc/conf.d/${KH_SERVICE}" <<EOF
KH_APP_DIR="${KH_APP_DIR}"
KH_USER="${KH_USER}"
KH_GROUP="${KH_GROUP}"
KH_LOG_DIR="${KH_LOG_DIR}"
KH_HOME_DIR="${KH_HOME_DIR}"
EOF
chmod 644 "/etc/conf.d/${KH_SERVICE}"
rc-update add "$KH_SERVICE" default >/dev/null 2>&1 || true
install_openrc_scripts
install_system_conf
apply_firewall || true
rc-update add crond default >/dev/null 2>&1 || true
rc-service crond start >/dev/null 2>&1 || true
state_set last-update "$(date '+%Y-%m-%d %H:%M') $(current_commit) (installation)"
ok "Service ${KH_SERVICE} installé (relance automatique), sauvegarde quotidienne programmée, commande « hubctl » disponible."

# --- Réglages Cloudflare et compte ---
title "6/6 Réglages"
if [ "$INTERACTIVE" -eq 1 ]; then
  # git clone ne garde pas le jeton saisi : il est redemandé une fois, pour les mises à jour.
  if is_git_install && [ ! -s "$KH_GITHUB_TOKEN_FILE" ]; then
    echo "  Le dépôt est privé : « hubctl update » a besoin du jeton GitHub en lecture seule (README 1.2)."
    if confirm "Poser maintenant le jeton (le même que pour git clone) ?" o; then
      sh "${KH_LIB_DIR}/configure.sh" github || warn "À refaire : hubctl secrets github"
    fi
  fi
  if [ ! -s "$KH_TUNNEL_TOKEN_FILE" ]; then
    echo "  Le tunnel relie hub.kouzia.com à ce CT (README, étape 3)."
    if confirm "Avez-vous déjà la commande d'installation du tunnel du hub ?" n; then
      sh "${KH_LIB_DIR}/configure.sh" cloudflare || warn "Tunnel à refaire : hubctl cloudflare"
    fi
  fi
fi

STOPPED=0
if [ "$NO_START" -eq 0 ]; then
  start_app || { show_app_errors; warn "Le hub ne répond pas encore : hubctl status puis hubctl logs erreurs."; }
fi

if [ "$INTERACTIVE" -eq 1 ]; then
  echo ""
  echo "  Votre compte du hub : adresse, mot de passe, puis application d'authentification du téléphone."
  if confirm "Créer (ou refaire) votre compte maintenant ?" o; then
    run_as_app "npm run --silent admin:create" || warn "À refaire : hubctl admin"
  fi
fi

title "Installation terminée"
_todo=0
if [ ! -s "$KH_TUNNEL_TOKEN_FILE" ]; then echo "  À faire : tunnel du hub         > hubctl cloudflare"; _todo=1; fi
if is_git_install && [ ! -s "$KH_GITHUB_TOKEN_FILE" ]; then echo "  À faire : jeton GitHub (mises à jour) > hubctl secrets github"; fi
echo "  Compte du hub (si pas encore fait) : hubctl admin"
if ! env_has CLOUDFLARE_API_TOKEN; then
  echo "  Plus tard : jeton API Cloudflare > hubctl secrets api (en attendant, mode simulé)"
fi
[ "$_todo" -eq 1 ] || echo "  Ouvrir https://hub.kouzia.com"
echo "  État complet : hubctl status"
