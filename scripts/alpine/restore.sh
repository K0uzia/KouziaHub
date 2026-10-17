#!/bin/sh
# Restauration d'une sauvegarde du hub (dossier créé par backup.sh).
#
#   hubctl restore                      liste des sauvegardes, choix par numéro
#   hubctl restore <sauvegarde>         chemin ou nom du dossier (kouziahub-AAAA-MM-JJ_HHMMSS...)
#   hubctl restore --check <sauvegarde> contrôle seul (lisible, base intègre), rien n'est modifié
# Options : --yes (sans question), --no-safety-backup, --env / --no-env (remettre ou non le .env).
#
# Étapes : contrôle, sauvegarde de l'état courant (« avant-restauration »), arrêt du service,
# remplacement de la base et des fichiers, migrations, redémarrage, contrôle de santé.

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

CHECK_ONLY=0
YES=0
SAFETY=1
WITH_ENV=""
SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --yes) YES=1; shift ;;
    --no-safety-backup) SAFETY=0; shift ;;
    --env) WITH_ENV=1; shift ;;
    --no-env) WITH_ENV=0; shift ;;
    -h|--help) sed -n '2,10p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Option inconnue : $1" ;;
    *) [ -z "$SRC" ] || die "Une seule sauvegarde à la fois."; SRC="$1"; shift ;;
  esac
done

require_root
require_cmd sqlite3 tar gzip
umask 077

# --- Choix de la sauvegarde ---
if [ -z "$SRC" ]; then
  [ -t 0 ] || die "Indiquer la sauvegarde : hubctl restore <dossier>"
  LIST="$(list_backups | head -n 15)"
  [ -n "$LIST" ] || die "Aucune sauvegarde dans $KH_BACKUP_DIR."
  echo ""
  echo "  Sauvegardes disponibles (la plus récente en premier) :"
  printf '%s\n' "$LIST" | awk '{ n++; sub(".*/", ""); printf "    %2d) %s\n", n, $0 }'
  ask CHOICE "Numéro de la sauvegarde à remettre (vide = annuler)" ""
  [ -n "$CHOICE" ] || { echo "  Annulé."; exit 0; }
  case "$CHOICE" in *[!0-9]*) die "Numéro invalide." ;; esac
  SRC="$(printf '%s\n' "$LIST" | sed -n "${CHOICE}p")"
  [ -n "$SRC" ] || die "Numéro invalide."
fi
if [ ! -d "$SRC" ] && [ -d "${KH_BACKUP_DIR}/${SRC}" ]; then
  SRC="${KH_BACKUP_DIR}/${SRC}"
fi
[ -d "$SRC" ] || die "Sauvegarde introuvable : $SRC"
SRC="$(cd "$SRC" && pwd)"

# --- Contrôle (sans rien modifier) ---
log "Contrôle de la sauvegarde $(basename "$SRC")..."
for _f in manifest.txt hub.db.gz data.tar.gz; do
  [ -f "${SRC}/${_f}" ] || die "Sauvegarde incomplète : ${_f} manquant."
