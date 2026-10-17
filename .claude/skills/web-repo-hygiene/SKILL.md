---
name: web-repo-hygiene
description: Vérifie qu'un dépôt de site ne versionne aucun secret, fichier sensible ou dépendance installée, et que les dépendances sont auditées. À utiliser avant un premier push, une mise en production, l'ajout d'un .env ou après une fuite suspectée.
---

# Hygiène du dépôt

Source : gate `validate-git-security.mjs` et `SECURITY.md` de CapsuleOS.

## Contrôle automatique

```bash
node .claude/skills/web-audit/scripts/check-repo.mjs
```

Échoue si un fichier suivi par Git correspond à : `.env`, `.env.*` (sauf `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `node_modules/`, `*.sqlite`, ou si `.gitignore` ne couvre pas `node_modules/` et `.env`. Avertit sur une IP privée ou un motif de clé (`sk_live_`, `AKIA`, `ghp_`, `-----BEGIN`) dans un fichier suivi.

## Règles

- `.env.example` versionné avec les noms de variables, valeurs vides ou factices.
- Exemple d'IP dans la doc : plage de documentation `203.0.113.x`, jamais une IP réelle du réseau.
- `npm ci` (pas `npm install`) en intégration et en production, `package-lock.json` versionné.
- `npm audit --omit=dev` avant chaque mise en production ; vulnérabilité `high` ou `critical` corrigée ou justifiée.
- Le site publié ne contient ni `node_modules`, ni sources, ni sourcemaps (sauf choix assumé).

## En cas de fuite

1. Révoquer et remplacer le secret immédiatement : le retirer du dépôt ne suffit pas, il reste dans l'historique.
2. Ensuite seulement, nettoyer l'historique (`git filter-repo`) et prévenir les détenteurs de clones.
