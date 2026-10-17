#!/usr/bin/env bash
# Vérifie en production les en-têtes de sécurité, la redirection HTTPS et le blocage des fichiers sensibles.
# Usage : bash check-headers.sh https://example.com
set -u
URL="${1:?Usage : check-headers.sh https://example.com}"
URL="${URL%/}"
HOST="${URL#https://}"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }
avert() { printf '  ! %s\n' "$1"; }

H="$(curl -sSI --max-time 15 "$URL/")" || { echo "Site injoignable : $URL"; exit 2; }
has() { grep -qi "^$1:" <<<"$H"; }
val() { grep -i "^$1:" <<<"$H" | head -1 | cut -d: -f2- | tr -d '\r'; }

echo "En-têtes de $URL/"
for h in Strict-Transport-Security Content-Security-Policy X-Content-Type-Options Referrer-Policy Permissions-Policy Cross-Origin-Opener-Policy; do
  if has "$h"; then ok "$h"; else ko "$h absent"; fi
done
if has X-Frame-Options || val Content-Security-Policy | grep -q frame-ancestors; then ok "anti-clickjacking"; else ko "ni X-Frame-Options ni frame-ancestors"; fi
csp="$(val Content-Security-Policy)"
for d in "object-src 'none'" "base-uri" "form-action"; do
  grep -q "$d" <<<"$csp" || avert "CSP sans $d"
done
grep -q "script-src[^;]*'unsafe-inline'" <<<"$csp" && avert "CSP script-src autorise 'unsafe-inline'"
grep -qiE '^server:.*[0-9]' <<<"$H" && avert "version serveur exposée :$(val Server)"
grep -qi '^x-powered-by:' <<<"$H" && avert "X-Powered-By exposé :$(val X-Powered-By)"
grep -qiE '^content-encoding: *(br|gzip)' <<<"$(curl -sS -o /dev/null -D - -H 'Accept-Encoding: br, gzip' --max-time 15 "$URL/")" && ok "compression" || avert "HTML servi sans compression br/gzip"

echo "Redirections"
code="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$HOST/")"
[[ "$code" =~ ^30[18]\ https:// ]] && ok "http vers https ($code)" || ko "http://$HOST/ ne redirige pas en 301 vers https ($code)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/page-qui-n-existe-pas-$$")"
[ "$code" = 404 ] && ok "page inconnue en 404" || ko "page inconnue renvoie $code (attendu 404)"

echo "Fichiers sensibles"
for p in .git/config .env .env.example package.json README.md node_modules/ .htaccess composer.json; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/$p")"
  case "$code" in 403|404|410) ok "/$p : $code" ;; *) ko "/$p accessible ($code)" ;; esac
done
exit $fail
