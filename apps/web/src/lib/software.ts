import type { SoftwareSummary } from "@hub/contract";
import type { BadgeTone } from "@/components/ui/Card";
import { foldText } from "@/lib/format";
import { slugify } from "@/lib/slug";

/** Un seul état par logiciel, comme les sites : sans clé de signature, rien ne s'émet ; sinon, prêt à émettre. */
export type SoftwareState = "ready" | "nokey";
export const SOFTWARE_STATE: Record<SoftwareState, { label: string; tone: BadgeTone }> = {
  ready: { label: "Signature prête", tone: "green" },
  nokey: { label: "Clé de signature absente", tone: "amber" },
};
export const stateOf = (s: Pick<SoftwareSummary, "signing">): SoftwareState => (s.signing ? "ready" : "nokey");

export type SoftwareFilter = "all" | "ready" | "nokey" | "renew";
export const SOFTWARE_FILTERS: readonly SoftwareFilter[] = ["all", "ready", "nokey", "renew"];

export function matchesSoftwareFilter(s: SoftwareSummary, f: SoftwareFilter): boolean {
  if (f === "all") return true;
  if (f === "renew") return s.counts.expiring > 0;
  return stateOf(s) === f;
}

/** Recherche sans accents ni casse : nom, identifiant, préfixe, description. */
export function matchesSoftware(s: SoftwareSummary, q: string): boolean {
  if (!q) return true;
  return [s.name, s.slug, s.keyPrefix, s.description ?? ""].some((v) => foldText(v).includes(q));
}

/** Licences en cours : valides et bientôt expirées (encore utilisables). */
export const validCount = (s: Pick<SoftwareSummary, "counts">) => s.counts.active + s.counts.expiring;

/** Identifiant proposé depuis le nom : minuscules, chiffres, tirets, 32 caractères au plus. */
export const softwareSlugFrom = (name: string) => slugify(name).slice(0, 32).replace(/-+$/g, "");

/** Préfixe proposé : trois premières lettres de l'identifiant en majuscules, puis 1 (ATL1). */
export function prefixFrom(slug: string): string {
  const letters = slug.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 3);
  const prefix = letters.length >= 1 && /^[A-Z]/.test(letters) ? `${letters}1` : "";
  return prefix === "TB1" || prefix === "KZ1" ? `${letters}2` : prefix;
}

/** Commande à lancer sur le serveur pour créer la clé de signature (jamais depuis l'interface). */
export const keygenCommand = (slug: string) => `hubctl licence-keygen ${slug}`;
