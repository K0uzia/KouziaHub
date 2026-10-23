# Licences logicielles : émission depuis Kouzia Hub

Décision du 22 octobre 2026. Le hub émet et conserve les clés de licence. Tracebay Autonome les vérifie hors ligne et n'appelle jamais le hub.

Texte identique dans Tracebay Autonome, `docs/LICENCE-HUB.md`. Les deux fichiers se mettent à jour ensemble. Le comportement de l'application (fenêtre d'activation, lecture seule, horloge) reste décrit dans Tracebay Autonome, `docs/LICENCE.md`.

Ce document remplace l'idée d'un service Fastify et PostgreSQL séparé. Rien de ce service n'est écrit. Le hub a déjà le login, l'annuaire ERP, le journal et le chiffrement au repos.

## 1. Principe du branchement

```
Alexandre, sur hub.kouzia.com (mot de passe, puis code TOTP)
        │
        ▼
Kouzia Hub (CT Alpine, Proxmox)
  page Logiciels
  SQLite : logiciel, registre des clés (clé émise chiffrée)
  clé privée Ed25519, fichier hors dépôt, lue au démarrage
        │
        │  chaîne TB1.… copiée et transmise au client (pas de réseau)
        ▼
Tracebay (version portable, poste du client)
  clé publique Ed25519 embarquée
  vérifie la signature, le format et les dates
  n'ouvre aucune connexion vers le hub
```

Le hub ne sait pas si une clé a été collée, sur quel poste, ni si elle est encore utilisée. Il n'y a pas de rappel, pas de liste de révocation, pas de lien au poste. L'expiration tient lieu de fin de droit : l'application passe en lecture seule.

Une clé est liée au nom de l'entreprise, figé dans la signature. Ce nom est imposé sur les PDF. Une clé prêtée produit des documents au nom d'une autre entreprise.

## 2. Ce que le hub reprend des sites, et ce qu'il ne reprend pas

Même geste que le catalogue des sites. Autre objet.

| Sites, déjà en place | Logiciels |
|---|---|
| Entrée « Sites » dans la barre | Entrée « Logiciels », route `/logiciels` |
| Carte du catalogue | Une carte par logiciel (Tracebay seul au départ) |
| Fiche `/sites/:id` | Fiche `/logiciels/:slug` : liste des clés |
| Nouveau site : client ERP ou nom libre | Nouvelle clé : client ERP (le nom est prérempli) ou nom libre |
| En ligne, hors ligne, erreur | Active, bientôt expirée, expirée |
| Journal `site.create` | Journal `licence.emettre` |

Le hub ne crée pas de projet Cloudflare, n'envoie pas de fichiers, ne publie pas, ne surveille pas l'installation. Une clé n'a pas d'opération à étapes : la signature est immédiate.

Il n'y a pas de bouton pour révoquer, supprimer ou modifier une clé déjà signée. Changer l'entreprise ou la date, c'est émettre une nouvelle clé. Les notes et le rattachement au client ERP se modifient après coup : ils ne sont pas dans la signature.

La barre du bas (`AppLayout`) passe de 3 à 4 colonnes.

## 3. Contrat de la clé (normatif)

Les deux dépôts produisent et lisent les mêmes octets. Toute liberté ici casse les clés déjà émises.

### 3.1 Texte

```
TB1.<données>.<signature>
```

Trois segments séparés par un point. `TB1` est fixe. `<données>` et `<signature>` sont en base64url sans padding (`Buffer.toString("base64url")` de Node : alphabet `A-Za-z0-9-_`).

### 3.2 Données signées

`<données>` est le base64url du JSON canonique, UTF-8. Le JSON est le résultat de `JSON.stringify` sur un objet dont les clés sont exactement, dans cet ordre :

| Clé | Type | Règle |
|---|---|---|
| `v` | nombre | `1`. Toute autre valeur : format inconnu. |
| `id` | chaîne | Identifiant de la ligne du registre. 1 à 32 caractères, `[A-Za-z0-9_-]`. |
| `entreprise` | chaîne | Nom imposé sur les PDF. Déjà normalisé (voir 3.4). 1 à 120 caractères. |
| `emise` | chaîne | Jour d'émission, `AAAA-MM-JJ`, calendrier `Europe/Paris`. |
| `expire` | chaîne | Dernier jour inclus, `AAAA-MM-JJ`, calendrier `Europe/Paris`. |

