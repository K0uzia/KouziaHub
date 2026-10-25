#!/bin/sh
# Installation du CT des sites PHP (« kouziaphp », docs/cadrage.md section 11, lot P1). Rejouable : chaque
# étape vérifie l'existant et ne remplace rien qui marche. Ne crée aucun site (lot P3) et ne pose pas l'agent
# (lot P2) : nginx, PHP, MariaDB, pare-feu du CT, tunnel, outil kouziaphpctl, contrôle des cgroups.
#
# Usage, en root dans le CT : sh install.sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

trap_signals
require_root
require_alpine
alpine_at_least "$KP_ALPINE_MIN" || die "Alpine $(alpine_branch) : il faut ${KP_ALPINE_MIN} ou plus (PHP 8.2 à 8.4 dans le dépôt community). Recréer le CT avec un modèle Alpine ${KP_ALPINE_MIN} ou plus récent."
ops_lock

title "Paquets"
grep -Eq '^[^#].*/community/?$' /etc/apk/repositories || die "Dépôt « community » absent de /etc/apk/repositories (PHP s'y trouve) : décommenter sa ligne, puis relancer."
apk update >/dev/null || die "apk update a échoué (réseau du CT ?)."
apk_available "php${KP_PHP_DEFAULT}-fpm" || die "php${KP_PHP_DEFAULT}-fpm introuvable dans les dépôts : vérifier la branche d'Alpine et le dépôt community."
_pkgs="nginx mariadb mariadb-client nftables curl ca-certificates logrotate nodejs php${KP_PHP_DEFAULT} php${KP_PHP_DEFAULT}-fpm"
for _ext in $KP_PHP_EXTENSIONS; do
  _pkgs="${_pkgs} php${KP_PHP_DEFAULT}-${_ext}"
done
# shellcheck disable=SC2086
apk add --no-cache $_pkgs >/dev/null || die "Installation des paquets impossible : $(printf '%s' "$_pkgs")"
ok "nginx, MariaDB, nftables, Node.js (agent) et PHP ${KP_PHP_DEFAULT} (avec ses extensions) installés."

title "Dossiers"
mkdir -p "$KP_ETC_DIR" "$KP_LOG_DIR" "$KP_STATE_DIR" "$KP_SITES_DIR" "$KP_LIB_DIR" "$KP_NGINX_SITES_DIR"
chown root:root "$KP_ETC_DIR" "$KP_STATE_DIR" "$KP_SITES_DIR" "$KP_LIB_DIR" "$KP_NGINX_SITES_DIR"
chmod 700 "$KP_ETC_DIR" "$KP_STATE_DIR"
# Les comptes des sites traversent /srv/sites jusqu'à leur dossier, sans pouvoir le lister.
chmod 711 "$KP_SITES_DIR"
chmod 755 "$KP_LIB_DIR" "$KP_NGINX_SITES_DIR"
ok "/etc/kouziaphp, /srv/sites, /var/log/kouziaphp prêts."

title "PHP"
# Réglages communs à toutes les versions installées ; les réglages propres à un site (open_basedir, compte,
# limites) vont dans son pool, au lot P3. Le pool d'exemple « www » est retiré : aucun PHP ne tourne sans site.
for _v in $(php_versions_installed); do
  _ini="/etc/php${_v}/conf.d/90-kouziaphp.ini"
  cat > "$_ini" <<'EOF'
; Généré par kouziaphpctl (docs/cadrage.md, section 11.2). Ne pas modifier : réécrit à chaque installation.
expose_php = Off
allow_url_include = Off
display_errors = Off
display_startup_errors = Off
log_errors = On
memory_limit = 256M
max_execution_time = 30
upload_max_filesize = 32M
post_max_size = 34M
disable_functions = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec,dl
session.use_strict_mode = 1
session.cookie_httponly = 1
session.cookie_secure = 1
session.cookie_samesite = Lax
EOF
  chmod 644 "$_ini"
  _www="/etc/php${_v}/php-fpm.d/www.conf"
  if [ -f "$_www" ]; then
    mv -f "$_www" "${_www}.exemple"
  fi
  if rc-update show default 2>/dev/null | grep -q "php-fpm${_v}"; then
    rc-update del "php-fpm${_v}" default >/dev/null 2>&1 || true
  fi
  ok "PHP ${_v} : réglages durcis posés, pool d'exemple retiré."
done

title "nginx"
_default="/etc/nginx/http.d/default.conf"
if [ -f "$_default" ]; then
  mv -f "$_default" "${_default}.exemple"
fi
cat > /etc/nginx/http.d/00-kouziaphp.conf <<EOF
# Généré par kouziaphpctl (docs/cadrage.md, section 11.3). Ne pas modifier : réécrit à chaque installation.
# cloudflared (même CT) est le seul client : écoute locale. Adresse du visiteur : en-tête de Cloudflare.
set_real_ip_from 127.0.0.1;
real_ip_header CF-Connecting-IP;

# Nom inconnu : 404, jamais indexé.
server {
    listen 127.0.0.1:${KP_NGINX_PORT} default_server;
    server_name _;
    add_header X-Robots-Tag "noindex, nofollow" always;
    return 404;
}

