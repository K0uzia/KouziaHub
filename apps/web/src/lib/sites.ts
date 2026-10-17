import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowsRotate,
  faCircleCheck,
  faCircleMinus,
  faHourglassHalf,
  faTrashCan,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import type { OperationKind, SiteSummary, VersionEntry } from "@hub/contract";
import type { BadgeTone } from "@/components/ui/Card";

/** Filtre d'état du catalogue. */
export type StateFilter = "all" | "online" | "offline" | "creating" | "error";

export type DisplayState = {
  key: "online" | "offline" | "creating" | "error" | "deleting" | "busy";
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

/** État affiché d'un site : texte + icône + teinte (la teinte n'est jamais seule à porter l'information). */
export function displayState(site: Pick<SiteSummary, "state" | "operation" | "domainStatus">): DisplayState {
  const op = site.operation;
  if (site.state === "DELETING") return { key: "deleting", label: "Suppression en cours", icon: faTrashCan, tone: "neutral" };
  if (op?.status === "FAILED" || site.domainStatus === "ERROR")
    return { key: "error", label: "Erreur", icon: faTriangleExclamation, tone: "red" };
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

export function matchesState(site: SiteSummary, filter: StateFilter): boolean {
  if (filter === "all") return true;
  const key = displayState(site).key;
  if (filter === "online") return site.state === "ONLINE" && key !== "error";
  if (filter === "offline") return site.state === "OFFLINE" && key !== "error";
  if (filter === "creating") return key !== "error" && site.state === "CREATING";
  return key === "error";
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