Aucun espace, aucune autre clé. `JSON.stringify` ne modifie pas les caractères non ASCII : « Société » reste « Société », il n'est pas écrit `\u00e9`. Les guillemets et barres obliques inverses du nom sont échappés par `JSON.stringify`, et cet échappement fait partie des octets signés.

Exemple (les octets comptent, y compris les accents) :

```json
{"v":1,"id":"clxyz","entreprise":"Atelier Nord","emise":"2026-10-22","expire":"2027-10-22"}
```

### 3.3 Signature

Ed25519 des octets UTF-8 du JSON canonique, pas du segment base64url.

```js
const data = Buffer.from(jsonCanonique, "utf8");
const signature = crypto.sign(null, data, privateKey);
crypto.verify(null, data, publicKey, signature);
```

`privateKey` est un `KeyObject` PKCS#8. `publicKey` est un `KeyObject` SPKI. Aucune bibliothèque ajoutée : `node:crypto` des deux côtés.

La vérification décode, contrôle `v`, les types, les dates et la signature. Une signature fausse, un JSON modifié, un segment en trop ou un base64 illisible donnent la même issue : clé invalide. Le motif précis (« signature », « date », « format ») est renvoyé à l'interface pour le message, jamais à un tiers.

### 3.4 Nom d'entreprise

Avant la signature, le hub :

1. retire les espaces de début et de fin ;
2. normalise en NFC ;
3. refuse le vide, plus de 120 caractères, et un caractère de contrôle (catégorie Unicode `Cc`).

La chaîne retenue est celle qui est signée et celle qui est stockée. Le nom affiché par l'ERP ne sert qu'à préremplir le champ. Si Alexandre le corrige, c'est la correction qui est signée.

### 3.5 Dates

Fuseau unique : `Europe/Paris`. Pas d'heure dans la clé.

- `emise` est le jour du serveur au moment de la signature.
- `expire` est soit une date saisie, soit `emise` plus N mois.
- Ajout de mois : même quantième, sinon le dernier jour du mois d'arrivée (31 janvier plus un mois = 28 ou 29 février).
- La clé est valable le jour `expire` inclus. Le lendemain, en heure de Paris, elle est expirée.
- `expire` est au plus tôt le jour `emise`, au plus tard dix ans après.
- Durées proposées : 1, 3, 6, 12, 24 et 36 mois, plus une date libre dans ces bornes. Défaut : 12 mois.

L'application compare des dates de calendrier, pas des instants. Une date système antérieure à la dernière date déjà vue est traitée comme expirée (horloge reculée, côté application seulement, mémorisée dans `licence.json`).

### 3.6 Ce qui n'est pas dans la clé

Le contact, les notes, l'identifiant ERP et le slug du logiciel. Les modifier ne demande pas une nouvelle signature.

## 4. Clés cryptographiques

Une paire Ed25519 pour Tracebay, générée une fois, sur le CT du hub, par `hubctl tracebay-keygen` : la paire n'est créée que si le fichier est absent (jamais remplacée), avec les droits ci-dessous, `TRACEBAY_LICENSE_KEY_FILE` est posé dans le `.env` et seule la publique est affichée (`hubctl tracebay-keygen --public` la réaffiche). Équivalent à la main :

```bash
node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync("tracebay-ed25519.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
'
```

La commande écrit la privée dans le fichier indiqué et n'imprime que la publique. À lancer sur le conteneur du hub, pas sur un poste de travail ensuite jeté.

| Élément | Où | Règle |
|---|---|---|
| Clé privée PKCS#8 PEM | `/etc/kouziahub/tracebay-ed25519.pem`, propriétaire `root:kouziahub`, mode `640` | Hors dépôt, hors `.env`, hors image, hors sauvegarde en clair. Sauvegarde chiffrée ailleurs obligatoire. Sa perte empêche de signer pour les versions déjà installées. |
| Chemin | Variable `TRACEBAY_LICENSE_KEY_FILE` | Absente ou fichier illisible : la liste des clés reste lisible, l'émission répond 503 avec un message explicite. |
| Clé publique SPKI PEM | Dépôt Tracebay Autonome, constante du processus principal, livrée avec l'application | Publique. Elle vérifie, elle ne signe pas. |
| Clé de développement | Fichier gitignoré, produit par l'installation locale du hub | Jamais celle de production. Les tests génèrent une paire en mémoire et ne lisent pas ce fichier. |