done
gzip -t "${SRC}/hub.db.gz" || die "Base compressée illisible."
tar -tzf "${SRC}/data.tar.gz" >/dev/null || die "Archive des fichiers illisible."
mkdir -p "$KH_BACKUP_DIR"
STAGE="$(mktemp -d "${KH_BACKUP_DIR}/.restauration.XXXXXX")"
STOPPED=0
on_exit() {
  _rc=$?
  rm -rf "$STAGE"
  if [ "$_rc" -ne 0 ] && [ "$STOPPED" -eq 1 ]; then
    warn "Restauration interrompue : le hub est peut-être arrêté."
    [ -z "${SAFETY_PATH:-}" ] || echo "  Pour revenir à l'état d'avant : hubctl restore ${SAFETY_PATH}"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM
gzip -dc "${SRC}/hub.db.gz" > "${STAGE}/hub.db"
INTEGRITY="$(sqlite3 "${STAGE}/hub.db" "PRAGMA integrity_check;" 2>&1 || true)"
[ "$INTEGRITY" = "ok" ] || die "Base de la sauvegarde abîmée : $INTEGRITY"
B_DATE="$(sed -n 's/^date=//p' "${SRC}/manifest.txt")"
B_COMMIT="$(sed -n 's/^commit=//p' "${SRC}/manifest.txt")"
B_FILES="$(tar -tzf "${SRC}/data.tar.gz" | grep -vc '/$' || true)"
ok "Sauvegarde lisible : base intègre, ${B_FILES} fichier(s), faite le ${B_DATE} (code ${B_COMMIT})."
if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi

DB="$(db_path)"
DATA="$(data_dir)"

# --- .env : faut-il remettre celui de la sauvegarde ? ---
# La base contient des données chiffrées avec ENCRYPTION_KEY : la clé du .env doit être celle de la base.
if [ -z "$WITH_ENV" ]; then
  WITH_ENV=0
  if [ -f "${SRC}/dotenv" ]; then
    if [ ! -f "$KH_ENV_FILE" ]; then
      WITH_ENV=1
    else
      _cur="$(grep -E '^ENCRYPTION_KEY=' "$KH_ENV_FILE" | tail -n 1 | sha256sum)"
      _old="$(grep -E '^ENCRYPTION_KEY=' "${SRC}/dotenv" | tail -n 1 | sha256sum)"
      if [ "$_cur" != "$_old" ]; then
        warn "La clé de chiffrement du .env actuel n'est pas celle de la sauvegarde."
        if [ "$YES" -eq 1 ] || confirm "Remettre aussi le .env de la sauvegarde (conseillé : sinon les secrets enregistrés seraient illisibles) ?" o; then
          WITH_ENV=1
        fi
      fi
    fi
  fi
fi

if [ "$YES" -ne 1 ]; then
  echo ""
  echo "  Les données actuelles du hub (base et fichiers des sites) vont être remplacées"
  echo "  par celles du ${B_DATE}. Une copie de l'état actuel est faite avant."
  confirm "Continuer ?" n || { echo "  Annulé, rien n'a changé."; exit 0; }
fi

# --- Copie de l'état courant ---
if [ "$SAFETY" -eq 1 ] && [ -f "$DB" ]; then
  log "Sauvegarde de l'état actuel avant restauration..."
  SAFETY_PATH="$(sh "${SCRIPT_DIR}/backup.sh" --tag avant-restauration)" \
    || die "La sauvegarde de l'état actuel a échoué : restauration annulée, rien n'a changé."
  ok "État actuel gardé : ${SAFETY_PATH}"
fi

# --- Remplacement ---
stop_app
STOPPED=1
log "Remplacement de la base et des fichiers des sites..."
DATA_PARENT="$(dirname "$DATA")"
mkdir -p "$DATA_PARENT"
NEW_DATA="$(mktemp -d "${DATA_PARENT}/.restauration.XXXXXX")"
tar -C "$NEW_DATA" -xzf "${SRC}/data.tar.gz" --no-same-owner
OLD_DATA="${DATA}.avant-restauration"
rm -rf "$OLD_DATA"
if [ -d "$DATA" ]; then
  mv "$DATA" "$OLD_DATA"
fi
mv "$NEW_DATA" "$DATA"
# Base hors du dossier des données : anciens fichiers -wal/-shm retirés, sinon SQLite les rejouerait.
rm -f "$DB" "${DB}-wal" "${DB}-shm" "${DB}-journal"
mkdir -p "$(dirname "$DB")"
mv "${STAGE}/hub.db" "$DB"
chown -R "${KH_USER}:${KH_GROUP}" "$DATA" "$DB"
chmod 750 "$DATA"
chmod 640 "$DB"
ok "Base et fichiers remis."

if [ "$WITH_ENV" -eq 1 ] && [ -f "${SRC}/dotenv" ]; then
  if [ -f "$KH_ENV_FILE" ]; then
    cp "$KH_ENV_FILE" "${KH_ENV_FILE}.avant-restauration"
    chmod 600 "${KH_ENV_FILE}.avant-restauration"
  fi
  cp "${SRC}/dotenv" "$KH_ENV_FILE"
  env_fix_perms
  ok ".env de la sauvegarde remis (l'ancien : ${KH_ENV_FILE}.avant-restauration)."
fi

# Code plus récent que la sauvegarde : ses migrations sont appliquées à la base remise.
if ! db_migrate; then
  warn "Les migrations ont échoué sur la base remise."
fi

if access_configured; then
  rc-service "$KH_SERVICE" start >/dev/null 2>&1 || true
  if wait_health; then
    rm -rf "$OLD_DATA"
    ok "Restauration terminée."
  else
    show_app_errors
    warn "Le hub ne répond pas après la restauration."
    echo "  L'ancien dossier des fichiers est gardé : ${OLD_DATA}"
    if [ -n "${SAFETY_PATH:-}" ]; then
      echo "  Pour revenir à l'état d'avant : hubctl restore ${SAFETY_PATH}"
    fi
    exit 1
  fi
else
  rm -rf "$OLD_DATA"
  warn "Données remises, mais Cloudflare Access n'est pas renseigné : le hub reste arrêté (hubctl secrets access)."
fi
