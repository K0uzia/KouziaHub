// Rapport mensuel envoyé au client : règles et phrases en langage clair (cadrage 10.7). Fonctions pures.
// Références : GOV.UK « Use clear language » (mots courants, phrases de 25 mots au plus) et NN/g « Plain
// Language Is for Everyone, Even Experts » (l'essentiel d'abord, phrases courtes). Aucun terme technique
// visible : ni sigle, ni code d'erreur.

export const PARIS = "Europe/Paris";

// --- Dates, heures et durées en français, fuseau Europe/Paris ---

const dayFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, day: "numeric", month: "long" });
const dayYearFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const monthFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, month: "long" });
const monthYearFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, month: "long", year: "numeric" });

/** « 1er mars » pour le premier jour du mois, comme à l'écrit. */
const firstDay = (text: string) => text.replace(/^1 /, "1er ");
/** Espaces fines de Intl remplacées : hors du jeu de caractères de la police du PDF. */
const plainSpaces = (text: string) => text.replace(/[  ]/g, " ");

/** « 12 octobre » */
export const frDay = (d: Date) => firstDay(plainSpaces(dayFmt.format(d)));
/** « 31 décembre 2026 » */
export const frDayYear = (d: Date) => firstDay(plainSpaces(dayYearFmt.format(d)));
/** « 3 h 02 » */
export function frTime(d: Date): string {
  const [h, m] = plainSpaces(timeFmt.format(d)).split(":");
  return `${Number(h)} h ${m}`;
}
/** « septembre » */
export const frMonth = (d: Date) => plainSpaces(monthFmt.format(d));
/** « octobre 2026 » */
export const frMonthYear = (d: Date) => plainSpaces(monthYearFmt.format(d));

const parisDayKey = (d: Date) => plainSpaces(dayYearFmt.format(d));

const unit = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** « 14 minutes », « 1 heure et 5 minutes », « 2 jours et 3 heures » (moins d'une minute : « moins d'une minute »). */
export function frDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return unit(minutes, "minute", "minutes");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${unit(hours, "heure", "heures")} et ${unit(rest, "minute", "minutes")}` : unit(hours, "heure", "heures");
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${unit(days, "jour", "jours")} et ${unit(h, "heure", "heures")}` : unit(days, "jour", "jours");
}

/** Pourcentage de disponibilité : jamais arrondi vers le haut (99,996 reste 99,99), virgule française. */
export function frPercent(value: number): string {
  if (value >= 100) return "100";
  const floored = Math.floor(value * 100) / 100;
  return String(floored).replace(".", ",");
}

/** Secondes avec une décimale : « 1,8 ». */
export const frSeconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1).replace(".", ",");

// --- Vitesse (Core Web Vitals, web.dev) ---

/**
 * Seuils officiels de web.dev, au 75e centile : LCP bon jusqu'à 2,5 s, mauvais au-delà de 4 s ; CLS bon
 * jusqu'à 0,1, mauvais au-delà de 0,25. Rapide : les deux bons. Lent : l'un des deux mauvais. Correct sinon.
 */
export const SPEED_LCP_GOOD_MS = 2500;
export const SPEED_LCP_POOR_MS = 4000;
export const SPEED_CLS_GOOD = 0.1;
export const SPEED_CLS_POOR = 0.25;
/** Écart avec le mois précédent sous lequel on parle de vitesse « comme le mois dernier ». */
export const SPEED_SAME_MS = 300;

export type SpeedVerdict = "Rapide" | "Correct" | "Lent";

export function speedVerdict(lcpMs: number, cls: number | null): SpeedVerdict {
  const c = cls ?? 0;
  if (lcpMs > SPEED_LCP_POOR_MS || c > SPEED_CLS_POOR) return "Lent";
  if (lcpMs <= SPEED_LCP_GOOD_MS && c <= SPEED_CLS_GOOD) return "Rapide";
  return "Correct";
}

export function stabilityText(cls: number | null): string | null {
  if (cls === null) return null;
  if (cls <= SPEED_CLS_GOOD) return "Stabilité de l'affichage : bonne (rien ne bouge pendant le chargement).";
  if (cls <= SPEED_CLS_POOR) return "Stabilité de l'affichage : moyenne (quelques éléments bougent pendant le chargement).";
  return "Stabilité de l'affichage : à améliorer (la page bouge pendant le chargement).";
}

