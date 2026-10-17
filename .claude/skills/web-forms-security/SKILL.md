---
name: web-forms-security
description: Sécurise un formulaire (contact, devis, inscription, connexion) contre le spam, les robots et les abus, côté client et serveur. À utiliser pour créer ou revoir un formulaire, un service tiers type Web3Forms/Formspree, ou une authentification.
---

# Formulaires et authentification

Source : contrat `portal-security.json` de CapsuleOS (portail PHP en production), généralisé.

## Tout formulaire

1. Collecter le strict nécessaire. Lien vers la politique de confidentialité à côté du bouton.
2. Validation serveur obligatoire, la validation HTML (`required`, `type="email"`, `maxlength`) n'est qu'un confort.
3. Honeypot : champ texte hors écran au nom plausible (`company_url`), `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"` sur son conteneur. Rempli : on répond succès sans traiter.
4. Délai : horodatage au rendu, refus si soumis en moins de 2 s ou après 2 h.
5. Limite de débit par IP et par identifiant (ex. 5 essais par 15 min). Réponse 429 générique.
6. Domaines e-mail jetables refusés si le formulaire crée un compte.
7. Après envoi : redirection vers une page de confirmation (motif PRG), pas de renvoi au rafraîchissement.
8. Accessibilité : `label` visible, erreurs en texte reliées par `aria-describedby`, état d'envoi annoncé (`aria-live="polite"`).

## Service tiers (site statique)

- Clé publique seulement dans le HTML ; aucune clé secrète côté client.
- Ouvrir la CSP uniquement pour son hôte : `form-action 'self' https://hote-du-service`.
- Activer le honeypot et le filtre anti-spam proposés par le service. Mentionner le service comme destinataire dans la politique de confidentialité.
- Repli sans JavaScript : le formulaire doit encore être envoyable.

## Avec session ou compte

| Point | Valeur de référence |
|-------|---------------------|
| Mot de passe | Argon2id (`password_hash(..., PASSWORD_ARGON2ID)`), 10 caractères minimum |
| CSRF | jeton par session dans un champ caché, vérifié à chaque POST |
| Cookie de session | `HttpOnly`, `Secure` en production, `SameSite=Lax` |
| Durée de session | inactivité 24 h, absolue 7 jours, régénérer l'identifiant à la connexion |
| Réinitialisation | jeton à usage unique, valable 60 min |
| Code e-mail | 6 chiffres, 30 min |
| Requêtes SQL | requêtes préparées uniquement |
| Pages auth | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |

## Messages anti-énumération

- Connexion : « Connexion impossible. Vérifiez vos identifiants et réessayez. » (jamais « mot de passe incorrect » seul).
- Mot de passe oublié : « Si un compte existe pour cette adresse, un e-mail a été envoyé. »
- Ajouter un délai constant (~250 ms) sur les réponses d'authentification pour masquer les écarts de temps.

## Espace d'administration

- URL non liée depuis le site public, `noindex`, `X-Robots-Tag: noindex` et `Disallow` dans `robots.txt` (sans compter sur ce dernier pour la sécurité).
- Session admin distincte de la session utilisateur, durée plus courte, 2FA si possible.
- Rôles explicites (admin, éditeur, lecteur), vérifiés côté serveur sur chaque route d'API.
- Journal d'audit des actions sensibles (qui, quoi, quand, avant/après).
- Toute modification de contenu public passe par la même source de données que le site, puis régénère les pages concernées.
