#!/bin/sh
# Réglages du hub, rejouables à tout moment. Aucune valeur saisie n'est affichée ni journalisée.
#
#   hubctl cloudflare        jeton du tunnel Cloudflare du hub (propre au hub, distinct de l'ERP)
#   hubctl secrets access    Cloudflare Access : domaine d'équipe, AUD, adresse attendue
#   hubctl secrets api       API Cloudflare : jeton, identifiant de compte, identifiant de zone
#   hubctl secrets veille    jeton de lecture des zones (surveillance : détection des domaines)
#   hubctl secrets github    jeton GitHub en lecture seule (dépôt privé, pour hubctl update)
#   hubctl secrets           les deux
#   hubctl chromium          installer Chromium pour les vignettes automatiques (facultatif)

set -eu

SELF="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

SECTION="${1:-}"
NO_RESTART=0
[ "${2:-}" != "--no-restart" ] || NO_RESTART=1

present() {
  if env_has "$1"; then echo "renseigné"; else echo "vide"; fi
}

# --- Tunnel ---

# Le collage peut être le jeton seul ou toute la commande « cloudflared service install eyJ... ».
extract_tunnel_token() {
  set -f
  for _w in $1; do
    _w="$(printf '%s' "$_w" | tr -d "\"'")"
    _w="${_w#--token=}"
    case "$_w" in
      eyJ*)
        if printf '%s' "$_w" | grep -Eq '^[A-Za-z0-9_=+/-]{50,}$'; then
          set +f
          printf '%s' "$_w"
          return 0
        fi
        ;;
    esac
  done
  set +f
  return 1
}

install_cloudflared() {
  if [ -x "$KH_CLOUDFLARED_BIN" ]; then
    return 0
  fi
  case "$(uname -m)" in
    x86_64|amd64) _arch=amd64 ;;
    aarch64|arm64) _arch=arm64 ;;
    *) die "Processeur $(uname -m) non prévu pour cloudflared." ;;
  esac
  log "Téléchargement de cloudflared (GitHub, version officielle de Cloudflare)..."
  _tmp="$(mktemp)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${_arch}" -o "$_tmp" \
    || { rm -f "$_tmp"; die "Téléchargement de cloudflared impossible (réseau)."; }
  install -o root -g root -m 755 "$_tmp" "$KH_CLOUDFLARED_BIN"
  rm -f "$_tmp"
  ok "cloudflared installé : $("$KH_CLOUDFLARED_BIN" --version 2>/dev/null | head -n 1)"
}