/** Comparaison au mois précédent : « plus rapide qu'en septembre », « comme le mois dernier », « première mesure ». */
export function speedComparison(lcpMs: number, previousLcpMs: number | null, previousMonth: Date): string {
  if (previousLcpMs === null) return "Première mesure.";
  const month = frMonth(previousMonth);
  if (Math.abs(lcpMs - previousLcpMs) < SPEED_SAME_MS) return "Comme le mois dernier.";
  return lcpMs < previousLcpMs ? `Plus rapide qu'en ${month}.` : `Plus lent qu'en ${month}.`;
}

// --- État du mois (phrase-verdict) ---

export type ReportState = "ok" | "watch" | "resolved";
export const STATE_LABEL: Record<ReportState, string> = { ok: "Tout va bien", watch: "À surveiller", resolved: "Problème réglé" };

/** Disponibilité sous laquelle le mois est « À surveiller », même sans coupure en cours. */
export const STATE_MIN_UPTIME = 99;
/** Échéances proches : cadenas sous 14 jours, nom de domaine sous 30 jours (à la date du rapport). */
export const STATE_CERT_DAYS = 14;
export const STATE_DOMAIN_DAYS = 30;

export type StateInput = {
  uptime: number | null;
  incidents: number;
  openIncident: boolean;
  certificateProblem: boolean;
  certificateDaysLeft: number | null;
  domainDaysLeft: number | null;
  speed: SpeedVerdict | null;
};

/**
 * Règle de l'état, du plus grave au plus doux :
 * - À surveiller : coupure encore en cours, ou disponibilité sous 99 %, ou aucune mesure, ou problème de
 *   cadenas, ou cadenas qui expire sous 14 jours, ou nom de domaine qui expire sous 30 jours, ou site lent ;
 * - Problème réglé : au moins une coupure dans le mois, toutes terminées ;
 * - Tout va bien : sinon.
 */
export function reportState(i: StateInput): { state: ReportState; reasons: string[] } {
  const reasons: string[] = [];
  if (i.openIncident) reasons.push("open_incident");
  if (i.uptime === null) reasons.push("no_data");
  else if (i.uptime < STATE_MIN_UPTIME) reasons.push("low_uptime");
  if (i.certificateProblem) reasons.push("certificate_problem");
  else if (i.certificateDaysLeft !== null && i.certificateDaysLeft <= STATE_CERT_DAYS) reasons.push("certificate_soon");
  if (i.domainDaysLeft !== null && i.domainDaysLeft <= STATE_DOMAIN_DAYS) reasons.push("domain_soon");
  if (i.speed === "Lent") reasons.push("slow");
  if (reasons.length) return { state: "watch", reasons };
  return { state: i.incidents > 0 ? "resolved" : "ok", reasons };
}

/** Phrase d'ouverture : vraie, courte, l'essentiel d'abord. */
export function verdictSentence(input: {
  state: ReportState;
  reasons: string[];
  uptime: number | null;
  incidents: number;
  openSince: Date | null;
  certificateUntil: Date | null;
  domainUntil: Date | null;
}): string {
  const pct = input.uptime === null ? null : `${frPercent(input.uptime)} %`;
  if (input.state === "ok") return `Votre site a bien fonctionné ce mois-ci : il était accessible ${pct} du temps.`;
  if (input.state === "resolved") {
    const n = input.incidents;
    return `Votre site a été inaccessible ${n > 1 ? `${n} fois` : "une fois"} ce mois-ci, puis il est revenu : il était accessible ${pct} du temps.`;
  }
  const r = input.reasons;
  if (r.includes("open_incident") && input.openSince) {
    return `Votre site est inaccessible depuis le ${frDay(input.openSince)} à ${frTime(input.openSince)}. Kouzia suit la situation.`;
  }
  if (r.includes("no_data")) return "Nous n'avons pas encore de mesure pour ce mois : la surveillance vient de commencer.";
  if (r.includes("low_uptime")) return `Votre site a connu des coupures ce mois-ci : il n'était accessible que ${pct} du temps.`;
  if (r.includes("certificate_problem")) return "Votre site a fonctionné, mais le cadenas de sécurité présente un problème.";
  if (r.includes("certificate_soon") && input.certificateUntil) {
    return `Votre site a bien fonctionné, mais le cadenas de sécurité arrive à échéance le ${frDayYear(input.certificateUntil)}.`;
  }
  if (r.includes("domain_soon") && input.domainUntil) {
    return `Votre site a bien fonctionné, mais le nom de domaine doit être renouvelé avant le ${frDayYear(input.domainUntil)}.`;
  }
  return "Votre site a fonctionné, mais il s'ouvre lentement sur téléphone.";
}

