#!/bin/sh
# Contrôle des limites par site (docs/cadrage.md, section 11.2) : chaque site aura son service PHP-FPM, rangé
# par OpenRC dans son groupe de contrôle (cgroup v2) avec des limites CPU, mémoire et processus. Ce script le
# vérifie dans CE CT, sans rien supposer :
#   1. cgroup v2 monté, contrôleurs memory, cpu et pids disponibles ;
#   2. un service OpenRC de test reçoit bien ses limites (memory.max, cpu.max, pids.max) ;
#   3. essai réel : un processus placé dans ce groupe qui dépasse la mémoire est tué, un trop-plein de
#      processus est refusé.
# Le service de test est retiré à la fin, quoi qu'il arrive. Résultat gardé pour « kouziaphpctl status ».
#
# Usage, en root : sh cgroups.sh   (code 0 : limites effectives ; 1 : non)
#        sh cgroups.sh activer   (activation seule, sans essai : service kouziaphp-cgroups au démarrage)
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

require_root

_root="/sys/fs/cgroup"
_wanted="memory cpu pids"

# Contrôleurs actifs pour les groupes enfants (cgroup.subtree_control de la racine du CT) ; liste les manquants.
controllers_missing() {
  _active=" $(cat "${_root}/cgroup.subtree_control" 2>/dev/null || true) "
  for _c in $_wanted; do
    case "$_active" in
      *" ${_c} "*) ;;
      *) printf "%s " "$_c" ;;
    esac
  done
}

# Dans un CT LXC, la racine des cgroups du CT est un groupe intérieur de l'hôte : le noyau refuse d'y activer un
# contrôleur (« Device or resource busy ») tant que des processus y vivent. Ils vont dans « kouziaphp.init »,
# puis chaque contrôleur est activé. Rejouable ; rien ne survit à un redémarrage du CT.
activate_controllers() {
  [ -n "$(controllers_missing)" ] || return 0
  grep -q " ${_root} cgroup2 " /proc/mounts || return 1
  mkdir -p "${_root}/kouziaphp.init"
  # Deux passes : un processus né pendant la première (fils d'un processus pas encore déplacé) est repris.
  for _pass in 1 2; do
    while read -r _p; do
      echo "$_p" > "${_root}/kouziaphp.init/cgroup.procs" 2>/dev/null || true
    done < "${_root}/cgroup.procs"
  done
  for _c in $(controllers_missing); do
    echo "+${_c}" > "${_root}/cgroup.subtree_control" 2>/dev/null || true
  done
  [ -z "$(controllers_missing)" ]
}

if [ "${1:-}" = "activer" ]; then
  activate_controllers
  exit $?
fi

_svc="kouziaphp-cgtest"
_init="/etc/init.d/${_svc}"
_conf="/etc/conf.d/${_svc}"
_result="${KP_STATE_DIR}/cgroups"
_fails=0
_report=""

note() {
  _report="${_report}$1
"
}

pass() {
  ok "$1"
  note "OK $1"
}

fail() {
  printf '%s\n' "${C_RED}ÉCHEC${C_RESET} $1"
  note "ÉCHEC $1"
  _fails=$((_fails + 1))
}

# Appelée par le piège EXIT.
# shellcheck disable=SC2317
cleanup() {
  if [ -f "$_init" ]; then
    rc-service "$_svc" stop >/dev/null 2>&1 || true
    rm -f "$_init"
  fi
  rm -f "$_conf"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

finish() {
  mkdir -p "$KP_STATE_DIR"
  {
    echo "date $(date '+%Y-%m-%d %H:%M')"
    if [ "$_fails" -eq 0 ]; then echo "resultat ok"; else echo "resultat echec"; fi
    printf '%s' "$_report"
  } > "$_result"
  if [ "$_fails" -eq 0 ]; then
    ok "Limites par site effectives : un service PHP-FPM par site pourra être borné (CPU, mémoire, processus)."
    exit 0
  fi
  warn "Limites par site non effectives dans ce CT (${_fails} échec(s)). Les limites de PHP (mémoire par requête, 4 processus, 30 s) et les limites du CT dans Proxmox restent en place."
  exit 1
}

title "Groupes de contrôle (limites par site)"

# 1. cgroup v2 et contrôleurs.
if grep -q ' /sys/fs/cgroup cgroup2 ' /proc/mounts; then
  pass "cgroup v2 monté sur /sys/fs/cgroup."
else
  fail "cgroup v2 absent (cgroup v1 ou hybride) : Proxmox 7 ou plus le fournit par défaut aux CT."
  finish
fi
_mode="$(sed -n 's/^rc_cgroup_mode="\{0,1\}\([a-z]*\)"\{0,1\}$/\1/p' /etc/rc.conf | tail -n 1)"
if [ "$_mode" = "unified" ]; then
  pass "OpenRC en mode unifié (rc_cgroup_mode=\"unified\")."
else
  fail "OpenRC n'est pas en mode unifié (rc_cgroup_mode=\"${_mode:-défaut}\" dans /etc/rc.conf) : relancer kouziaphpctl install."
fi
_ctrl="$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || true)"
for _c in memory cpu pids; do
  case " ${_ctrl} " in
    *" ${_c} "*) pass "Contrôleur ${_c} disponible." ;;
    *) fail "Contrôleur ${_c} absent de /sys/fs/cgroup/cgroup.controllers (« ${_ctrl:-vide} ») : non délégué au CT par Proxmox." ;;
  esac
