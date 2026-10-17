---
name: web-legal-fr
description: Rédige la structure des mentions légales, de la politique de confidentialité RGPD, du consentement de formulaire, de la gestion des traceurs et de la déclaration d'accessibilité d'un site français. À utiliser pour créer les pages légales, brancher une mesure d'audience ou un formulaire.
---

# Pages légales (France)

Source : contrats `portal-legal.json` et `portal-accessibility.json` de CapsuleOS, complétés par les obligations françaises courantes. Ne jamais inventer une donnée légale : champ inconnu = marqueur à remplir signalé à l'utilisateur.

## Mentions légales (LCEN art. 6)

- Éditeur : nom ou raison sociale, forme juridique, capital (société), adresse, SIREN/SIRET, RCS ou RM, n° TVA intracommunautaire si assujetti, e-mail et téléphone.
- Directeur de la publication.
- Hébergeur : nom, adresse, téléphone.
- Propriété intellectuelle et crédits (photos, polices, icônes avec leur licence).

## Politique de confidentialité (RGPD)

Une section par traitement (formulaire de contact, compte, newsletter, mesure d'audience) :

| Champ | Exemple |
|-------|---------|
| Données collectées | nom, e-mail, message |
| Finalité | répondre à la demande |
| Base légale | mesures précontractuelles, intérêt légitime ou consentement |
| Destinataires | l'éditeur, le prestataire d'envoi de formulaire, l'hébergeur |
| Durée | 3 ans après le dernier contact (prospect) |
| Transfert hors UE | oui ou non, et garantie |

Puis : droits (accès, rectification, effacement, opposition, limitation, portabilité), contact pour les exercer, réclamation auprès de la CNIL.

## Formulaire

- Lien vers la politique à côté du bouton d'envoi.
- Case de consentement non pré-cochée et obligatoire seulement si la base légale est le consentement (newsletter, par exemple). Pour une simple demande de contact, une mention d'information suffit.

## Traceurs

- Mesure d'audience exemptée (Matomo sans cookie, IP anonymisée, pas de croisement, données non partagées) : pas de bannière, mention dans la politique, opposition possible.
- Tout autre traceur (publicité, réseaux sociaux, vidéo embarquée) : consentement préalable, bouton « Refuser » aussi visible que « Accepter », aucun dépôt avant choix.
- Vidéo embarquée : version sans cookie (`youtube-nocookie.com`) ou façade qui ne charge le lecteur qu'au clic.

## Déclaration d'accessibilité

Voir skill `web-a11y-audit` §3. Lien « Accessibilité : non/partiellement/totalement conforme » en pied de page.

## Pied de page

Liens vers : Mentions légales, Confidentialité, Accessibilité, et CGV si vente. Ces pages : `noindex` facultatif, mais présentes dans la navigation.
