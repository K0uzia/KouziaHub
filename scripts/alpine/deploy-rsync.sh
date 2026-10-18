#!/bin/sh
# Depuis le PC de développement : copie le code vers le CT par rsync, puis lance la mise à jour
# sur le CT (sans GitHub). Exige rsync et ssh sur le PC, et une installation déjà faite sur le CT.
#
#   sh scripts/alpine/deploy-rsync.sh root@<ip-du-ct> [--dry-run] [--skip-update]
#   make alpine-deploy HOST=root@<ip-du-ct>
# Les données, le .env et node_modules du CT ne sont jamais touchés (conf/rsync-exclude.txt). Fichiers
# reçus au nom de root (--no-owner) ; update.sh reprend ensuite les droits avant toute exécution.

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_DIR="${KH_REMOTE_DIR:-/opt/kouziahub}"
REMOTE=""
DRY_RUN=0
SKIP_UPDATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-update) SKIP_UPDATE=1; shift ;;
    --dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Option inconnue : $1" >&2; exit 1 ;;
    *) [ -z "$REMOTE" ] || { echo "Argument en trop : $1" >&2; exit 1; }; REMOTE="$1"; shift ;;
  esac
done

[ -n "$REMOTE" ] || { echo "Usage : sh scripts/alpine/deploy-rsync.sh root@<ip-du-ct>" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "rsync est nécessaire sur ce PC." >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "ssh est nécessaire sur ce PC." >&2; exit 1; }

echo "==> Copie du code vers ${REMOTE}:${REMOTE_DIR}"
if [ "$DRY_RUN" -eq 1 ]; then
  rsync -az --no-owner --no-group --delete --dry-run --itemize-changes --exclude-from="${SCRIPT_DIR}/conf/rsync-exclude.txt" "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"
  echo "Simulation terminée, rien n'a été copié."
  exit 0
fi
rsync -az --no-owner --no-group --delete --exclude-from="${SCRIPT_DIR}/conf/rsync-exclude.txt" "${ROOT}/" "${REMOTE}:${REMOTE_DIR}/"

if [ "$SKIP_UPDATE" -eq 1 ]; then
  echo "Copie faite, mise à jour non lancée."
  exit 0
fi
echo "==> Mise à jour sur le CT"
ssh -t "$REMOTE" "KH_APP_DIR='${REMOTE_DIR}' sh '${REMOTE_DIR}/scripts/alpine/update.sh' --no-git"
echo "Vérifier : ssh ${REMOTE} hubctl status"