configure_tunnel() {
  title "Tunnel Cloudflare du hub"
  cat <<EOF
  Dans Cloudflare : Zero Trust > Networks (Réseaux) > Tunnels > Create a tunnel > Cloudflared.
    1. Nom du tunnel : kouziahub (un tunnel à lui, pas celui de l'ERP).
    2. Copier la commande d'installation affichée (elle contient une longue suite qui commence par eyJ).
    3. Nom d'hôte public : hub.kouzia.com  >  service HTTP  >  127.0.0.1:$(api_port)
  Collez ici la commande entière ou seulement le jeton eyJ... La saisie reste invisible.
EOF
  if [ -s "$KH_TUNNEL_TOKEN_FILE" ]; then
    echo "  (un jeton est déjà enregistré ; Entrée sans rien coller = le garder)"
  fi
  ask_secret RAW "Jeton du tunnel"
  if [ -z "$RAW" ]; then
    if [ -s "$KH_TUNNEL_TOKEN_FILE" ]; then
      ok "Jeton actuel gardé."
    else
      warn "Rien de collé : tunnel non configuré (plus tard : hubctl cloudflare)."
      return 0
    fi
  else
    if ! TOKEN="$(extract_tunnel_token "$RAW")"; then
      _len="${#RAW}"
      RAW=""
      warn "Ce n'est pas un jeton de tunnel (${_len} caractères reçus). Il commence par eyJ et fait plus de 100 caractères."
      warn "Attention à ne pas coller l'identifiant du tunnel (forme 1234abcd-....) : il faut la commande d'installation."
      return 1
    fi
    RAW=""
    mkdir -p "$KH_ETC_DIR"
    chmod 700 "$KH_ETC_DIR"
    _tmp="$(mktemp "${KH_ETC_DIR}/.tunnel.XXXXXX")"
    chmod 600 "$_tmp"
    printf '%s\n' "$TOKEN" > "$_tmp"
    mv -f "$_tmp" "$KH_TUNNEL_TOKEN_FILE"
    chmod 600 "$KH_TUNNEL_TOKEN_FILE"
    TOKEN=""
    ok "Jeton du tunnel enregistré (${KH_TUNNEL_TOKEN_FILE}, lisible par root seulement)."
  fi

  install_cloudflared
  install -o root -g root -m 755 "${KH_LIB_DIR}/openrc/cloudflared" /etc/init.d/cloudflared
  rc-update add cloudflared default >/dev/null 2>&1 || true
  rc_service cloudflared restart >/dev/null 2>&1 || rc_service cloudflared start >/dev/null 2>&1 || true
  sleep 3
  if service_running cloudflared; then
    ok "Tunnel démarré. Dans Cloudflare, il doit passer « Healthy » d'ici une minute."
  else
    warn "Le tunnel ne démarre pas. Journal :"
    tail -n 15 "${KH_LOG_DIR}/cloudflared.err" 2>/dev/null | sed 's/^/    /' || true
    return 1
  fi
}

# --- Cloudflare Access ---

configure_access() {
  title "Cloudflare Access devant hub.kouzia.com (facultatif)"
  cat <<EOF
  Facultatif : sans Access, le hub est protégé par son login (mot de passe et code à 6 chiffres),
  comme l'ERP. Si vous l'ajoutez, le hub vérifie lui-même le passage par Access. Il lui faut :
    - le domaine d'équipe : Zero Trust > Settings (Réglages) > « Team domain »,
      de la forme <nom>.cloudflareaccess.com (le <nom> seul suffit) ;
    - l'AUD : Zero Trust > Access > Applications > l'application hub.kouzia.com >
      « Application Audience (AUD) Tag » (64 caractères).
  État : domaine d'équipe $(present CF_ACCESS_TEAM_DOMAIN), AUD $(present CF_ACCESS_AUD), adresse $(present CF_ACCESS_EMAIL).
  Entrée sans rien saisir = garder la valeur actuelle. La saisie reste invisible.
EOF
  ask_secret V "Domaine d'équipe"
  if [ -n "$V" ]; then
    V="$(printf '%s' "$V" | tr '[:upper:]' '[:lower:]' | sed -e 's#^https\{0,1\}://##' -e 's#/.*$##')"
    case "$V" in *.cloudflareaccess.com) ;; *) V="${V}.cloudflareaccess.com" ;; esac
    printf '%s' "$V" | grep -Eq '^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$' \
      || die "Domaine d'équipe invalide (attendu : <nom>.cloudflareaccess.com). Rien n'a changé."
    env_set CF_ACCESS_TEAM_DOMAIN "$V"
    ok "Domaine d'équipe enregistré."
  fi
  ask_secret V "AUD de l'application"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[0-9a-fA-F]{64}$' \
      || die "AUD invalide (${#V} caractères reçus, 64 attendus, chiffres et lettres a à f)."
    env_set CF_ACCESS_AUD "$V"
    ok "AUD enregistré."
  fi
  echo "  Facultatif : votre adresse e-mail, contrôlée en plus de la règle Access."
  ask_secret V "Adresse e-mail autorisée (Entrée = garder / passer)"
  if [ -n "$V" ]; then
    V="$(printf '%s' "$V" | tr '[:upper:]' '[:lower:]')"
    printf '%s' "$V" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "Adresse e-mail invalide."
    env_set CF_ACCESS_EMAIL "$V"
    ok "Adresse enregistrée."
  fi
  V=""
}

# --- Lien avec l'ERP (lecture seule des clients) ---