done
if activate_controllers; then
  pass "Contrôleurs ${_wanted} actifs pour les groupes des services (cgroup.subtree_control)."
else
  _left="$(cat "${_root}/cgroup.procs" 2>/dev/null | wc -l | tr -d " ")"
  fail "Contrôleurs non activés pour les groupes des services (manquants : $(controllers_missing)) ; processus restés à la racine du CT : ${_left}. Détail : cat ${_root}/cgroup.subtree_control"
fi

# 2. Service de test avec des limites basses.
cat > "$_init" <<'EOF'
#!/sbin/openrc-run
description="Essai des limites par service (kouziaphpctl cgroups), retiré après l'essai"
command="/bin/sleep"
command_args="600"
command_background="yes"
pidfile="/run/kouziaphp-cgtest.pid"
EOF
chmod 755 "$_init"
cat > "$_conf" <<'EOF'
rc_cgroup_settings="
memory.max 64M
cpu.max 50000 100000
pids.max 16
"
EOF
if ! rc-service "$_svc" start >/dev/null 2>&1; then
  fail "Le service de test ne démarre pas (rc-service ${_svc} start)."
  finish
fi
_pid="$(cat /run/kouziaphp-cgtest.pid 2>/dev/null || true)"
_cg="$(sed -n 's/^0:://p' "/proc/${_pid:-0}/cgroup" 2>/dev/null || true)"
if [ -z "$_pid" ] || [ -z "$_cg" ] || [ "$_cg" = "/" ]; then
  fail "OpenRC n'a pas rangé le service dans un groupe à lui (groupe : « ${_cg:-inconnu} »)."
  finish
fi
_dir="/sys/fs/cgroup${_cg}"
pass "Service de test rangé dans ${_cg}."

expect_value() {
  _got="$(cat "${_dir}/$1" 2>/dev/null || echo 'illisible')"
  if [ "$_got" = "$2" ]; then
    pass "$1 = $2"
  else
    fail "$1 attendu « $2 », lu « ${_got} » (limite non posée par OpenRC)."
  fi
}
expect_value memory.max 67108864
expect_value cpu.max "50000 100000"
expect_value pids.max 16

# 3. Essais réels dans le groupe du service : la limite doit agir, pas seulement être écrite.
_php="$(command -v "php${KP_PHP_DEFAULT}" || command -v php || true)"
if [ -n "$_php" ] && [ -w "${_dir}/cgroup.procs" ]; then
  _before="$(awk '$1 == "oom_kill" { print $2 }' "${_dir}/memory.events" 2>/dev/null || echo 0)"
  # Le sous-shell entre dans le groupe puis devient PHP : 200 Mo demandés pour 64 Mo permis.
  if sh -c "echo \$\$ > '${_dir}/cgroup.procs' && exec '${_php}' -d memory_limit=-1 -r '\$a = str_repeat(\"x\", 200 * 1024 * 1024); echo strlen(\$a);'" >/dev/null 2>&1; then
    fail "Un processus a obtenu 200 Mo malgré memory.max à 64 Mo : la limite de mémoire n'agit pas."
  else
    _after="$(awk '$1 == "oom_kill" { print $2 }' "${_dir}/memory.events" 2>/dev/null || echo 0)"
    if [ "${_after:-0}" -gt "${_before:-0}" ]; then
      pass "Mémoire : le processus qui dépassait 64 Mo a été arrêté (oom_kill)."
    else
      fail "Le processus a échoué sans arrêt par la limite de mémoire (memory.events inchangé) : cause à lire."
    fi
  fi
  _pbefore="$(awk '$1 == "max" { print $2 }' "${_dir}/pids.events" 2>/dev/null || echo 0)"
  sh -c "echo \$\$ > '${_dir}/cgroup.procs'; i=0; while [ \$i -lt 30 ]; do sleep 2 & i=\$((i + 1)); done 2>/dev/null; wait" >/dev/null 2>&1 || true
  _pafter="$(awk '$1 == "max" { print $2 }' "${_dir}/pids.events" 2>/dev/null || echo 0)"
  if [ "${_pafter:-0}" -gt "${_pbefore:-0}" ]; then
    pass "Processus : au-delà de 16, les nouveaux processus ont été refusés (pids.events)."
  else
    fail "30 processus lancés sans refus malgré pids.max à 16 : la limite de processus n'agit pas."
  fi
else
  fail "Essai réel impossible (PHP absent ou ${_dir}/cgroup.procs non modifiable)."
fi

finish
