#!/bin/sh
# Mise à jour du hub, en un geste :
#   arrêt, sauvegarde automatique, code depuis GitHub, npm ci seulement si package-lock.json a changé,
#   prisma migrate deploy puis generate, build de l'interface, redémarrage, contrôle de santé.
#   Si le hub ne répond pas : retour arrière guidé (code d'avant et sauvegarde d'avant).
#
#   hubctl update              mise à jour normale
#   hubctl update --no-git     code déjà copié sur le CT (rsync), pas de GitHub
#   hubctl update --force      npm ci même si package-lock.json n'a pas changé
#   hubctl rollback            revenir à la version d'avant la dernière mise à jour

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

DO_GIT=auto
FORCE_DEPS=0
SKIP_BACKUP=0
ROLLBACK=0
YES=0
RESUMED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --git) DO_GIT=1; shift ;;
    --no-git) DO_GIT=0; shift ;;
    --force) FORCE_DEPS=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --yes) YES=1; shift ;;
    --resumed) RESUMED=1; shift ;;
    -h|--help) sed -n '2,10p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done
if [ "$DO_GIT" = "auto" ]; then
  if is_git_install; then DO_GIT=1; else DO_GIT=0; fi
fi

require_root
require_alpine
require_cmd curl sqlite3 npm git
[ -f "${KH_APP_DIR}/package.json" ] || die "Hub introuvable dans $KH_APP_DIR (lancer « hubctl install »)."

# Quelle que soit l'erreur, le hub n'est jamais laissé arrêté par une mise à jour interrompue.
on_exit() {
  _rc=$?
  if [ "$_rc" -ne 0 ] && service_exists "$KH_SERVICE"; then
    rc_service "$KH_SERVICE" start >/dev/null 2>&1 || true
  fi
}
trap on_exit EXIT
trap_signals
# Une seule opération à la fois (mise à jour, restauration, installation, sauvegarde) ; le verrou suit exec.
ops_lock refuse

# --- Retour arrière : code d'avant, dépendances et interface reconstruites, sauvegarde d'avant ---
do_rollback() {
  _prev="$(state_get previous-commit)"
  _bak="$(state_get pre-update-backup)"
  if [ -z "$_bak" ] || [ ! -d "$_bak" ]; then
    die "Aucune sauvegarde d'avant mise à jour enregistrée : retour arrière impossible (voir « hubctl restore »)."
  fi
  title "Retour à la version d'avant la mise à jour"
  echo "  Code      : ${_prev:-inchangé (installation sans git)}"
  echo "  Données   : $(basename "$_bak")"
  echo "  Les changements faits dans le hub depuis cette sauvegarde seront perdus."
  if [ "$YES" -ne 1 ]; then
    confirm "Revenir en arrière maintenant ?" o || { echo "  Annulé."; exit 1; }
  fi
  stop_app
  if [ -n "$_prev" ] && is_git_install; then
    log "Code remis à la version ${_prev}..."
    git_in_app checkout -f -B "$KH_REPO_BRANCH" "$_prev" || die "Impossible de remettre le code ${_prev}."
  fi
  fix_ownership
  if deps_needed; then
    npm_ci || die "npm ci a échoué pendant le retour arrière (voir le message ci-dessus)."
  fi
  db_generate || die "prisma generate a échoué pendant le retour arrière."
  build_web || die "Le build de l'interface a échoué pendant le retour arrière."
  install_root_scripts
  install_openrc_scripts
  # restore.sh remet base et fichiers, applique les migrations de ce code, redémarre et contrôle.
  sh "${SCRIPT_DIR}/restore.sh" --yes --no-safety-backup --no-env "$_bak" \
    || die "Le hub ne répond toujours pas après le retour arrière : envoyer « hubctl logs erreurs » au développeur."
  ok "Retour arrière terminé : version $(current_commit), données du $(sed -n 's/^date=//p' "${_bak}/manifest.txt")."
}

if [ "$ROLLBACK" -eq 1 ]; then
  do_rollback
  exit 0
fi

# Échec après le changement de code : proposer le retour arrière, sinon relancer ce qui peut l'être.
fail_update() {
  warn "$1"
  show_app_errors
  if [ -t 0 ] && [ -n "$(state_get pre-update-backup)" ]; then
    echo ""
    if confirm "Revenir à la version d'avant (code et données d'avant la mise à jour) ?" o; then
      YES=1
      do_rollback
      exit 1
    fi
  fi
  echo "  Plus tard : « hubctl rollback » remet la version d'avant ; « hubctl logs erreurs » montre l'erreur."
  rc_service "$KH_SERVICE" start >/dev/null 2>&1 || true
  exit 1
}

