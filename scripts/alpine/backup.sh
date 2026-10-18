#!/bin/sh
# Sauvegarde complète du hub, dans un dossier daté de /var/backup/kouziahub (root, 700) :
#   hub.db.gz     base SQLite copiée par « sqlite3 .backup » (cohérente même service lancé, WAL)
#   data.tar.gz   dossier HUB_DATA_DIR (fichiers des sites, versions, vignettes), base exclue
#   dotenv        copie du .env : CONTIENT DES SECRETS (dossier et fichiers en 700/600, root)
#   manifest.txt  date, version du code, migrations appliquées
# Rotation : les KH_BACKUP_KEEP plus récentes sont gardées (14 par défaut).
# Base et fichiers sont lus SOUS LE COMPTE DU SERVICE : root n'ouvre ni ne parcourt ses fichiers.
#
#   hubctl backup [--tag NOM]          sauvegarder maintenant
#   hubctl backup --export [SAUVEGARDE] archive chiffrée (GPG, AES256) à copier hors du CT
#   (crond) backup.sh --cron ...       saute son tour, avec une ligne au journal, si une opération tourne
# Sortie standard : le chemin produit (rien d'autre). Messages : écran et backup.log.

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

TAG=""
CRON=0
EXPORT=0
EXPORT_SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --cron) CRON=1; shift ;;
    --export) EXPORT=1; shift; if [ $# -gt 0 ]; then EXPORT_SRC="$1"; shift; fi ;;
    -h|--help) sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done
if [ -n "$TAG" ]; then
  case "$TAG" in
    *[!a-z0-9-]*) die "Nom de sauvegarde invalide (lettres minuscules, chiffres, tirets)." ;;
  esac
fi

require_root
require_cmd sqlite3 tar gzip
umask 077
fix_service_dirs
LOG_FILE="${KH_LOG_DIR}/backup.log"

blog() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2
}
bfail() {
  blog "ÉCHEC : $*"
  exit 1
}

if [ "$CRON" -eq 1 ]; then
  _rc=0
  ops_lock cron || _rc=$?
  if [ "$_rc" -eq 2 ]; then
    blog "Sauvegarde quotidienne sautée : une autre opération du hub est en cours (prochain essai demain)."
    exit 0
  fi
else
  ops_lock refuse
fi

# --- Archive chiffrée pour une copie hors du CT ---
if [ "$EXPORT" -eq 1 ]; then
  require_cmd gpg
  if [ -z "$EXPORT_SRC" ]; then
    EXPORT_SRC="$(list_backups | head -n 1)"
    [ -n "$EXPORT_SRC" ] || die "Aucune sauvegarde à exporter (hubctl backup d'abord)."
  fi
  if [ ! -d "$EXPORT_SRC" ] && [ -d "${KH_BACKUP_DIR}/${EXPORT_SRC}" ]; then EXPORT_SRC="${KH_BACKUP_DIR}/${EXPORT_SRC}"; fi
  [ -f "${EXPORT_SRC}/manifest.txt" ] || die "Sauvegarde introuvable : $EXPORT_SRC"
  if [ ! -s "$KH_PASSPHRASE_FILE" ]; then
    [ -t 0 ] || die "Phrase de passe des exports absente : lancer « hubctl backup --export » dans un terminal."
    echo "  Première exportation : choisissez la phrase de passe qui protège les archives exportées."
    echo "  Notez-la dans votre gestionnaire de mots de passe : sans elle, une archive exportée ne s'ouvre pas,"
    echo "  et si le CT est perdu, elle n'existe plus nulle part ailleurs. 16 caractères au moins."
    ask_secret P1 "Phrase de passe"
    ask_secret P2 "La même, encore une fois"
    [ "$P1" = "$P2" ] || die "Les deux saisies diffèrent. Rien n'a changé."
    [ "${#P1}" -ge 16 ] || die "Trop courte (${#P1} caractères, 16 au moins)."
    printf '%s\n' "$P1" > "$KH_PASSPHRASE_FILE"
    P1="" P2=""
    chown root:root "$KH_PASSPHRASE_FILE"
    chmod 600 "$KH_PASSPHRASE_FILE"
    ok "Phrase de passe enregistrée (${KH_PASSPHRASE_FILE}, root seulement)."
  fi
  mkdir -p "$KH_EXPORT_DIR"
  chmod 700 "$KH_EXPORT_DIR"
  OUT="${KH_EXPORT_DIR}/$(basename "$EXPORT_SRC").tar.gpg"
  blog "Export chiffré de $(basename "$EXPORT_SRC")..."
  tar -C "$(dirname "$EXPORT_SRC")" -cf - "$(basename "$EXPORT_SRC")" \
    | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --passphrase-file "$KH_PASSPHRASE_FILE" --output "${OUT}.part"
  gpg --batch --pinentry-mode loopback --passphrase-file "$KH_PASSPHRASE_FILE" --decrypt "${OUT}.part" 2>/dev/null \
    | tar -tf - 2>/dev/null | grep -q "/manifest.txt$" || { rm -f "${OUT}.part"; bfail "archive chiffrée illisible"; }
  mv -f "${OUT}.part" "$OUT"
  chmod 600 "$OUT"
  # Seules les 3 dernières archives exportées restent sur le CT.
  for _f in "$KH_EXPORT_DIR"/kouziahub-*.tar.gpg; do
    if [ -f "$_f" ]; then printf '%s\n' "$_f"; fi
  done | sort -r | sed -n '4,$p' | while IFS= read -r _old; do rm -f "$_old"; done
  blog "OK : $OUT (chiffrée AES256, à copier hors du CT ; voir le README)."
  printf '%s\n' "$OUT"
  exit 0
fi