Une rotation de la publique impose une nouvelle version de Tracebay et de nouvelles clés pour tous les clients. Le format le dira plus tard par `v` si une seconde paire doit coexister. Pour l'instant, une seule paire, `v = 1`.

Le hub signe dans son propre processus, derrière le login déjà en place. Conséquence assumée : une compromission du hub permettrait de fabriquer des licences Tracebay valides jusqu'à une rotation. Un signeur séparé, joignable seulement sur le réseau local du Proxmox (comme l'ERP), reste possible plus tard. Il n'est pas nécessaire pour ce branchement.

## 5. Données (Prisma, même SQLite que les sites)

Migration dans `prisma/migrations/`, sur le modèle des migrations déjà datées. Pas de PostgreSQL, pas de base à part.

```prisma
model Software {
  id          String    @id @default(cuid())
  /// "tracebay". Unique, stable, utilisé dans l'URL.
  slug        String    @unique
  name        String
  /// "TB1". Décide du signeur.
  format      String
  createdAt   DateTime  @default(now())
  licenses    License[]
}

model License {
  id           String    @id @default(cuid())
  softwareId   String
  software     Software  @relation(fields: [softwareId], references: [id])
  /// Nom signé, NFC, 1 à 120 caractères. Immuable.
  entreprise   String
  /// Identifiant ERP, même règle que Site.erpClientId. Null si le nom a été saisi librement.
  erpClientId  String?
  /// Chiffré avec encrypt() (AES-256-GCM, ENCRYPTION_KEY). Null si vide.
  contactEncrypted String?
  /// Chaîne TB1 complète, chiffrée de la même façon. Jamais en clair dans la base.
  keyEncrypted String
  /// AAAA-MM-JJ, heure de Paris. Immuables.
  emise        String
  expire       String
  notes        String?
  createdAt    DateTime  @default(now())

  @@index([softwareId, expire])
  @@index([erpClientId])
}
```

Au démarrage, si aucune ligne `slug = tracebay` n'existe, le hub la crée (`name` « Tracebay », `format` « TB1 »). Pas d'écran pour ajouter un logiciel : un second logiciel a besoin de son propre format de signature.

`AuditEvent` ne change pas. L'émission écrit `action: "licence.emettre"`, `result: "ok"`, `siteId` et `siteSlug` à null, `detail` du type `tracebay : Atelier Nord, expire le 2027-10-22`. Jamais la clé, jamais le contact, jamais un nom de fichier de clé privée. Libellé à ajouter dans `ACTION_LABEL` : « Clé de licence émise ».

Le contact est une donnée personnelle (souvent une adresse). Il est chiffré comme les secrets TOTP. L'entreprise reste en clair : elle est déjà dans les PDF du client, et la recherche du catalogue en a besoin.

## 6. API

Mêmes règles que les routes de sites : `requireAuth` sur le plugin, corps validé par zod, erreur `{ error, code? }`, contrôle d'origine sur les mutations. Le contrat vit dans `apps/api/src/contract.ts`.

Dates ISO pour `createdAt`. `emise` et `expire` restent `AAAA-MM-JJ`.

### 6.1 Catalogue

`GET /api/logiciels`

```ts
type LicenseStatus = "active" | "expiring" | "expired";

type SoftwareSummary = {
  slug: string;
  name: string;
  format: string;
  counts: { active: number; expiring: number; expired: number };
};

type SoftwareCatalog = { software: SoftwareSummary[] };
```

Le statut n'est pas stocké. Il se calcule au jour de Paris : `expired` si ce jour est après `expire`, `expiring` s'il reste 30 jours ou moins (jour `expire` inclus), `active` sinon.

### 6.2 Fiche

`GET /api/logiciels/:slug`

404 si le slug est inconnu. La réponse contient le logiciel, les compteurs, et la liste des clés sans la chaîne `TB1` :

```ts
type LicenseSummary = {
  id: string;
  entreprise: string;
  erpClientId: string | null;
  /** Nom lu dans l'ERP, null si non rattaché ou ERP indisponible. */
  clientName: string | null;
  emise: string;
  expire: string;
  status: LicenseStatus;
  notes: string | null;
  createdAt: string;
};
```