if [ "$RESUMED" -eq 0 ]; then
  require_node_min
  disk_guard "$KH_APP_DIR" 500

  title "Mise à jour du hub"
  log "Version actuelle : $(current_commit)"

  # Arrêt avant la sauvegarde : rien n'est écrit entre la copie et la mise à jour.
  stop_app

  # Une sauvegarde d'une mise à jour plus ancienne ne doit jamais servir de retour arrière à celle-ci.
  rm -f "${KH_STATE_DIR}/pre-update-backup" "${KH_STATE_DIR}/previous-commit"
  _db="$(db_path)" || exit 1
  if [ "$SKIP_BACKUP" -eq 0 ] && [ -f "$_db" ]; then
    log "Sauvegarde automatique avant mise à jour..."
    if ! BAK="$(sh "${SCRIPT_DIR}/backup.sh" --tag avant-maj)"; then
      rc_service "$KH_SERVICE" start >/dev/null 2>&1 || true
      die "La sauvegarde a échoué : mise à jour annulée, rien n'a changé (voir « hubctl logs sauvegarde »)."
    fi
    state_set pre-update-backup "$BAK"
    ok "Sauvegarde : $BAK"
  fi

  if is_git_install; then
    state_set previous-commit "$(git_in_app rev-parse HEAD)"
  fi

  if [ "$DO_GIT" -eq 1 ]; then
    is_git_install || die "Pas de dépôt git dans $KH_APP_DIR : utiliser « hubctl update --no-git »."
    # Un npm install de secours peut avoir réécrit le verrou : GitHub fait foi.
    git_in_app checkout HEAD -- package-lock.json 2>/dev/null || true
    git_sync_from_origin "$KH_REPO_BRANCH"
  fi
  # Code à root AVANT d'exécuter quoi que ce soit du dépôt, puis copie root des scripts : la suite
  # tourne sur les nouveaux scripts, jamais sur un fichier modifiable par le compte du service.
  fix_ownership
  install_root_scripts
  trap - EXIT
  if [ "$FORCE_DEPS" -eq 1 ]; then
    exec sh "${KH_LIB_DIR}/update.sh" --resumed --no-git --force
  fi
  exec sh "${KH_LIB_DIR}/update.sh" --resumed --no-git
fi

# Reprise des droits (idempotente ; migre une ancienne installation où le compte possédait le code).
fix_ownership
install_root_scripts
# Installation d'avant icu-data-full : posé une fois, chargé au redémarrage plus bas.
ensure_icu_full || true
# Correctif de sécurité de Node (KH_NODE_FIXED) : chargé au redémarrage plus bas ; sinon, alerte claire sans bloquer.
ensure_node_patched || true

if [ "$FORCE_DEPS" -eq 1 ] || deps_needed; then
  npm_ci || fail_update "npm ci a échoué."
else
  ok "package-lock.json inchangé : dépendances gardées"
fi
db_migrate || fail_update "Les migrations de la base ont échoué."
build_web || fail_update "La construction de l'interface a échoué."

install_openrc_scripts
install_system_conf
# Ancienne installation où le service lançait Chromium lui-même : passage au compte dédié.
if [ -n "$(env_get HUB_CHROMIUM_PATH)" ] && ! chromium_installed; then
  log "Chromium : passage à un compte dédié (doas) et au pare-feu de sortie..."
  if apk add --no-cache doas nftables >/dev/null 2>&1 && setup_chromium_isolation; then
    install -o root -g root -m 755 "${KH_LIB_DIR}/openrc/${KH_FIREWALL_SERVICE}" "/etc/init.d/${KH_FIREWALL_SERVICE}"
  else
    warn "Passage de Chromium au compte dédié impossible : relancer « hubctl chromium »."
  fi
fi
apply_firewall || true

log "Redémarrage du hub..."
rc_service "$KH_SERVICE" start >/dev/null 2>&1 || rc_service "$KH_SERVICE" restart >/dev/null 2>&1 || true
wait_health || fail_update "Le hub ne répond pas après la mise à jour."

state_set last-update "$(date '+%Y-%m-%d %H:%M') $(current_commit)"
if env_has MONITOR_WORKER_URL && [ "$(veille_src_hash)" != "$(state_get veille-src)" ]; then
  warn "La veille Cloudflare a changé dans cette version : la redéployer avec « hubctl veille deploy » (nouveau jeton de déploiement)."
fi
ok "Mise à jour terminée : version $(current_commit)."
echo "  En cas de souci plus tard : « hubctl rollback » remet la version d'avant."
