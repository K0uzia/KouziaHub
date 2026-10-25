import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowsRotate,
  faCircleCheck,
  faCircleExclamation,
  faCircleMinus,
  faHourglassHalf,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";
import type { OperationKind, PhpServerStatus, SiteSummary, VersionEntry } from "@hub/contract";
import type { BadgeTone } from "@/components/ui/Card";
import { formatSince, VERDICT } from "@/lib/monitor";

/** Filtre d'état du catalogue : un filtre par état affiché (« En panne » a le sien, comme son badge). */
export type StateFilter = "all" | "down" | "error" | "creating" | "offline" | "online";

export type DisplayState = {
  key: "down" | "online" | "offline" | "creating" | "error" | "deleting" | "busy";
  label: string;
  icon: IconDefinition;
  tone: BadgeTone;
};

const RUNNING_LABEL: Record<OperationKind, string> = {
  CREATE: "En création",
  ENABLE: "Mise en ligne en cours",
  DISABLE: "Mise hors ligne en cours",
  DELETE: "Suppression en cours",
  PUBLISH: "Publication en cours",
};

/**
 * Opération terminée dont l'étape « certificate » attend encore (création ou remise en ligne) :
 * ni un échec ni un succès final, « certificat en cours, quelques minutes ».
 */
export function waitsForCertificate(site: Pick<SiteSummary, "operation">): boolean {
  const op = site.operation;
  return !!op && op.status === "DONE" && op.steps.some((s) => s.key === "certificate" && s.status === "waiting");
}

type StatusInput = Pick<SiteSummary, "state" | "operation" | "domainStatus"> & Partial<Pick<SiteSummary, "monitor">>;

/** Une cible surveillée du site est en panne (« Problème local » et « vu par Cloudflare seul » n'en sont pas). */
export function isDown(site: Partial<Pick<SiteSummary, "monitor">>): boolean {
  return !!site.monitor && site.monitor.watched > 0 && site.monitor.verdict === "down";
}

/**
 * État UNIQUE affiché d'un site (carte, liste, fiche), par priorité :
 * 1. panne (surveillance) ; 2. suppression, erreur, création et opérations en cours ; 3. hors ligne ; 4. en ligne.
 * Texte + icône + teinte (la teinte n'est jamais seule à porter l'information).
 */
export function displayState(site: StatusInput, now = new Date()): DisplayState {
  if (isDown(site)) {
    const since = site.monitor!.openIncidentSince;
    return { key: "down", label: since ? `Panne depuis ${formatSince(since, now)}` : "En panne", icon: VERDICT.down.icon, tone: "red" };
  }
  return siteState(site);
}

/** État du site seul (interrupteur, opérations), sans la surveillance : base de l'état détaillé de la fiche. */
export function siteState(site: Pick<SiteSummary, "state" | "operation" | "domainStatus">): DisplayState {
  const op = site.operation;
  if (site.state === "DELETING") return { key: "deleting", label: "Suppression en cours", icon: faTrashCan, tone: "neutral" };
  if (op?.status === "FAILED" || site.domainStatus === "ERROR")
    return { key: "error", label: "Erreur", icon: faCircleExclamation, tone: "red" };
  if (waitsForCertificate(site))
    return { key: "busy", label: "Certificat en cours", icon: faHourglassHalf, tone: "blue" };
  if (site.state === "CREATING") return { key: "creating", label: "En création", icon: faHourglassHalf, tone: "amber" };
  if (op?.status === "RUNNING") return { key: "busy", label: RUNNING_LABEL[op.kind], icon: faArrowsRotate, tone: "blue" };
  if (site.state === "ONLINE") {
    if (site.domainStatus === "PENDING")
      return { key: "busy", label: "Certificat en cours", icon: faHourglassHalf, tone: "blue" };
    return { key: "online", label: "En ligne", icon: faCircleCheck, tone: "green" };
  }
  return { key: "offline", label: "Hors ligne", icon: faCircleMinus, tone: "neutral" };
}