configure_erp() {
  title "Lien avec l'ERP (lecture des clients)"
  cat <<EOF
  Le hub lit la liste des clients sur l'écouteur dédié de l'ERP : port 3100, sur l'IP du CT de
  l'ERP dans le réseau local du Proxmox (jamais par Internet). Dans Proxmox, sur le CT de l'ERP,
  une règle du pare-feu n'ouvre le port 3100 qu'à l'IP de ce CT du hub.
  Le secret partagé : une seule valeur, posée à l'identique dans le .env de l'ERP (HUB_READ_SECRET).
  Pour la créer : openssl rand -hex 32 (sur un des deux CT), puis la coller ici et côté ERP.
  Côté ERP, aussi : HUB_LISTEN=<IP du CT ERP>:3100 et HUB_ALLOWED_IPS=<IP de ce CT>, puis
  kouziactl restart. Sans eux, l'ERP n'ouvre pas l'écouteur. Les deux CT en IP fixe (README, 2.d).
  État : adresse de l'ERP $(present ERP_BASE_URL), secret $(present HUB_READ_SECRET), lien vers les fiches $(present ERP_PUBLIC_ORIGIN).
  Entrée sans rien saisir = garder la valeur actuelle.
EOF
  ask V "IP du CT de l'ERP sur le réseau local (ex. 203.0.113.20)"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "IP invalide (4 nombres séparés par des points). Rien n'a changé."
    env_set ERP_BASE_URL "http://${V}:3100"
    ok "Adresse de l'ERP enregistrée (port 3100)."
  fi
  ask_secret V "Secret partagé avec l'ERP (invisible)"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[A-Za-z0-9+/=_-]{32,200}$' \
      || die "Secret invalide (${#V} caractères reçus, 32 au moins). Rien n'a changé."
    env_set HUB_READ_SECRET "$V"
    ok "Secret enregistré."
  fi
  ask V "Adresse de l'ERP dans le navigateur, pour le lien vers les fiches" "https://erp.kouzia.com"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^https://[A-Za-z0-9.-]+$' || die "Adresse invalide (attendu : https://nom.domaine)."
    env_set ERP_PUBLIC_ORIGIN "$V"
  fi
  V=""
  if env_has ERP_BASE_URL && ! env_has HUB_READ_SECRET; then
    warn "Adresse de l'ERP posée sans secret : le hub refuse de démarrer tant que le secret manque."
  fi
}

# --- Jeton de lecture des zones (surveillance) ---

configure_veille() {
  title "Jeton de lecture des zones Cloudflare (surveillance)"
  cat <<EOF
  Il sert seulement à lister vos domaines Cloudflare pour proposer de les surveiller ; rien n'est
  ajouté sans votre accord. C'est un jeton à part, distinct du jeton API du hub.
  Le créer : Cloudflare > My Profile > API Tokens > Create Token > Custom token, avec SEULEMENT :
    - Zone > Zone > Read        (Zone Resources : All zones)
  Expiration : dans un an.
  État : jeton $(present CLOUDFLARE_ZONES_READ_TOKEN).
  Entrée sans rien saisir = garder la valeur actuelle. La saisie reste invisible.
EOF
  ask_secret V "Jeton de lecture des zones"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[A-Za-z0-9_.-]{30,200}$' \
      || die "Jeton invalide (${#V} caractères reçus). Rien n'a changé."
    env_set CLOUDFLARE_ZONES_READ_TOKEN "$V"
    ok "Jeton de lecture des zones enregistré."
  fi
  V=""
}

# --- Jeton GitHub (dépôt privé) ---