Tri : expiration la plus proche d'abord, puis entreprise (`localeCompare` en `fr`). La recherche et les filtres (toutes, actives, bientôt expirées, expirées) se font dans la page, comme le catalogue des sites, sur cette liste. La recherche porte sur l'entreprise et le nom du client, sans accent et sans casse (`foldText`, déjà utilisé pour l'ERP).

### 6.3 Émettre

`POST /api/logiciels/:slug/cles`, statut 201.

```ts
type CreateLicenseInput = {
  entreprise: string;
  erpClientId?: string | null;
  contact?: string | null;
  notes?: string | null;
  /** Un des deux, pas les deux. */
  months?: number;
  expire?: string;
};
```

- `months` : entier de 1 à 36.
- `expire` : `AAAA-MM-JJ` dans les bornes du § 3.5.
- `contact` : vide ignoré, sinon 200 caractères au plus, puis chiffré.
- `notes` : 2 000 caractères au plus.
- `erpClientId` : même expression que `ERP_CLIENT_ID`. Le hub vérifie que le client existe (`services.erp.get`), comme à la création d'un site. ERP injoignable : 503 `erp_unavailable`, aucune clé écrite.
- Logiciel de format autre que `TB1` : 400.
- Fichier de clé privée absent : 503, message « Émission impossible : la clé de signature est absente sur le serveur. »

Ordre : valider, normaliser l'entreprise, calculer les dates, créer l'identifiant, signer, chiffrer, insérer, journaliser. Si l'insertion échoue, la clé n'est pas réémise en silence avec un autre identifiant : l'erreur remonte, Alexandre relance.

La réponse 201 est un `LicenseDetail` : le résumé plus `cle` (la chaîne `TB1.…` en clair, une seule fois dans cette réponse, et de nouveau au GET suivant).

### 6.4 Relire une clé

`GET /api/logiciels/:slug/cles/:id`

Même détail, avec `cle` déchiffrée et `contact` déchiffré (null si vide). 404 si la clé n'appartient pas à ce logiciel.

### 6.5 Corriger le rattachement

`PATCH /api/logiciels/:slug/cles/:id`

```ts
type UpdateLicenseInput = {
  notes?: string | null;
  contact?: string | null;
  erpClientId?: string | null;
};
```

Refus de tout autre champ (`strict`), en particulier `entreprise`, `emise`, `expire`. Journal `licence.modifier`, détail limité au slug et à l'identifiant, sans le contact.

Pas de `DELETE`.

## 7. Écrans

Même composants que les sites : `PageHeader`, `Card`, `EmptyState`, `StatStrip`, `FilterSegment`, `Banner`, `Button`, dialogue de création. Textes en français. Pas de tiret cadratin ni demi-cadratin.

### 7.1 Catalogue `/logiciels`

Titre « Logiciels ». Une carte Tracebay : nom, trois compteurs (actives, bientôt expirées, expirées). Clic vers `/logiciels/tracebay`.

État vide impossible dès que l'amorçage a créé Tracebay. Si la liste échoue : bandeau d'erreur et « Réessayer », comme le catalogue des sites.

### 7.2 Fiche `/logiciels/tracebay`

Titre « Tracebay ». Bandeau permanent : « Le nom de l'entreprise est écrit dans la clé et imposé sur les documents. Une autre entreprise demande une nouvelle clé. »

Bandeau si l'émission est indisponible (réponse 503 au chargement d'un drapeau, ou erreur à la création) : « La clé de signature n'est pas en place sur le serveur. Les clés déjà émises restent consultables. »

`StatStrip` : actives, bientôt expirées, expirées, total.

Filtres et recherche comme le catalogue des sites. Bouton « Nouvelle clé ».

Chaque ligne : entreprise, nom du client s'il est rattaché, émission, expiration, badge de statut. Clic : la clé s'ouvre (panneau ou dialogue), champ monospace en lecture seule, bouton « Copier ». Toast « Clé copiée ». Notes et contact affichés. Contact absent de la liste, visible seulement dans ce détail.

Ligne sans clé : « Aucune clé pour l'instant. »

### 7.3 Dialogue « Nouvelle clé »

1. Client de l'ERP, facultatif, même recherche que « Nouveau site ». Le choisir remplit « Entreprise » avec `displayName`, que l'on peut encore éditer.
2. Entreprise, obligatoire. C'est le texte signé.
3. Durée : 12 mois par défaut, ou une date de fin.
4. Contact, facultatif.
5. Notes, facultatives.

