#!/bin/sh
# État du hub : service, santé, migrations en attente, réglages, disque, sauvegardes, tunnel.
# Aucune valeur secrète n'est affichée (seulement « renseigné » ou « vide »).

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

svc_state() {
  if ! service_exists "$1"; then
    echo "non installé"
  elif rc-service "$1" status >/dev/null 2>&1; then
    echo "lancé"
  else
    _st="$(rc-service "$1" status 2>&1 | sed -n "s/.*status: *//p" | head -n 1)"
    echo "${_st:-arrêté}"
  fi
}

yes_no() {
  if env_has "$1"; then echo "renseigné"; else echo "vide"; fi
}

title "Hub Kouzia"
echo "  Machine   : $(hostname) (Alpine $(cat /etc/alpine-release 2>/dev/null || echo '?'))"
LAST_UPDATE="$(state_get last-update)"
echo "  Version   : $(current_commit)   dernière mise à jour : ${LAST_UPDATE:-jamais}"
echo "  Node      : $(node -v 2>/dev/null || echo absent)"

title "Services"
echo "  Hub (kouziahub)        : $(svc_state "$KH_SERVICE")"
echo "  Tunnel (cloudflared)   : $(svc_state "$KH_TUNNEL_SERVICE")"
echo "  Tâches planifiées      : $(svc_state crond)"

title "Santé"
URL="$(health_url)"
if BODY="$(curl -4 -fsS --connect-timeout 2 --max-time 5 "$URL" 2>/dev/null)"; then
  case "$BODY" in
    *'"ok":true'*) ok "Le hub répond ($URL)" ;;
    *) warn "Réponse inattendue de $URL" ;;
  esac
  PENDING="$(printf '%s' "$BODY" | sed -n 's/.*"pendingMigrations":\([0-9]*\).*/\1/p')"
else
  warn "Le hub ne répond pas ($URL). Journal : hubctl logs erreurs"
  PENDING=""
fi

# Migrations : selon le hub s'il répond, sinon comparaison des dossiers et de la base.
DB="$(db_path)"
if [ -z "$PENDING" ] && [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  APPLIED="$(sqlite3 -cmd ".timeout 3000" "$DB" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null || true)"
  sqlite_fix_owner "$DB"
  PENDING=0
  for _m in "${KH_APP_DIR}"/prisma/migrations/*/; do
    [ -f "${_m}migration.sql" ] || continue
    _name="$(basename "$_m")"
    printf '%s\n' "$APPLIED" | grep -qx "$_name" || PENDING=$((PENDING + 1))
  done
fi
if [ -n "$PENDING" ] && [ "$PENDING" -gt 0 ]; then
  warn "Migrations en attente : ${PENDING} (hubctl update)"
elif [ -n "$PENDING" ]; then
  echo "  Migrations en attente : aucune"
fi

title "Réglages (valeurs jamais affichées)"
echo "  Cloudflare Access      : domaine $(yes_no CF_ACCESS_TEAM_DOMAIN), AUD $(yes_no CF_ACCESS_AUD)"
if env_has CLOUDFLARE_API_TOKEN; then
  echo "  API Cloudflare         : jeton renseigné, compte $(yes_no CLOUDFLARE_ACCOUNT_ID), zone $(yes_no CLOUDFLARE_ZONE_ID)"
else
  echo "  API Cloudflare         : pas de jeton, mode simulé (hubctl secrets api)"
fi
if [ -s "$KH_TUNNEL_TOKEN_FILE" ]; then
  echo "  Jeton du tunnel        : renseigné"
else
  echo "  Jeton du tunnel        : vide (hubctl cloudflare)"
fi
CHROMIUM="$(env_get HUB_CHROMIUM_PATH)"
if [ -n "$CHROMIUM" ] && [ -x "$CHROMIUM" ]; then
  echo "  Vignettes              : automatiques (Chromium)"
elif [ -n "$CHROMIUM" ]; then
  warn "Vignettes : HUB_CHROMIUM_PATH indique $CHROMIUM, introuvable (hubctl chromium)"
else
  echo "  Vignettes              : image envoyée à la main (hubctl chromium pour l'automatique)"
fi
echo "  Lien avec l'ERP        : $(yes_no ERP_BASE_URL)"

title "Surveillance"
if env_has VAPID_PUBLIC_KEY && env_has VAPID_PRIVATE_KEY; then
  echo "  Clés des notifications : renseignées"
else
  echo "  Clés des notifications : absentes (hubctl push-keys)"
fi
if env_has MONITOR_WORKER_URL && env_has MONITOR_SHARED_SECRET; then
  echo "  Veille Cloudflare      : configurée ($(env_get MONITOR_WORKER_URL))"
elif env_has MONITOR_WORKER_URL; then
  warn "Veille Cloudflare : adresse posée mais secret partagé absent (hubctl veille deploy)"
else
  echo "  Veille Cloudflare      : non configurée (hubctl veille deploy)"
fi
echo "  Lecture des zones      : jeton $(yes_no CLOUDFLARE_ZONES_READ_TOKEN) (hubctl secrets veille, facultatif)"

title "Disque"
df -hP "$KH_APP_DIR" "$KH_BACKUP_DIR" 2>/dev/null | awk 'NR==1 || !seen[$1]++' | sed 's/^/  /'
if [ -f "$DB" ]; then
  echo "  Base     : $(du -h "$DB" | awk '{print $1}')   Fichiers des sites : $(du -sh "$(data_dir)" 2>/dev/null | awk '{print $1}')"
fi

title "Sauvegardes"
LAST="$(list_backups | head -n 1)"
COUNT="$(list_backups | wc -l | tr -d ' ')"
if [ -n "$LAST" ]; then
  echo "  Dernière : $(basename "$LAST")"
  echo "  Total    : ${COUNT} sauvegarde(s), $(du -sh "$KH_BACKUP_DIR" 2>/dev/null | awk '{print $1}') dans $KH_BACKUP_DIR (les ${KH_BACKUP_KEEP} plus récentes sont gardées)"
  # Plus de deux jours sans sauvegarde : la tâche quotidienne ne tourne plus.
  if [ -z "$(find "$LAST" -maxdepth 0 -mtime -2 2>/dev/null)" ]; then
    warn "Aucune sauvegarde depuis plus de deux jours : vérifier crond (rc-service crond status) et « hubctl logs sauvegarde »."
  fi
else
  warn "Aucune sauvegarde pour l'instant (hubctl backup)."
fi

title "Tunnel"
if service_exists "$KH_TUNNEL_SERVICE"; then
  echo "  cloudflared : $("$KH_CLOUDFLARED_BIN" --version 2>/dev/null | head -n 1 || echo absent)"
  _last="$(grep -h 'Registered tunnel connection' "${KH_LOG_DIR}/cloudflared.err" "${KH_LOG_DIR}/cloudflared.log" 2>/dev/null | tail -n 1 | cut -c1-25)"
  if [ -n "$_last" ]; then
    echo "  Dernière connexion à Cloudflare : ${_last}"
  else
    warn "Pas de connexion à Cloudflare dans le journal (hubctl logs tunnel)."
  fi
else
  echo "  Pas encore installé (hubctl cloudflare)."
fi
echo ""
