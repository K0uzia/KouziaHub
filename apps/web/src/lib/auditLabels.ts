/**
 * Libellés des actions du journal. Une action inconnue de cette table s'affiche telle que le serveur
 * l'écrit (rien d'inventé) ; table à compléter quand le serveur ajoute une action.
 */
export const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Connexion",
  "auth.2fa": "Code de connexion refusé",
  "auth.lock": "Compte verrouillé",
  "site.create": "Création du site",
  "site.update": "Modification du site",
  "site.enable": "Remise en ligne",
  "site.disable": "Mise hors ligne",
  "site.delete": "Suppression du site",
  "site.certificate": "Certificat de l'adresse",
  "site.php.settings": "Réglages de PHP",
  "site.php.env": "Variables d'environnement",
  "site.php.db.create": "Création de la base",
  "site.php.db.import": "Import dans la base",
  "site.php.db.export": "Export de la base",
  "site.php.db.reset": "Base vidée",
  "site.php.db.restore": "Base restaurée",
  "site.php.backup": "Sauvegarde de nuit de la base",
  "site.php.script": "Script du projet",
  "version.publish": "Publication",
  "version.republish": "Republication d'une version",
  "version.force": "Publication malgré le contrôle de la version",
  "files.upload": "Envoi de fichiers",
  "files.delete": "Suppression de fichiers",
  "files.move": "Renommage",
  "files.zip": "Envoi d'un zip",
  "files.restore": "Restauration d'une version",
  "files.clean-dev": "Fichiers de développement retirés",
  "thumbnail.upload": "Vignette envoyée",
  "thumbnail.capture": "Capture de la vignette",
  "thumbnail.focus": "Cadrage de la vignette",
  "orphan.delete": "Suppression d'un enregistrement DNS orphelin",
  "monitor.target.create": "Adresse ajoutée à la surveillance",
  "monitor.target.update": "Surveillance modifiée",
  "monitor.target.delete": "Adresse retirée de la surveillance",
  "monitor.zone.watch": "Domaine Cloudflare surveillé",
  "monitor.dns.accept": "DNS accepté comme référence",
  "monitor.content.accept": "Accueil accepté comme référence",
  "monitor.report.generate": "Rapport mensuel créé",
  "push.subscribe": "Notifications activées sur un appareil",
  "push.unsubscribe": "Appareil retiré des notifications",
  "push.test": "Notification de test",
  "cloudflare.fail_open.fix": "Réglage « fail closed » d'un projet recalé",
  "files.purge": "Fichiers de travail vidés",
  "versions.purge": "Anciennes versions supprimées",
  "cache.purge": "Place libérée sur le hub",
  "cache.cloudflare.purge": "Cache Cloudflare vidé",
  "version.export": "Version de production téléchargée",
  "server-config.generate": "Configuration serveur générée",
  "server-config.skip": "Configuration serveur non générée",
  "settings.reports": "Coordonnées des rapports modifiées",
  "site.indexing": "Indexation par les moteurs",
  "licence.emettre": "Clé de licence émise",
  "licence.modifier": "Clé de licence modifiée",
  "logiciel.creer": "Logiciel ajouté",
  "logiciel.modifier": "Logiciel modifié",
  "logiciel.vignette": "Vignette du logiciel",
  "logiciel.supprimer": "Logiciel supprimé",
};

/** Familles filtrables d'un coup (« licence.* » : émissions et modifications des clés). */
export const ACTION_FAMILY_LABEL: Record<string, string> = {
  "licence.*": "Clés de licence (toutes)",
  "logiciel.*": "Logiciels (fiches)",
};

/** Libellé d'une action ; null si la table ne la connaît pas (le code est alors affiché tel quel). */
export function actionLabel(action: string): string | null {
  return ACTION_LABEL[action] ?? null;
}