« Émettre » envoie le POST. Succès : le dialogue montre la clé et « Copier », et ne se ferme qu'ensuite. Échec : le message du serveur, le formulaire reste rempli.

Pas de seconde confirmation : la clé n'éteint rien. Le texte sous le bouton rappelle que le nom sera celui des PDF.

### 7.4 Après l'émission

Notes, contact et client ERP se modifient sur le détail. L'entreprise, les dates et la chaîne restent en lecture seule, avec la phrase : « Pour changer le nom ou la date, émettez une nouvelle clé. L'ancienne reste valable jusqu'à son expiration. »

## 8. Côté Tracebay Autonome

L'application ne gagne aucune URL vers le hub. Le module de vérification est une fonction pure, testée par `npm run test:local`, sans fenêtre et sans réseau.

Entrée : la chaîne collée, la clé publique embarquée, la date du jour (injectée par les tests), la dernière date vue.

Sortie : `{ valide, entreprise, expire, raison }`. `raison` : `absente`, `format`, `signature`, `expiree`, `horloge`.

La clé publique SPKI est une constante du processus principal (ou un fichier livré par `files` d'electron-builder), jamais à côté d'un exécutable déjà installé que l'on pourrait remplacer sans mettre à jour l'application.

Le reste du parcours (fenêtre « Activer Tracebay », `licence.json` dans le dossier de données, nom d'entreprise imposé, lecture seule de l'API locale, horloge reculée, À propos) est celui de Tracebay Autonome, `docs/LICENCE.md`. Il consomme cette fonction et n'a pas à connaître le hub.

Tests de la fonction, avec une paire générée dans le test (la publique de production n'est pas un secret, mais les vecteurs de test ne doivent pas dépendre d'elle) :

- clé valide, entreprise et date relues ;
- signature falsifiée ;
- JSON modifié après signature (entreprise changée dans les octets) ;
- `v` différent de 1 ;
- date `expire` passée ;
- horloge reculée ;
- base64 ou nombre de segments incorrect.

La publique de production n'entre dans le dépôt qu'au moment de la version qui active le contrôle, après la génération sur le conteneur.

## 9. Mise en place, dans l'ordre

1. Sur le conteneur du hub : `hubctl tracebay-keygen` (paire créée dans `/etc/kouziahub/tracebay-ed25519.pem`, `TRACEBAY_LICENSE_KEY_FILE` posé, hub redémarré). Copier la sauvegarde chiffrée hors du serveur avant toute émission réelle : les sauvegardes du hub ne contiennent pas `/etc/kouziahub`.
2. Le hub démarre même si le fichier manque : il refuse seulement d'émettre.
3. Livrer la page Logiciels (ce document, sections 5 à 7) et vérifier l'émission avec la clé de développement.
4. Déposer la publique dans Tracebay Autonome, dans la version qui ajoute le contrôle. Pas avant : les clients déjà en 3.5.0 passeraient en lecture seule à la mise à jour automatique s'ils reçoivent le contrôle sans clé.
5. Émettre la clé du client dans le hub, la transmettre avec cette version.

Aucune route du hub n'est ajoutée au filtre d'hôte public. Tout reste derrière la session, comme `/api/sites`.

## 10. Tests du hub

Sur le modèle de `apps/api/src/__tests__/routes/sites.test.ts` et des tests de `crypto.ts`.

- Signature puis vérification, octets pour octets, y compris un nom avec accent et un guillemet.
- Refus d'émettre sans fichier de clé, liste quand même lisible.
- Refus si `months` et `expire` sont absents, ou tous les deux présents, ou hors bornes.
- Client ERP inconnu : 400, rien en base. ERP indisponible : 503, rien en base.
- La liste ne contient pas `cle`. Le GET d'une clé la contient et déchiffre.
- Le PATCH refuse `entreprise`.
- Le journal de l'émission ne contient pas la chaîne `TB1` ni le contact.
- Une base copiée ne montre pas la clé en clair (colonne `keyEncrypted`).

## 11. Hors de ce branchement

- Envoyer la clé par e-mail depuis le hub.
- Savoir quels postes l'ont activée.
- Révoquer avant l'expiration.
- Un second logiciel, tant que son format de signature n'est pas décidé.
- Un signeur hors du processus du hub.
- Faire lire au hub la clé publique embarquée dans les installeurs de `Tracebay-Releases`.