configure_github() {
  title "Jeton GitHub en lecture seule (mises à jour)"
  cat <<EOF
  Le dépôt du hub est privé : « hubctl update » a besoin d'un jeton pour récupérer le code.
  Le créer (README 1.2) : GitHub > Settings > Developer settings > Personal access tokens >
  Fine-grained tokens > Generate new token, avec SEULEMENT :
    - Repository access : Only select repositories > K0uzia/KouziaHub
    - Repository permissions : Contents > Read-only
  Expiration : un an. Le jeton commence par github_pat_.
  Il est gardé dans ${KH_GITHUB_TOKEN_FILE}, lisible par root seulement, jamais dans le .env.
EOF
  if [ -s "$KH_GITHUB_TOKEN_FILE" ]; then
    echo "  (un jeton est déjà enregistré ; Entrée sans rien coller = le garder)"
  fi
  ask_secret V "Jeton GitHub"
  if [ -z "$V" ]; then
    if [ -s "$KH_GITHUB_TOKEN_FILE" ]; then
      ok "Jeton actuel gardé."
    else
      warn "Rien de collé : jeton non posé (plus tard : hubctl secrets github)."
    fi
    return 0
  fi
  # Fine-grained seulement : un jeton classique (ghp_) ouvre tous les dépôts du compte.
  if ! printf '%s' "$V" | grep -Eq '^github_pat_[A-Za-z0-9_]{40,250}$'; then
    _len="${#V}"
    V=""
    die "Ce n'est pas un jeton fine-grained (${_len} caractères reçus, il commence par github_pat_). Rien n'a changé."
  fi
  mkdir -p "$KH_ETC_DIR"
  chmod 700 "$KH_ETC_DIR"
  _prev=""
  if [ -s "$KH_GITHUB_TOKEN_FILE" ]; then
    _prev="$(mktemp "${KH_ETC_DIR}/.github-prev.XXXXXX")"
    cp -p "$KH_GITHUB_TOKEN_FILE" "$_prev"
  fi
  _tmp="$(mktemp "${KH_ETC_DIR}/.github.XXXXXX")"
  chmod 600 "$_tmp"
  printf '%s' "$V" > "$_tmp"
  V=""
  chown root:root "$_tmp"
  mv -f "$_tmp" "$KH_GITHUB_TOKEN_FILE"
  log "Essai du jeton auprès de GitHub..."
  if git_with_github_token ls-remote --heads "$KH_REPO_URL" "$KH_REPO_BRANCH" >/dev/null 2>&1; then
    rm -f "$_prev"
    ok "Jeton GitHub accepté et enregistré (${KH_GITHUB_TOKEN_FILE}, lisible par root seulement)."
  else
    if [ -n "$_prev" ]; then mv -f "$_prev" "$KH_GITHUB_TOKEN_FILE"; else rm -f "$KH_GITHUB_TOKEN_FILE"; fi
    die "GitHub refuse ce jeton (ou le réseau ne répond pas) : droits, dépôt choisi ou expiration à vérifier. Rien n'a changé."
  fi

  echo "  Date d'expiration du jeton, affichée par GitHub (AAAA-MM-JJ), pour être prévenu 30 jours avant."
  ask EXP "Expiration (facultatif, Entrée = ne pas suivre)" ""
  if [ -n "$EXP" ]; then
    if iso_day_ok "$EXP"; then
      state_set github-token-expires "$EXP"
      ok "Expiration notée : $EXP (hubctl status prévient 30 jours avant)."
    else
      warn "Date non reconnue ($EXP) : expiration non suivie (relancer hubctl secrets github pour la saisir)."
      state_set github-token-expires ""
    fi
  else
    state_set github-token-expires ""
  fi
}

# --- API Cloudflare ---

