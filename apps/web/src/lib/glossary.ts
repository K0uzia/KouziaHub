/**
 * Explications des termes techniques de la surveillance (une seule source). Textes courts, conformes au
 * cadrage (section 10) et au code de l'API (lib/monitor) : 2 échecs de suite, point muet après 15 minutes.
 */
export const GLOSSARY = {
  hub: {
    term: "le hub, point de contrôle",
    text: "Le hub contrôle chaque adresse toutes les 5 minutes, depuis le serveur derrière la box.",
  },
  worker: {
    term: "Worker de veille",
    text: "Petit programme planifié chez Cloudflare (offre gratuite) qui contrôle aussi chaque adresse toutes les 5 minutes, hors de la box. Il envoie les alertes de panne, même hub coupé.",
  },
  basisBoth: {
    term: "vu par le hub et par Cloudflare",
    text: "Les deux points de contrôle ont répondu dans les 15 dernières minutes. Une panne demande 2 échecs de suite des deux côtés.",
  },
  basisHub: {
    term: "vu par le hub seul",
    text: "Cloudflare n'a rien remonté depuis 15 minutes (Worker de veille absent ou muet) : l'état repose sur les contrôles du hub, qui conclut seul à une panne après 2 échecs de suite.",
  },
  basisEdge: {
    term: "vu par Cloudflare seul",
    text: "Le hub n'a rien contrôlé depuis 15 minutes (hub ou box hors ligne) : l'état repose sur le Worker Cloudflare, qui conclut seul à une panne après 2 échecs de suite.",
  },
  down: {
    term: "en panne",
    text: "2 échecs de suite des deux points de contrôle (ou du seul qui répond) : un incident est ouvert jusqu'au retour du site.",
  },
  localOnly: {
    term: "problème local",
    text: "Le hub n'arrive pas à joindre le site, Cloudflare oui : la cause est sans doute la box ou le DNS du fournisseur d'accès. Visible ici, sans notification.",
  },
  edgeOnly: {
    term: "vu par Cloudflare seulement",
    text: "Le hub joint le site, le Worker Cloudflare non : le problème n'est vu que depuis Cloudflare. Visible ici, sans notification.",
  },
  uptime: {
    term: "disponibilité",
    text: "Part du temps sans panne depuis le premier contrôle de l'adresse, sur 24 heures et sur 30 jours. Une panne compte de son début à son retour.",
  },
  bars: {
    term: "barres des 30 jours",
    text: "Une barre par jour : part des contrôles réussis, hub et Cloudflare réunis. Vert : aucun échec ; jaune : au moins 99 % ; rouge : moins de 99 % ; gris : pas de contrôle.",
  },
  tls: {
    term: "certificat TLS",
    text: "Le certificat TLS permet le https (le cadenas). Le hub le vérifie chaque jour : validité, émetteur, date de fin. Alerte à 30, 14 et 7 jours, et tout de suite s'il est invalide.",
  },
  rdap: {
    term: "échéance du domaine (RDAP)",
    text: "Date de fin d'enregistrement du nom de domaine, lue chaque jour par RDAP, le service public des registres. Alerte à 30, 14 et 7 jours ; certains registres ne la publient pas.",
  },
  dns: {
    term: "DNS",
    text: "Le DNS relie le nom de domaine aux serveurs. Chaque jour, le hub relève les enregistrements A, AAAA, CNAME, NS et MX et les compare à la référence acceptée ; un écart est signalé sans urgence.",
  },
  content: {
    term: "contenu de l'accueil",
    text: "Empreinte de la page d'accueil (sans ce qui change à chaque visite), relevée chaque jour. Elle est recalée à chaque publication par le hub : tout autre changement est signalé sans urgence.",
  },
  speed: {
    term: "vitesse (téléphone)",
    text: "Mesurée une fois par semaine par le hub, avec Chromium en profil téléphone, sur la page d'accueil. Aucun service tiers.",
  },
  ttfb: {
    term: "TTFB, premier octet",
    text: "TTFB : délai avant le premier octet de la réponse. Il reflète surtout le serveur et le réseau.",
  },
  lcp: {
    term: "LCP, affichage principal",
    text: "LCP : moment où le plus grand élément visible (image ou bloc de texte) est affiché. Bon jusqu'à 2,5 s.",
  },
  cls: {
    term: "CLS, stabilité",
    text: "CLS : décalages imprévus de la mise en page pendant le chargement. 0 est parfait, bon jusqu'à 0,1.",
  },
  incident: {
    term: "incident",
    text: "Période de panne, de son début (2 échecs de suite) au retour du site. Les incidents comptent dans la disponibilité et le rapport mensuel.",
  },
  report: {
    term: "rapport mensuel",
    text: "PDF par adresse et par mois : disponibilité, incidents, certificat, domaine, vitesse, DNS et contenu. Créé le 1er du mois suivant, le mois en cours à la demande. À envoyer au client depuis l'ERP.",
  },
  warnings: {
    term: "avertissements",
    text: "Adresses avec un problème local ou vu par Cloudflare seulement, un certificat invalide ou qui expire sous 30 jours, un domaine qui expire sous 30 jours, un écart DNS ou un accueil changé.",
  },
  push: {
    term: "notifications",
    text: "Alertes Web Push sur les appareils activés dans Réglages, Notifications. Elles demandent les clés créées par hubctl push-keys sur le serveur. Ni e-mail ni SMS.",
  },
  zones: {
    term: "domaines Cloudflare proposés",
    text: "Domaines du compte Cloudflare, lus par un jeton en lecture seule. Rien n'est surveillé sans votre accord.",
  },
  failClosed: {
    term: "fail closed",
    text: "Réglage des projets Cloudflare Pages : si le quota gratuit de Functions est épuisé, Cloudflare renvoie une erreur au lieu de servir le site sans le script du hub (noindex, en-têtes, 403). Vérifié chaque jour.",
  },
} as const satisfies Record<string, { term: string; text: string }>;

export type GlossaryKey = keyof typeof GLOSSARY;
