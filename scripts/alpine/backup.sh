#!/bin/sh
# Sauvegarde complète du hub, dans un dossier daté de /var/backup/kouziahub :
#   hub.db.gz     base SQLite copiée par « sqlite3 .backup » (cohérente même service lancé, WAL)
#   data.tar.gz   dossier HUB_DATA_DIR (fichiers des sites, versions, vignettes), base exclue
#   dotenv        copie du .env : CONTIENT DES SECRETS (dossier et fichiers en 700/600, root)
#   manifest.txt  date, version du code, migrations appliquées
# Rotation : les KH_BACKUP_KEEP plus récentes sont gardées (14 par défaut).
#
# Usage : hubctl backup [--tag NOM]
# Sortie standard : le chemin de la sauvegarde créée (rien d'autre). Messages : écran et backup.log.

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    -h|--help) echo "Usage : hubctl backup [--tag NOM]"; exit 0 ;;
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
mkdir -p "$KH_LOG_DIR" "$KH_BACKUP_DIR"
chmod 700 "$KH_BACKUP_DIR"
LOG_FILE="${KH_LOG_DIR}/backup.log"

blog() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2
}
bfail() {
  blog "ÉCHEC : $*"
  exit 1
}

DB="$(db_path)"
DATA="$(data_dir)"
[ -f "$DB" ] || bfail "base introuvable : $DB"

# Place nécessaire : taille actuelle des données et de la base, plus 200 Mo de marge.
NEED_KB=$(( $(du -sk "$DATA" 2>/dev/null | awk '{print $1}') + $(du -sk "$DB" | awk '{print $1}') + 204800 ))
AVAIL_KB="$(df -Pk "$KH_BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ "${AVAIL_KB:-0}" -lt "$NEED_KB" ]; then
  bfail "pas assez de place dans $KH_BACKUP_DIR ($(( AVAIL_KB / 1024 )) Mo libres, $(( NEED_KB / 1024 )) Mo nécessaires)"
fi

NAME="kouziahub-$(date '+%Y-%m-%d_%H%M%S')${TAG:+-$TAG}"
WORK="$(mktemp -d "${KH_BACKUP_DIR}/.en-cours.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

blog "Sauvegarde ${NAME} : base..."
sqlite3 -cmd ".timeout 15000" "$DB" ".backup '${WORK}/hub.db'" || { sqlite_fix_owner "$DB"; bfail "copie de la base (sqlite3 .backup)"; }
sqlite_fix_owner "$DB"
INTEGRITY="$(sqlite3 "${WORK}/hub.db" "PRAGMA integrity_check;" 2>&1 || true)"
[ "$INTEGRITY" = "ok" ] || bfail "contrôle d'intégrité de la copie : $INTEGRITY"
MIGRATIONS="$(sqlite3 "${WORK}/hub.db" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" 2>/dev/null || true)"
gzip -9 "${WORK}/hub.db"

blog "Fichiers des sites (${DATA})..."
DB_NAME="$(basename "$DB")"
if [ -d "$DATA" ]; then
  # La base vit dans le même dossier : exclue ici, elle est déjà copiée proprement.
  tar -C "$DATA" -czf "${WORK}/data.tar.gz" --anchored \
    --exclude="./${DB_NAME}" --exclude="./${DB_NAME}-wal" --exclude="./${DB_NAME}-shm" --exclude="./${DB_NAME}-journal" \
    . || bfail "archive des fichiers des sites"
else
  tar -C "$WORK" -czf "${WORK}/data.tar.gz" --files-from /dev/null
fi
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
trap - EXIT INT TERM

# Rotation : seules les KH_BACKUP_KEEP plus récentes restent.
_n=0
list_backups | while IFS= read -r _b; do
  _n=$((_n + 1))
  if [ "$_n" -gt "$KH_BACKUP_KEEP" ]; then
    rm -rf "$_b"
    blog "Ancienne sauvegarde supprimée : $(basename "$_b")"
  fi
done
# Restes d'une sauvegarde interrompue (plus d'un jour) : jamais celle d'à côté, en cours.
find "$KH_BACKUP_DIR" -maxdepth 1 -name '.en-cours.*' -mtime +0 -exec rm -rf {} \; 2>/dev/null || true

SIZE="$(du -sh "${KH_BACKUP_DIR}/${NAME}" | awk '{print $1}')"
blog "OK : ${KH_BACKUP_DIR}/${NAME} (${SIZE}). Elle contient le .env : ne pas la copier n'importe où."
printf '%s\n' "${KH_BACKUP_DIR}/${NAME}"