configure_api() {
  title "Jeton API Cloudflare (création des sites)"
  cat <<EOF
  Sans jeton, le hub fonctionne en mode simulé : rien n'est créé chez Cloudflare.
  Créer le jeton : Cloudflare > My Profile > API Tokens > Create Token > Custom token, avec
  SEULEMENT ces droits :
    - Account > Cloudflare Pages > Edit       (Account Resources : votre compte seulement)
    - Zone > DNS > Edit                        (Zone Resources : Specific zone > kouzia.com)
    - Zone > Cache Purge > Purge               (même zone : bouton « Purger le cache Cloudflare »)
  Sans ce dernier droit, tout marche sauf la purge du cache (le hub le dit).
  Expiration : dans un an. Filtrage par adresse IP : oui si l'IP de la box est fixe.
  Identifiants : page de kouzia.com dans Cloudflare, colonne de droite, rubrique « API »
  (Zone ID et Account ID, 32 caractères chacun).
  État : jeton $(present CLOUDFLARE_API_TOKEN), compte $(present CLOUDFLARE_ACCOUNT_ID), zone $(present CLOUDFLARE_ZONE_ID).
  Entrée sans rien saisir = garder la valeur actuelle. La saisie reste invisible.
EOF
  ask_secret V "Jeton API"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[A-Za-z0-9_.-]{30,200}$' \
      || die "Jeton invalide (${#V} caractères reçus). Rien n'a changé."
    env_set CLOUDFLARE_API_TOKEN "$V"
    ok "Jeton API enregistré."
  fi
  ask_secret V "Account ID"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[0-9a-fA-F]{32}$' || die "Account ID invalide (${#V} caractères reçus, 32 attendus)."
    env_set CLOUDFLARE_ACCOUNT_ID "$V"
    ok "Account ID enregistré."
  fi
  ask_secret V "Zone ID de kouzia.com"
  if [ -n "$V" ]; then
    printf '%s' "$V" | grep -Eq '^[0-9a-fA-F]{32}$' || die "Zone ID invalide (${#V} caractères reçus, 32 attendus)."
    env_set CLOUDFLARE_ZONE_ID "$V"
    ok "Zone ID enregistré."
  fi
  V=""
  if env_has CLOUDFLARE_API_TOKEN && { ! env_has CLOUDFLARE_ACCOUNT_ID || ! env_has CLOUDFLARE_ZONE_ID; }; then
    warn "Jeton présent mais identifiant de compte ou de zone vide : à compléter (hubctl secrets api)."
  fi
  echo "  Pensez à noter la date d'expiration du jeton : il faudra le remplacer avant (même commande)."
}

# --- Chromium (vignettes) ---

configure_chromium() {
  title "Vignettes automatiques (Chromium, facultatif)"
  echo "  Chromium prend environ 300 Mo. Sans lui, vous envoyez vous-même une image par site."
  if [ "${KH_ASSUME_YES:-0}" != "1" ]; then
    confirm "Installer Chromium ?" n || { echo "  Pas de Chromium : vignettes envoyées à la main."; return 0; }
  fi
  disk_guard / 600
  # doas : seul moyen pour un compte non root de passer sous un autre compte, limité à une commande
  # (su-exec exige root). nftables : filtre de la sortie réseau du compte de Chromium.
  apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont doas nftables
  if [ ! -x /usr/bin/chromium-browser ] && [ ! -x /usr/bin/chromium ]; then
    die "Chromium installé mais introuvable."
  fi
  [ -x "$KH_CHROMIUM_LAUNCH" ] || die "Lanceur absent : ${KH_CHROMIUM_LAUNCH} (hubctl update)."
  setup_chromium_isolation
  if chromium_selftest; then
    ok "Chromium lancé sous le compte ${KH_CHROMIUM_USER} (essai réussi)."
  else
    warn "Essai de lancement par doas en échec : vignettes indisponibles tant que ce n'est pas corrigé (hubctl status)."
  fi
  install -o root -g root -m 755 "${KH_LIB_DIR}/openrc/${KH_FIREWALL_SERVICE}" "/etc/init.d/${KH_FIREWALL_SERVICE}"
  apply_firewall || true
  ok "Chromium installé : HUB_CHROMIUM_PATH=${KH_CHROMIUM_LAUNCH}, compte ${KH_CHROMIUM_USER}."
}

restart_if_needed() {
  [ "$NO_RESTART" -eq 0 ] || return 0
  if service_exists "$KH_SERVICE"; then
    restart_app || { show_app_errors; return 1; }
  fi
}

require_root
case "$SECTION" in
  cloudflare|tunnel)
    configure_tunnel
    ;;
  access)
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_access
    restart_if_needed
    ;;
  api)
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_api
    restart_if_needed
    ;;
  erp)
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_erp
    restart_if_needed
    ;;
  veille)
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_veille
    restart_if_needed
    ;;
  github)
    configure_github
    ;;
  secrets|"")
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_api
    restart_if_needed
    ;;
  chromium)
    [ -f "$KH_ENV_FILE" ] || die ".env absent : lancer « hubctl install »."
    configure_chromium
    restart_if_needed
    ;;
  *)
    die "Réglage inconnu : $SECTION (cloudflare, secrets, secrets access, secrets api, secrets erp, secrets veille, secrets github, chromium)"
    ;;
esac