DB="$(db_path)" || exit 1
DATA="$(data_dir)" || exit 1
[ -f "$DB" ] || bfail "base introuvable : $DB"

# Place nécessaire : taille actuelle des données et de la base, plus 200 Mo de marge.
NEED_KB=$(( $(du -sk "$DATA" 2>/dev/null | awk '{print $1}') + 204800 ))
AVAIL_KB="$(df -Pk "$KH_BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ "${AVAIL_KB:-0}" -lt "$NEED_KB" ]; then
  bfail "pas assez de place dans $KH_BACKUP_DIR ($(( AVAIL_KB / 1024 )) Mo libres, $(( NEED_KB / 1024 )) Mo nécessaires)"
fi

NAME="kouziahub-$(date '+%Y-%m-%d_%H%M%S')${TAG:+-$TAG}"
WORK="$(mktemp -d "${KH_BACKUP_DIR}/.en-cours.XXXXXX")"
# Dossier d'échange au compte du service (dans son dossier personnel) : il y écrit la copie de la base.
APP_STAGE="$(mktemp -d "${KH_HOME_DIR}/sauvegarde.XXXXXX")"
chown -h "${KH_USER}:${KH_GROUP}" "$APP_STAGE"
trap 'rm -rf "$WORK" "$APP_STAGE"' EXIT
trap_signals

blog "Sauvegarde ${NAME} : base..."
run_as_app "sqlite3 -cmd '.timeout 15000' '${DB}' \".backup '${APP_STAGE}/hub.db'\"" \
  || bfail "copie de la base (sqlite3 .backup)"
# Copie sans suivre de lien (cp -P) dans le dossier de root, puis contrôle : un lien ou un fichier
# spécial posé à la place par le compte n'est jamais lu.
if [ ! -f "${APP_STAGE}/hub.db" ] || [ -L "${APP_STAGE}/hub.db" ]; then bfail "copie de la base absente ou invalide"; fi
cp -P "${APP_STAGE}/hub.db" "${WORK}/hub.db"
if [ ! -f "${WORK}/hub.db" ] || [ -L "${WORK}/hub.db" ]; then bfail "copie de la base invalide"; fi
INTEGRITY="$(sqlite3 "${WORK}/hub.db" "PRAGMA integrity_check;" 2>&1 || true)"
[ "$INTEGRITY" = "ok" ] || bfail "contrôle d'intégrité de la copie : $INTEGRITY"
MIGRATIONS="$(sqlite3 "${WORK}/hub.db" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" 2>/dev/null || true)"
gzip -9 "${WORK}/hub.db"

blog "Fichiers des sites (${DATA})..."
DB_NAME="$(basename "$DB")"
# tar tourne sous le compte du service et écrit sur sa sortie ; root ne fait que compresser le flux.
run_as_app "tar -C '${DATA}' -cf - --anchored --exclude='./${DB_NAME}' --exclude='./${DB_NAME}-wal' --exclude='./${DB_NAME}-shm' --exclude='./${DB_NAME}-journal' . ; echo \$? > '${APP_STAGE}/tar.rc'" \
  | gzip -c > "${WORK}/data.tar.gz"
TAR_RC=""
if [ -f "${APP_STAGE}/tar.rc" ] && [ ! -L "${APP_STAGE}/tar.rc" ]; then
  TAR_RC="$(head -c 4 "${APP_STAGE}/tar.rc" 2>/dev/null | tr -cd '0-9')"
fi
# Code 1 de GNU tar : un fichier a changé pendant la lecture (service lancé) ; l'archive reste valide.
case "${TAR_RC:-x}" in
  0) ;;
  1) blog "Un fichier a changé pendant la sauvegarde (hub en marche) : sa version est celle du début de la lecture." ;;
  *) bfail "archive des fichiers des sites (tar, code ${TAR_RC:-inconnu})" ;;
esac
tar -tzf "${WORK}/data.tar.gz" >/dev/null || bfail "archive des fichiers illisible"
gzip -t "${WORK}/hub.db.gz" || bfail "base compressée illisible"

if [ -f "$KH_ENV_FILE" ]; then
  cp "$KH_ENV_FILE" "${WORK}/dotenv"
  chmod 600 "${WORK}/dotenv"
fi

{
  echo "date=$(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "commit=$(current_commit)"
  echo "db=${DB}"
  echo "data=${DATA}"
  echo "env=$([ -f "${WORK}/dotenv" ] && echo oui || echo non)"
  echo "migrations:"
  printf '%s\n' "$MIGRATIONS"
} > "${WORK}/manifest.txt"

chmod 600 "$WORK"/*
chmod 700 "$WORK"
[ ! -e "${KH_BACKUP_DIR}/${NAME}" ] || bfail "une sauvegarde du même nom existe déjà : ${NAME}"
mv "$WORK" "${KH_BACKUP_DIR}/${NAME}"

# Rotation : seules les KH_BACKUP_KEEP plus récentes restent.
_n=0
list_backups | while IFS= read -r _b; do
  _n=$((_n + 1))
  if [ "$_n" -gt "$KH_BACKUP_KEEP" ]; then
    rm -rf "$_b"
    blog "Ancienne sauvegarde supprimée : $(basename "$_b")"
  fi
done
# Restes d'une sauvegarde interrompue (plus d'un jour).
find "$KH_BACKUP_DIR" -maxdepth 1 -name '.en-cours.*' -mtime +0 -exec rm -rf {} \; 2>/dev/null || true

SIZE="$(du -sh "${KH_BACKUP_DIR}/${NAME}" | awk '{print $1}')"
blog "OK : ${KH_BACKUP_DIR}/${NAME} (${SIZE}). Elle contient le .env : pour une copie hors du CT, « hubctl backup --export »."
printf '%s\n' "${KH_BACKUP_DIR}/${NAME}"