// --- Coupures en phrases ---

export type IncidentInput = { startedAt: Date; endedAt: Date | null; selfRecovered: boolean | null };

/**
 * « Le 12 octobre, le site a été inaccessible 14 minutes, entre 3 h 02 et 3 h 16. Il est revenu tout seul. »
 * « Revenu tout seul » seulement si aucune action n'a été faite pendant la coupure (selfRecovered vrai).
 */
export function incidentSentence(i: IncidentInput, now: number): string {
  if (!i.endedAt) {
    return `Depuis le ${frDay(i.startedAt)} à ${frTime(i.startedAt)}, le site est inaccessible (${frDuration(now - i.startedAt.getTime())} à la fin du rapport).`;
  }
  const duration = frDuration(i.endedAt.getTime() - i.startedAt.getTime());
  const sameDay = parisDayKey(i.startedAt) === parisDayKey(i.endedAt);
  const when = sameDay
    ? `Le ${frDay(i.startedAt)}, le site a été inaccessible ${duration}, entre ${frTime(i.startedAt)} et ${frTime(i.endedAt)}.`
    : `Du ${frDay(i.startedAt)} à ${frTime(i.startedAt)} au ${frDay(i.endedAt)} à ${frTime(i.endedAt)}, le site a été inaccessible ${duration}.`;
  const after = i.selfRecovered === true ? " Il est revenu tout seul." : i.selfRecovered === false ? " Il a été rétabli." : " Il est de nouveau accessible.";
  return when + after;
}

/** Au-delà, les coupures les plus courtes sont résumées en une ligne (le rapport tient sur deux pages). */
export const INCIDENTS_DETAILED = 5;

export function summarizeShortIncidents(count: number, totalMs: number, longestMs: number): string {
  return `Et ${count} coupure${count > 1 ? "s" : ""} plus courte${count > 1 ? "s" : ""} (${frDuration(longestMs)} au plus chacune), ${frDuration(totalMs)} au total.`;
}

// --- Contraste à l'impression (WCAG 2.2, 4,5:1 au moins) ---

function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

// --- Typographie française ---

export const NBSP = "\u00a0";
export const NNBSP = "\u202f";

const UNIT_AFTER_NUMBER =
  /(\d(?:er)?) (?=(?:s|min|h|j|jours?|heures?|minutes?|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?![\p{L}\d]))/gu;

/**
 * Espaces insécables avant « % : ; ? ! » (fines si la police les a), entre les milliers d'un nombre, entre
 * un nombre et son unité ou son mois (« 1,8 s », « 11 novembre »), et
 * « 1er » en exposant (« 1ᵉʳ », glyphes présents dans Source Sans 3). Pour une police sans ces glyphes
 * (Exo 2), narrow et superscript à faux : espace insécable normale, « 1er » laissé tel quel.
 */
export function frenchTypography(text: string, options: { narrow?: boolean; superscript?: boolean } = {}): string {
  const narrow = options.narrow ?? true;
  const space = narrow ? NNBSP : NBSP;
  let out = text.replace(/[ \u00a0\u202f]([%:;?!])/g, `${space}$1`);
  out = out.replace(/(\d)[ \u00a0\u202f](?=\d{3}(?!\d))/g, `$1${space}`);
  // Nombre et unité ou mois sur la même ligne : « 1,8 s », « 47 min », « 1 h 21 », « 11 novembre ».
  out = out.replace(UNIT_AFTER_NUMBER, `$1${NBSP}`).replace(/\bh (?=\d)/g, `h${NBSP}`);
  if (options.superscript ?? true) out = out.replace(/\b1er\b/g, "1\u1d49\u02b3");
  return out;
}

/** Durée courte pour un tableau : « 47 min », « 1 h 21 », « 2 j 3 h ». */
export function frShortDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} j ${hours % 24} h` : `${days} j`;
}

/** Téléphone enregistré « 0612345678 », affiché « 06 12 34 56 78 » (espaces insécables). */
export function frPhone(stored: string): string {
  return /^0\d{9}$/.test(stored) ? (stored.match(/\d\d/g) ?? []).join(NBSP) : stored;
}

/** Site web enregistré « https://www.exemple.fr », affiché sans le protocole. */
export const frWebsite = (stored: string) => stored.replace(/^https:\/\//i, "");