# Un fichier par site (lot P3).
include ${KP_NGINX_SITES_DIR}/*.conf;
EOF
chmod 644 /etc/nginx/http.d/00-kouziaphp.conf
nginx -t >/dev/null 2>&1 || { nginx -t || true; die "Configuration nginx refusée (détail ci-dessus)."; }
grep -Eq '^[[:space:]]*server_tokens[[:space:]]+off;' /etc/nginx/nginx.conf || warn "server_tokens n'est pas coupé dans /etc/nginx/nginx.conf : version de nginx visible dans les en-têtes."
rc-update add nginx default >/dev/null 2>&1 || true
rc_service nginx restart >/dev/null 2>&1 || rc_service nginx start >/dev/null 2>&1 || die "nginx ne démarre pas : rc-service nginx start"
ok "nginx : écoute 127.0.0.1:${KP_NGINX_PORT}, 404 pour tout nom inconnu."

title "MariaDB"
if [ ! -d /var/lib/mysql/mysql ]; then
  rc_service mariadb setup >/dev/null 2>&1 || die "Initialisation de MariaDB impossible : rc-service mariadb setup"
fi
cat > /etc/my.cnf.d/90-kouziaphp.cnf <<'EOF'
# Généré par kouziaphpctl (docs/cadrage.md, section 11.3). Ne pas modifier : réécrit à chaque installation.
# Socket local seulement : aucune connexion réseau, même depuis le CT.
[mysqld]
skip-networking
local-infile = 0
symbolic-links = 0
innodb_buffer_pool_size = 256M
max_connections = 60
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
EOF
chmod 644 /etc/my.cnf.d/90-kouziaphp.cnf
rc-update add mariadb default >/dev/null 2>&1 || true
rc_service mariadb restart >/dev/null 2>&1 || rc_service mariadb start >/dev/null 2>&1 || die "MariaDB ne démarre pas : rc-service mariadb start"
# root entre seulement par le socket (authentification unix_socket) ; comptes anonymes et base de test retirés.
mariadb -e "DELETE FROM mysql.global_priv WHERE User=''; DROP DATABASE IF EXISTS test; FLUSH PRIVILEGES;" \
  || die "Nettoyage des comptes de MariaDB impossible."
ok "MariaDB : socket local seulement, comptes anonymes et base de test retirés."

title "Outil kouziaphpctl"
# « kouziaphpctl install » relance la copie déjà installée : rien à recopier sur elle-même.
if [ "$SCRIPT_DIR" != "$KP_LIB_DIR" ]; then
  for _f in lib.sh install.sh firewall.sh cgroups.sh status.sh tunnel.sh agent.sh kouziaphpctl; do
    install -o root -g root -m 755 "${SCRIPT_DIR}/${_f}" "${KP_LIB_DIR}/${_f}"
  done
  mkdir -p "${KP_LIB_DIR}/openrc" "${KP_LIB_DIR}/agent"
  for _f in agent.mjs sites.mjs; do
    install -o root -g root -m 644 "${SCRIPT_DIR}/agent/${_f}" "${KP_LIB_DIR}/agent/${_f}"
  done
  install -o root -g root -m 755 "${SCRIPT_DIR}/mail-capture" "${KP_LIB_DIR}/mail-capture"
  for _f in kouziaphp-firewall cloudflared kouziaphp-agent kouziaphp-site; do
    install -o root -g root -m 755 "${SCRIPT_DIR}/openrc/${_f}" "${KP_LIB_DIR}/openrc/${_f}"
  done
fi
for _f in kouziaphp-firewall cloudflared kouziaphp-agent kouziaphp-site; do
  install -o root -g root -m 755 "${KP_LIB_DIR}/openrc/${_f}" "/etc/init.d/${_f}"
done
mkdir -p "${KP_ETC_DIR}/sites" "${KP_ETC_DIR}/fpm"
chmod 700 "${KP_ETC_DIR}/sites"
chmod 755 "${KP_ETC_DIR}/fpm"
# Agent déjà réglé (réinstallation) : relancé sur la nouvelle copie. Sinon : kouziaphpctl agent (README, 11.8).
if [ -s "${KP_ETC_DIR}/agent.secret" ]; then
  rc_service kouziaphp-agent restart >/dev/null 2>&1 || warn "L'agent n'a pas redémarré : kouziaphpctl status"
fi
# Absent de l'Alpine minimale (recette du 25/10/2026).
mkdir -p /usr/local/sbin
ln -sf "${KP_LIB_DIR}/kouziaphpctl" /usr/local/sbin/kouziaphpctl
ok "kouziaphpctl installé (scripts copiés dans ${KP_LIB_DIR}, à root, lecture seule pour les autres)."

title "Pare-feu du CT"
sh "${KP_LIB_DIR}/firewall.sh" || warn "Pare-feu du CT non posé : la règle Proxmox (README, section 9) reste la protection principale."

title "Groupes de contrôle (cgroups)"
# OpenRC range chaque service dans son groupe (cgroup v2) : condition des limites CPU et mémoire par site.
if grep -q ' /sys/fs/cgroup cgroup2 ' /proc/mounts; then
  if grep -Eq '^rc_cgroup_mode=' /etc/rc.conf; then
    sed -i 's/^rc_cgroup_mode=.*/rc_cgroup_mode="unified"/' /etc/rc.conf
  else
    printf '%s\n' 'rc_cgroup_mode="unified"' >> /etc/rc.conf
  fi
fi
sh "${KP_LIB_DIR}/cgroups.sh" || warn "Limites par site indisponibles pour l'instant : voir le détail ci-dessus (docs/cadrage.md, section 11.2)."

title "Tunnel Cloudflare"
if [ -s "$KP_TUNNEL_TOKEN_FILE" ]; then
  ok "Jeton du tunnel déjà en place (le changer : kouziaphpctl tunnel)."
else
  echo "  Pas encore de jeton : lancer « kouziaphpctl tunnel » et coller le jeton du tunnel « kouziaphp »."
fi

sh "${KP_LIB_DIR}/status.sh"
