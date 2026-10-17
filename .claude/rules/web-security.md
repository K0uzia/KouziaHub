# Sécurité (OWASP Top 10)

- HTTPS partout, redirection 301. HSTS long seulement sur l'hôte au certificat public valide.
- En-têtes sur chaque réponse : CSP (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action` limité, `frame-ancestors` explicite), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restrictive, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options`.
- Rien de dev en ligne : `.git`, `.env`, `node_modules`, sources, `.md`, logs, sauvegardes renvoient 403. Pas de listing de répertoire, signature serveur coupée.
- Méthodes : GET, HEAD, OPTIONS sur le statique ; POST seulement vers les points d'entrée de formulaire réels.
- CORS : origine exacte, jamais `*` sur une ressource avec données.
- Formulaires : honeypot, délai minimal de soumission, limite de débit, CSRF si session, validation serveur, messages qui ne révèlent pas l'existence d'un compte.
- Secrets : jamais versionnés. `.env.example` sans valeurs. Fuite avérée : rotation immédiate, nettoyer l'historique ensuite.
- Dépendances : minimum vital, `npm audit` avant mise en production, versions verrouillées (`package-lock.json`).
- Procédures : skills `web-security-headers`, `web-forms-security`, `web-repo-hygiene`.