/**
 * Filtre où range le badge affiché : chaque site sous un seul filtre, celui de son état. Une opération en
 * cours (publication, certificat) reste sous l'état de l'interrupteur ; une suppression n'est que sous « Tous ».
 */
export function stateBucket(site: StatusInput): Exclude<StateFilter, "all"> | null {
  const key = displayState(site).key;
  if (key === "down" || key === "error" || key === "creating" || key === "online" || key === "offline") return key;
  if (key === "deleting") return null;
  return site.state === "ONLINE" ? "online" : site.state === "OFFLINE" ? "offline" : "creating";
}

export function matchesState(site: StatusInput, filter: StateFilter): boolean {
  return filter === "all" || stateBucket(site) === filter;
}

/**
 * État détaillé de la fiche quand le site et sa surveillance divergent (« En ligne, mais en panne vue de
 * l'extérieur depuis 18 h 26 ») ; null quand le badge dit déjà tout.
 */
export function divergence(site: StatusInput, now = new Date()): string | null {
  const m = site.monitor;
  // Heure insécable : « 19 h 12 » ne se coupe pas en fin de ligne.
  const since = (iso: string) => formatSince(iso, now).replace(/ /g, " ");
  if (!m || m.watched === 0) return null;
  const base = siteState(site).label;
  if (m.verdict === "down")
    return m.openIncidentSince
      ? `${base}, mais en panne vue de l'extérieur depuis ${since(m.openIncidentSince)}.`
      : `${base}, mais en panne vue de l'extérieur.`;
  if (m.verdict === "local_only") return `${base} ; surveillance : problème local (le hub ne joint pas le site, Cloudflare oui).`;
  if (m.verdict === "edge_only") return `${base} ; surveillance : vu en échec par Cloudflare seulement.`;
  return null;
}

/** Une opération en cours ou un certificat en attente : la fiche s'actualise d'elle-même. */
export function isSettling(site: Pick<SiteSummary, "operation" | "domainStatus" | "state">): boolean {
  return (
    site.operation?.status === "RUNNING" ||
    waitsForCertificate(site) ||
    site.domainStatus === "PENDING" ||
    site.state === "CREATING" ||
    site.state === "DELETING"
  );
}

export function versionSourceLabel(v: Pick<VersionEntry, "source" | "sourceVersionNumber">): string {
  if (v.source === "files") return "Fichiers";
  if (v.source === "zip") return "Archive zip";
  if (v.source === "placeholder") return "Page d'attente";
  return v.sourceVersionNumber != null ? `Republication de la version ${v.sourceVersionNumber}` : "Republication";
}

export function versionStatusLabel(v: Pick<VersionEntry, "status">): { label: string; tone: BadgeTone } {
  if (v.status === "PUBLISHED") return { label: "Publiée", tone: "green" };
  if (v.status === "UPLOADING") return { label: "Envoi en cours", tone: "blue" };
  if (v.status === "FAILED") return { label: "Échec", tone: "red" };
  return { label: "Archivée sans fichiers", tone: "neutral" };
}

export const OPERATION_TITLE: Record<OperationKind, string> = {
  CREATE: "Création du site",
  ENABLE: "Mise en ligne",
  DISABLE: "Mise hors ligne",
  DELETE: "Suppression",
  PUBLISH: "Publication",
};

/**
 * Versions de PHP proposées à la création, ou la raison de leur absence (affichée : un choix « PHP » qui
 * disparaît sans mot fait créer un site Pages par erreur, recette du 25/10/2026). null pendant le chargement.
 */
export function phpHostingChoice(status: PhpServerStatus | null, readError: boolean): { versions: string[]; unavailable: string | null } | null {
  if (!status) return readError ? { versions: [], unavailable: "état du serveur des sites PHP illisible." } : null;
  if (!status.configured) return { versions: [], unavailable: "serveur des sites PHP pas encore relié au hub (README, 11.8)." };
  if (!status.reachable) return { versions: [], unavailable: `serveur des sites PHP injoignable : ${status.error}` };
  if (!status.state.php.length) return { versions: [], unavailable: "aucune version de PHP installée sur le serveur des sites PHP." };
  return { versions: status.state.php, unavailable: null };
}
