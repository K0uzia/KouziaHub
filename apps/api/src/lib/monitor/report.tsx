import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Circle, Document, Font, Line, Page, Path, Polygon, Rect, StyleSheet, Svg, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { MonitorCheck, MonitorTarget } from "@prisma/client";
import type { ReportSettings } from "@/contract.js";
import type { ErpDirectory } from "@/lib/erp/types.js";
import { prisma } from "@/lib/prisma.js";
import { availability } from "@/lib/monitor/view.js";
import { getReportSettings } from "@/lib/report-settings.js";
import {
  PARIS,
  STATE_LABEL,
  frDay,
  frDayYear,
  frPercent,
  frPhone,
  frSeconds,
  frShortDuration,
  frTime,
  frWebsite,
  frenchTypography,
  reportState,
  speedComparison,
  speedVerdict,
  stabilityText,
  verdictSentence,
  type ReportState,
  type SpeedVerdict,
} from "@/lib/monitor/report-text.js";

// Rapport mensuel envoyé au client (cadrage 10.7) : une page A4 (deux au plus), langage clair, aucun
// terme technique. Le détail technique reste dans le hub, pour Alexandre ; il n'est pas joint au PDF.

// Polices embarquées depuis le dépôt (jamais d'un CDN) : TTF statiques, deux graisses par famille.
// Exo 2 pour les titres ; Source Sans 3 pour le texte, les dates et les nombres (chiffres tabulaires par
// défaut, espace fine insécable et « ᵉʳ » présents). Voir apps/api/assets/fonts/README.md.
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts");
export const TITLE_FONT = "Exo 2";
export const TEXT_FONT = "Source Sans 3";
Font.register({
  family: TITLE_FONT,
  fonts: [
    { src: path.join(FONT_DIR, "Exo2-SemiBold.ttf"), fontWeight: 600 },
    { src: path.join(FONT_DIR, "Exo2-Bold.ttf"), fontWeight: 700 },
  ],
});
Font.register({
  family: TEXT_FONT,
  fonts: [
    { src: path.join(FONT_DIR, "SourceSans3-Regular.ttf"), fontWeight: 400 },
    { src: path.join(FONT_DIR, "SourceSans3-Semibold.ttf"), fontWeight: 600 },
  ],
});
Font.registerHyphenationCallback((word) => [word]);

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Décalage de Paris sur UTC (ms) à un instant donné. */
function parisOffset(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PARIS,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - (at - (at % 1000));
}

/** Minuit à Paris pour une date (mois de 0 à 11 et jour, débordements acceptés). */
function parisMidnight(year: number, monthIndex: number, day = 1): Date {
  const guess = Date.UTC(year, monthIndex, day);
  const first = guess - parisOffset(guess);
  return new Date(guess - parisOffset(first));
}

/** Début et fin du mois, au fuseau de Paris. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error("mois invalide");
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { start: parisMidnight(year, index), end: parisMidnight(year, index + 1) };
}

const parse = <T,>(c: Pick<MonitorCheck, "detail"> | null | undefined): T | null => {
  if (!c?.detail) return null;
  try {
    return JSON.parse(c.detail) as T;
  } catch {
    return null;
  }
};

const DAY_MS = 86_400_000;
/** Au-delà, les coupures les plus courtes sont résumées sous le tableau (deux pages au plus). */
export const INCIDENT_ROWS = 8;

export type DayStatus = "ok" | "incident" | "nodata";
export type IncidentRow = { date: string; hours: string; duration: string; ongoing: boolean };

/** Contenu du rapport, déjà rédigé : le rendu ne fait que le placer. */
export type ReportView = {
  clientName: string;
  hostname: string;
  /** « du 1er au 31 octobre 2026 » (le rendu met « er » en exposant). */
  period: string;
  generatedOn: string;
  state: ReportState;
  stateLabel: string;
  verdict: string;
  uptime: string | null;
  availabilityNote: string;
  /** Un jour par barre de la frise, du 1er au dernier jour du mois. */
  days: DayStatus[];
  incidentsSummary: string | null;
  incidentRows: IncidentRow[];
  incidentsRest: string | null;
  certificate: string[] | null;
  domain: string[] | null;
  speed: { verdict: SpeedVerdict; seconds: string; comparison: string; stability: string | null } | null;
  /** Chiffres clés tirés des données ; une valeur à zéro est masquée. */
  figures: Array<{ value: string; label: string }>;
  footer: { preparedBy: string; contact: string[] };
};

export type ReportContext = {
  /** Nom du client (lu dans l'ERP au moment de la génération, jamais stocké) ou libellé du site. */
  clientName?: string | null;
  settings?: ReportSettings | null;
};

const count = (n: number) => n.toLocaleString("fr-FR").replace(/[  ]/g, " ");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n > 1 ? many : one}`;

/**
 * Nom affiché en tête : site client, nom lu dans l'ERP ; site perso, son libellé ; domaine ajouté à la
 * main, son libellé ; repli sur le nom d'hôte. Jamais stocké.
 */
export async function reportContext(erp: ErpDirectory, target: MonitorTarget): Promise<ReportContext> {
  const site = target.siteId ? await prisma.site.findUnique({ where: { id: target.siteId }, select: { label: true, erpClientId: true } }) : null;
  const erpId = target.erpClientId ?? site?.erpClientId ?? null;
  let clientName: string | null = null;
  if (erpId) {
    try {
      clientName = (await erp.get(erpId))?.displayName ?? null;
    } catch {
      clientName = null;
    }
  }
  clientName ||= site?.label || (target.source !== "site" ? target.label : null) || target.hostname;
  return { clientName, settings: await getReportSettings() };
}

/** Données du mois d'une cible, rédigées en langage clair (fonction testée à part du rendu). */
export async function buildReportView(target: MonitorTarget, month: string, now = Date.now(), ctx: ReportContext = {}): Promise<ReportView> {
  const { start, end } = monthBounds(month);
  const to = Math.min(end.getTime(), now);
  const inMonth = { gte: start, lt: end };
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const prevStart = parisMidnight(year, monthIndex - 1);

  const [incidents, firstHttp, hourly, tls, tlsCount, domain, domainCount, speed, prevSpeed, speedCount, dnsChecks, alerts] = await Promise.all([
    prisma.monitorIncident.findMany({
      where: { targetId: target.id, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
      orderBy: { startedAt: "asc" },
    }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "http" }, orderBy: { at: "asc" }, select: { at: true } }),
    prisma.monitorHourly.findMany({ where: { targetId: target.id, hour: inMonth }, select: { hour: true, checks: true } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "tls", at: { lt: end } }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.count({ where: { targetId: target.id, kind: "tls", at: inMonth } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "domain", at: { lt: end } }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.count({ where: { targetId: target.id, kind: "domain", at: inMonth } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "speed", ok: true, at: inMonth }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "speed", ok: true, at: { gte: prevStart, lt: start } }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.count({ where: { targetId: target.id, kind: "speed", at: inMonth } }),
    prisma.monitorCheck.findMany({ where: { targetId: target.id, kind: "dns", at: inMonth }, select: { detail: true, at: true } }),
    prisma.monitorAlert.count({ where: { targetId: target.id, sentAt: inMonth } }),
  ]);

  // Disponibilité au sens de la règle de décision, depuis le premier signe de surveillance.
  const firstSeen = Math.min(firstHttp?.at.getTime() ?? Infinity, ...hourly.map((h) => h.hour.getTime()));
  const uptimeValue = availability(incidents, start.getTime(), to, Number.isFinite(firstSeen) ? firstSeen : null);
  const open = incidents.find((i) => !i.endedAt) ?? null;

  // Frise : un jour par barre (heures de Paris), coupure, journée surveillée sans coupure, ou sans donnée.
  const lastDay = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const days: DayStatus[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const from = parisMidnight(year, monthIndex, d).getTime();
    const until = parisMidnight(year, monthIndex, d + 1).getTime();
    const cut = incidents.some((i) => i.startedAt.getTime() < until && (i.endedAt?.getTime() ?? to) > from);
    const watched = from < to && hourly.some((h) => h.hour.getTime() >= from && h.hour.getTime() < until);
    days.push(cut ? "incident" : watched ? "ok" : "nodata");
  }

  // Coupures : synthèse, tableau (les plus longues), reste résumé.
  const withDuration = incidents.map((i) => ({ i, ms: (i.endedAt?.getTime() ?? to) - i.startedAt.getTime() }));
  const downMs = withDuration.reduce((s, x) => s + Math.min(x.i.endedAt?.getTime() ?? to, to) - Math.max(x.i.startedAt.getTime(), start.getTime()), 0);
  const shown = [...withDuration]
    .sort((a, b) => (a.i.endedAt ? 0 : -1) - (b.i.endedAt ? 0 : -1) || b.ms - a.ms)
    .slice(0, INCIDENT_ROWS)
    .sort((a, b) => a.i.startedAt.getTime() - b.i.startedAt.getTime());
  const rest = withDuration.filter((x) => !shown.includes(x));
  const incidentRows: IncidentRow[] = shown.map(({ i, ms }) => {
    if (!i.endedAt) return { date: frDay(i.startedAt), hours: `depuis ${frTime(i.startedAt)}`, duration: `en cours (${frShortDuration(ms)})`, ongoing: true };
    const sameDay = frDay(i.startedAt) === frDay(i.endedAt);
    return {
      date: sameDay ? frDay(i.startedAt) : `${frDay(i.startedAt)} au ${frDay(i.endedAt)}`,
      hours: `de ${frTime(i.startedAt)} à ${frTime(i.endedAt)}`,
      duration: frShortDuration(ms),
      ongoing: false,
    };
  });
  const incidentsSummary = incidents.length
    ? `${plural(incidents.length, "coupure", "coupures")} ce mois-ci, ${frShortDuration(downMs)} au total ; ${
        open ? "une est encore en cours." : incidents.length > 1 ? "toutes réglées." : "réglée."
      }`
    : null;
  const incidentsRest = rest.length
    ? `Et ${plural(rest.length, "coupure plus courte", "coupures plus courtes")} (${frShortDuration(Math.max(...rest.map((x) => x.ms)))} au plus chacune), ${frShortDuration(rest.reduce((s, x) => s + x.ms, 0))} au total.`
    : null;

  // Cadenas et nom de domaine, à la date du rapport.
  const tlsDetail = parse<{ ok: boolean; validTo: string | null; error: string | null }>(tls);
  const certUntil = tlsDetail?.validTo ? new Date(tlsDetail.validTo) : null;
  const certDays = certUntil ? Math.floor((certUntil.getTime() - to) / DAY_MS) : null;
  const certProblem = Boolean(tlsDetail && !tlsDetail.ok);
  let certificate: string[] | null = null;
  if (tlsDetail) {
    if (certProblem) {
      certificate = [
        tlsDetail.error === "certificat expiré"
          ? "Le cadenas de sécurité a expiré : les visiteurs voient un avertissement."
          : "Le cadenas de sécurité ne s'affiche pas correctement : les visiteurs peuvent voir un avertissement.",
      ];
    } else if (certUntil) {
      certificate = [
        `Certificat de sécurité (le cadenas) valable jusqu'au ${frDayYear(certUntil)}.`,
        certDays !== null && certDays <= 30 ? `Plus que ${plural(Math.max(0, certDays), "jour", "jours")} avant son renouvellement.` : "Kouzia est prévenu 30 jours avant cette date.",
      ];
    }
  }

  const domainDetail = parse<{ expiresAt: string | null }>(domain);
  const domainUntil = domainDetail?.expiresAt ? new Date(domainDetail.expiresAt) : null;
  const domainDays = domainUntil ? Math.floor((domainUntil.getTime() - to) / DAY_MS) : null;
  let domainLines: string[] | null = null;
  const driftLine = () => {
    const drift = dnsChecks.filter((c) => parse<{ status: string }>(c)?.status === "drift").sort((a, b) => a.at.getTime() - b.at.getTime());
    return drift.length ? `Les réglages techniques de l'adresse ont changé le ${frDay(drift[0]!.at)}.` : "Réglages techniques de l'adresse inchangés.";
  };
  if (domain) {
    domainLines = [domainUntil ? `Nom de domaine réservé jusqu'au ${frDayYear(domainUntil)}.` : "La date de fin de réservation du nom de domaine n'a pas pu être lue."];
    if (dnsChecks.length) domainLines.push(driftLine());
  } else if (dnsChecks.length) {
    domainLines = [driftLine()];
  }

  // Vitesse.
  const speedDetail = parse<{ lcpMs: number | null; cls: number | null; available?: boolean }>(speed);
  const prevDetail = parse<{ lcpMs: number | null }>(prevSpeed);
  const speedView =
    speedDetail && speedDetail.available !== false && speedDetail.lcpMs !== null
      ? {
          verdict: speedVerdict(speedDetail.lcpMs, speedDetail.cls),
          seconds: frSeconds(speedDetail.lcpMs),
          comparison: speedComparison(speedDetail.lcpMs, prevDetail?.lcpMs ?? null, prevStart),
          stability: stabilityText(speedDetail.cls),
        }
      : null;

  const { state, reasons } = reportState({
    uptime: uptimeValue,
    incidents: incidents.length,
    openIncident: open !== null,
    certificateProblem: certProblem,
    certificateDaysLeft: certDays,
    domainDaysLeft: domainDays,
    speed: speedView?.verdict ?? null,
  });

  // Chiffres clés : comptes tirés des données, valeurs à zéro masquées.
  const availabilityChecks = hourly.reduce((s, h) => s + h.checks, 0);
  const figures = [
    { n: availabilityChecks, label: availabilityChecks > 1 ? "vérifications d'ouverture" : "vérification d'ouverture" },
    { n: tlsCount, label: tlsCount > 1 ? "contrôles du cadenas" : "contrôle du cadenas" },
    { n: domainCount, label: domainCount > 1 ? "contrôles du nom de domaine" : "contrôle du nom de domaine" },
    { n: speedCount, label: speedCount > 1 ? "mesures de vitesse" : "mesure de vitesse" },
    { n: incidents.length, label: incidents.length > 1 ? "coupures suivies" : "coupure suivie" },
    { n: alerts, label: alerts > 1 ? "alertes reçues par Kouzia" : "alerte reçue par Kouzia" },
  ]
    .filter((f) => f.n > 0)
    .map((f) => ({ value: count(f.n), label: f.label }));

  const settings = ctx.settings ?? null;
  const contact = [settings?.email, settings?.phone ? frPhone(settings.phone) : null, settings?.website ? frWebsite(settings.website) : null].filter((v): v is string => Boolean(v));
  const lastDate = new Date(end.getTime() - 1);

  return {
    clientName: ctx.clientName || target.label || target.hostname,
    hostname: target.hostname,
    period: `du 1er au ${frDayYear(lastDate)}`,
    generatedOn: frDayYear(new Date(now)),
    state,
    stateLabel: STATE_LABEL[state],
    verdict: verdictSentence({ state, reasons, uptime: uptimeValue, incidents: incidents.length, openSince: open?.startedAt ?? null, certificateUntil: certUntil, domainUntil }),
    uptime: uptimeValue === null ? null : frPercent(uptimeValue),
    availabilityNote:
      uptimeValue === null
        ? "Pas encore de mesure ce mois-ci."
        : incidents.length === 0
          ? "Aucune coupure ce mois-ci."
          : `${plural(incidents.length, "coupure", "coupures")}, ${frShortDuration(downMs)} au total.`,
    days,
    incidentsSummary,
    incidentRows,
    incidentsRest,
    certificate,
    domain: domainLines,
    speed: speedView,
    figures,
    footer: { preparedBy: `Rapport préparé par ${settings?.displayName || "Kouzia"}`, contact },
  };
}

// --- Rendu ---

/**
 * Couleurs d'impression, tirées de la charte des documents de l'ERP (encre nuit, ambre, vert « réglé » des
 * factures payées). Contrastes vérifiés par un test, en couleur et en niveaux de gris : texte 4,5:1 au
 * moins sur chaque fond, marques d'état de luminances nettement différentes ; `edge` borde la marque
 * quand sa propre couleur ne se détache pas assez du fond (ambre sur crème).
 */
export const REPORT_COLORS = {
  paper: "#ffffff",
  ink: "#0b1020",
  text: "#1f2433",
  muted: "#4b5367",
  soft: "#f5f6fa",
  line: "#e3e6ee",
  accent: "#fe9a00",
  ok: { tint: "#f0fdf4", mark: "#15803d", glyph: "#ffffff", edge: "#15803d" },
  watch: { tint: "#fff7e6", mark: "#fe9a00", glyph: "#0b1020", edge: "#0b1020" },
  resolved: { tint: "#f5f6fa", mark: "#0b1020", glyph: "#fe9a00", edge: "#0b1020" },
  bar: { ok: "#15803d", incident: "#0b1020", nodata: "#7a8194" },
} as const;

const C = REPORT_COLORS;

/** Forme de chaque barre de la frise : jamais la couleur seule (hauteur, plein ou contour, repère). */
export function dayMark(status: DayStatus): { filled: boolean; heightRatio: number; marker: boolean; color: string } {
  if (status === "incident") return { filled: true, heightRatio: 1, marker: true, color: C.bar.incident };
  if (status === "ok") return { filled: true, heightRatio: 1, marker: false, color: C.bar.ok };
  return { filled: false, heightRatio: 0.45, marker: false, color: C.bar.nodata };
}

const t = (text: string) => frenchTypography(text);
const tTitle = (text: string) => frenchTypography(text, { narrow: false, superscript: false });

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 56, paddingHorizontal: 38, fontFamily: TEXT_FONT, fontSize: 11, color: C.text, backgroundColor: C.paper },
  band: { position: "absolute", top: 0, left: 0, right: 0, height: 5, backgroundColor: C.accent },
  header: { flexDirection: "row", alignItems: "flex-end", paddingBottom: 14, marginBottom: 18, borderBottomWidth: 1, borderBottomColor: C.line, gap: 12 },
  kind: { fontFamily: TITLE_FONT, fontWeight: 600, fontSize: 9.5, color: C.muted },
  client: { fontFamily: TITLE_FONT, fontWeight: 700, fontSize: 20, color: C.ink, lineHeight: 1.15, marginTop: 2 },
  sub: { fontSize: 10.5, color: C.muted, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  tile: { backgroundColor: C.soft, borderRadius: 8, padding: 16 },
  tileDense: { padding: 12 },
  full: { width: "100%" },
  third: { flexGrow: 1, flexBasis: 0 },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  tileTitle: { fontFamily: TITLE_FONT, fontWeight: 600, fontSize: 12, color: C.ink },
  big: { fontFamily: TEXT_FONT, fontWeight: 600, fontSize: 26, color: C.ink, lineHeight: 1.1 },
  body: { fontSize: 11, lineHeight: 1.45, color: C.text },
  note: { fontSize: 10, lineHeight: 1.45, color: C.muted, marginTop: 4 },
  stateWord: { fontFamily: TITLE_FONT, fontWeight: 700, fontSize: 20, color: C.ink },
  verdict: { fontSize: 14, lineHeight: 1.4, marginTop: 4, color: C.ink },
  th: { fontWeight: 600, fontSize: 10, color: C.muted, paddingVertical: 5 },
  td: { fontSize: 11, paddingVertical: 5, color: C.text },
  row: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.line },
  figure: { flexGrow: 1, flexBasis: 0, minWidth: 80 },
  figureValue: { fontWeight: 600, fontSize: 22, color: C.ink },
  figureLabel: { fontSize: 10, lineHeight: 1.3, color: C.muted, marginTop: 2 },
  legend: { flexDirection: "row", gap: 12, marginTop: 6, alignItems: "center" },
  legendItem: { flexDirection: "row", gap: 4, alignItems: "center", fontSize: 9, color: C.muted },
  footer: { position: "absolute", bottom: 22, left: 38, right: 38, flexDirection: "row", fontSize: 8.5, color: C.muted, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6 },
});

function StateIcon({ state }: { state: ReportState }) {
  const k = C[state];
  return (
    <Svg width={40} height={40} viewBox="0 0 24 24">
      {state === "watch" ? (
        <>
          <Path d="M12 2.2 L22.8 21.2 H1.2 Z" fill={k.mark} stroke={k.edge} strokeWidth={1.2} />
          <Rect x={10.9} y={8.6} width={2.2} height={7} fill={k.glyph} />
          <Circle cx={12} cy={18.2} r={1.3} fill={k.glyph} />
        </>
      ) : (
        <>
          <Circle cx={12} cy={12} r={11} fill={k.mark} />
          {state === "ok" ? (
            <Path d="M6.5 12.5 L10.5 16.5 L17.5 8" stroke={k.glyph} strokeWidth={2.6} fill="none" />
          ) : (
            <>
              <Path d="M16.8 8.2 A6 6 0 1 0 18 12.5" stroke={k.glyph} strokeWidth={2.2} fill="none" />
              <Polygon points="14.8,5.6 19.6,6.4 17.6,10.6" fill={k.glyph} />
            </>
          )}
        </>
      )}
    </Svg>
  );
}

/** Icônes des tuiles, dessinées en vectoriel (traits sombres sur fond clair). */
function TileIcon({ kind }: { kind: "lock" | "globe" | "gauge" | "clock" | "pulse" | "check" }) {
  const stroke = C.ink;
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24">
      {kind === "lock" ? (
        <>
          <Rect x={5} y={11} width={14} height={10} rx={2} fill={stroke} />
          <Path d="M8 11 V8 A4 4 0 0 1 16 8 V11" stroke={stroke} strokeWidth={2.2} fill="none" />
        </>
      ) : kind === "globe" ? (
        <>
          <Circle cx={12} cy={12} r={9} stroke={stroke} strokeWidth={2} fill="none" />
          <Path d="M3 12 H21 M12 3 C8 7 8 17 12 21 C16 17 16 7 12 3" stroke={stroke} strokeWidth={1.8} fill="none" />
        </>
      ) : kind === "gauge" ? (
        <>
          <Path d="M3.5 17 A9 9 0 1 1 20.5 17" stroke={stroke} strokeWidth={2.2} fill="none" />
          <Line x1={12} y1={15} x2={16.5} y2={9} stroke={stroke} strokeWidth={2.2} />
          <Circle cx={12} cy={15} r={1.8} fill={stroke} />
        </>
      ) : kind === "clock" ? (
        <>
          <Circle cx={12} cy={12} r={9} stroke={stroke} strokeWidth={2} fill="none" />
          <Path d="M12 7 V12 L15.5 14" stroke={stroke} strokeWidth={2} fill="none" />
        </>
      ) : kind === "pulse" ? (
        <Path d="M2 12 H7 L9.5 6 L13.5 18 L16 12 H22" stroke={stroke} strokeWidth={2.2} fill="none" />
      ) : (
        <>
          <Circle cx={12} cy={12} r={9} stroke={stroke} strokeWidth={2} fill="none" />
          <Path d="M7.5 12.5 L10.5 15.5 L16.5 9" stroke={stroke} strokeWidth={2.2} fill="none" />
        </>
      )}
    </Svg>
  );
}

function Logo() {
  return (
    <Svg width={30} height={30} viewBox="0 0 32 32">
      <Rect width={32} height={32} rx={6} fill={C.ink} />
      <Path d="M10 7v18M10 17l9-10M13 14l7 11" stroke={C.accent} strokeWidth={3} fill="none" />
    </Svg>
  );
}

/** Frise du mois : une barre par jour, forme différente pour un jour à coupure et un jour sans donnée. */
function Timeline({ days, height }: { days: DayStatus[]; height: number }) {
  const W = 330;
  const H = height;
  const gap = 2;
  const barW = (W - gap * (days.length - 1)) / days.length;
  const barTop = 9;
  const barH = H - barTop;
  return (
    <Svg width={W} height={H + 12} viewBox={`0 0 ${W} ${H + 12}`}>
      {days.map((d, n) => {
        const m = dayMark(d);
        const x = n * (barW + gap);
        const h = barH * m.heightRatio;
        const y = barTop + barH - h;
        return (
          <View key={n}>
            {m.filled ? (
              <Rect x={x} y={y} width={barW} height={h} rx={1.2} fill={m.color} />
            ) : (
              <Rect x={x + 0.5} y={y + 0.5} width={barW - 1} height={h - 1} rx={1.2} fill="none" stroke={m.color} strokeWidth={1} />
            )}
            {m.marker ? <Polygon points={`${x + barW / 2},${barTop - 1.5} ${x},${barTop - 8.5} ${x + barW},${barTop - 8.5}`} fill={C.bar.incident} /> : null}
          </View>
        );
      })}
      {[0, 9, 19, days.length - 1].map((n) => (
        <Text key={n} x={n * (barW + gap) + barW / 2} y={H + 10} textAnchor="middle" style={{ fontSize: 7.5, fill: C.muted, fontFamily: TEXT_FONT }}>
          {String(n + 1)}
        </Text>
      ))}
    </Svg>
  );
}

function LegendSwatch({ status }: { status: DayStatus }) {
  const m = dayMark(status);
  return (
    <Svg width={18} height={14} viewBox="0 0 18 14">
      {m.filled ? <Rect x={5} y={4} width={7} height={10} rx={1} fill={m.color} /> : <Rect x={5.5} y={8.5} width={6} height={5} rx={1} fill="none" stroke={m.color} strokeWidth={1} />}
      {m.marker ? <Polygon points="8.5,3.5 5,0 12,0" fill={C.bar.incident} /> : null}
    </Svg>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((l, n) => (
        <Text key={n} style={n === 0 ? s.body : s.note}>
          {t(l)}
        </Text>
      ))}
    </>
  );
}

function ReportDocument({ v }: { v: ReportView }) {
  const hasNoData = v.days.includes("nodata");
  const hasIncidentDay = v.days.includes("incident");
  // Mois avec coupures : le tableau prend de la place, les marges se resserrent pour tenir sur une page.
  const dense = v.incidentRows.length > 0;
  return (
    <Document title={`Surveillance de ${v.hostname}, ${v.period}`} author="Kouzia" creator="Kouzia" producer="Kouzia" language="fr">
      <Page size="A4" style={[s.page, dense ? { paddingTop: 28 } : {}]}>
        <View style={s.band} fixed />
        <View style={[s.header, dense ? { paddingBottom: 10, marginBottom: 12 } : {}]}>
          <Logo />
          <View style={{ flex: 1 }}>
            <Text style={s.kind}>Rapport de surveillance du site</Text>
            <Text style={s.client}>{tTitle(v.clientName)}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[s.body, { fontWeight: 600, color: C.ink }]}>{v.hostname}</Text>
            <Text style={s.sub}>{t(v.period)}</Text>
          </View>
        </View>

        <View style={[s.grid, dense ? { gap: 10 } : {}]}>
          <View style={[s.tile, dense ? s.tileDense : {}, s.full, { backgroundColor: C[v.state].tint, borderLeftWidth: 4, borderLeftColor: C[v.state].edge }]} wrap={false}>
            <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <StateIcon state={v.state} />
              <View style={{ flex: 1 }}>
                <Text style={s.stateWord}>{tTitle(v.stateLabel)}</Text>
                <Text style={s.verdict}>{t(v.verdict)}</Text>
              </View>
            </View>
          </View>

          <View style={[s.tile, dense ? s.tileDense : {}, s.full]} wrap={false}>
            <View style={s.tileHead}>
              <TileIcon kind="pulse" />
              <Text style={s.tileTitle}>Disponibilité, jour par jour</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
              <View style={{ width: 150 }}>
                <Text style={s.big}>{v.uptime === null ? "En attente" : t(`${v.uptime} %`)}</Text>
                <Text style={s.note}>{t(`du temps, le site était accessible. ${v.availabilityNote}`)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Timeline days={v.days} height={dense ? 40 : 52} />
                <View style={s.legend}>
                  <View style={s.legendItem}>
                    <LegendSwatch status="ok" />
                    <Text>Accessible toute la journée</Text>
                  </View>
                  {hasIncidentDay ? (
                    <View style={s.legendItem}>
                      <LegendSwatch status="incident" />
                      <Text>Jour avec coupure (repère au-dessus)</Text>
                    </View>
                  ) : null}
                  {hasNoData ? (
                    <View style={s.legendItem}>
                      <LegendSwatch status="nodata" />
                      <Text>Pas de mesure</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </View>

          <View style={[s.tile, dense ? s.tileDense : {}, s.third]} wrap={false}>
            <View style={s.tileHead}>
              <TileIcon kind="gauge" />
              <Text style={s.tileTitle}>Vitesse</Text>
            </View>
            {v.speed ? (
              <>
                <Text style={[s.big, { fontSize: 20 }]}>{tTitle(v.speed.verdict)}</Text>
                <Text style={s.note}>{t(`La page s'ouvre en ${v.speed.seconds} s sur téléphone. ${v.speed.comparison}`)}</Text>
                {v.speed.stability ? <Text style={s.note}>{t(v.speed.stability)}</Text> : null}
              </>
            ) : (
              <Text style={s.body}>Pas encore de mesure ce mois-ci.</Text>
            )}
          </View>
          <View style={[s.tile, dense ? s.tileDense : {}, s.third]} wrap={false}>
            <View style={s.tileHead}>
              <TileIcon kind="lock" />
              <Text style={s.tileTitle}>Sécurité</Text>
            </View>
            {v.certificate ? <Lines lines={v.certificate} /> : <Text style={s.body}>Pas encore de contrôle ce mois-ci.</Text>}
          </View>
          <View style={[s.tile, dense ? s.tileDense : {}, s.third]} wrap={false}>
            <View style={s.tileHead}>
              <TileIcon kind="globe" />
              <Text style={s.tileTitle}>Nom de domaine</Text>
            </View>
            {v.domain ? <Lines lines={v.domain} /> : <Text style={s.body}>Pas encore de contrôle ce mois-ci.</Text>}
          </View>

          <View style={[s.tile, dense ? s.tileDense : {}, s.full]}>
            <View style={s.tileHead} wrap={false}>
              <TileIcon kind="clock" />
              <Text style={s.tileTitle}>Coupures</Text>
            </View>
            {v.incidentsSummary ? (
              <>
                <Text style={[s.body, { marginBottom: 6 }]}>{t(v.incidentsSummary)}</Text>
                <View style={[s.row, { borderTopWidth: 0 }]} wrap={false}>
                  <Text style={[s.th, { width: "36%" }]}>Date</Text>
                  <Text style={[s.th, { width: "40%" }]}>Heures</Text>
                  <Text style={[s.th, { width: "24%", textAlign: "right" }]}>Durée</Text>
                </View>
                {v.incidentRows.map((r, n) => (
                  <View key={n} style={s.row} wrap={false}>
                    <Text style={[s.td, { width: "36%" }]}>{t(r.date)}</Text>
                    <Text style={[s.td, { width: "40%" }]}>{t(r.hours)}</Text>
                    <Text style={[s.td, { width: "24%", textAlign: "right", fontWeight: r.ongoing ? 600 : 400, color: r.ongoing ? C.ink : C.text }]}>
                      {t(r.duration)}
                    </Text>
                  </View>
                ))}
                {v.incidentsRest ? <Text style={s.note}>{t(v.incidentsRest)}</Text> : null}
              </>
            ) : (
              <Text style={s.body}>{t(v.uptime === null ? "Pas encore de mesure ce mois-ci." : "Aucune coupure : le site a répondu à chaque vérification.")}</Text>
            )}
          </View>

          {v.figures.length ? (
            <View style={[s.tile, dense ? s.tileDense : {}, s.full]} wrap={false}>
              <View style={s.tileHead}>
                <TileIcon kind="check" />
                <Text style={s.tileTitle}>Ce que Kouzia a fait pour vous ce mois-ci</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                {v.figures.map((f, n) => (
                  <View key={n} style={s.figure}>
                    <Text style={s.figureValue}>{t(f.value)}</Text>
                    <Text style={s.figureLabel}>{t(f.label)}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: 600, color: C.text }}>{tTitle(v.footer.preparedBy)}</Text>
            {v.footer.contact.length ? <Text>{t(v.footer.contact.join("   "))}</Text> : null}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text>{t(`Généré le ${v.generatedOn}`)}</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} sur ${totalPages}`} />
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(view: ReportView): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Buffer.from(await renderToBuffer((<ReportDocument v={view} />) as any));
}

/** Nombre de pages d'un PDF produit par react-pdf. */
export const pdfPageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** Génère (ou régénère) le rapport d'une cible pour un mois et l'enregistre. */
export async function generateReport(
  dataDir: string,
  target: MonitorTarget,
  month: string,
  now = Date.now(),
  ctx: ReportContext = {},
): Promise<{ path: string; buffer: Buffer }> {
  const buffer = await renderReportPdf(await buildReportView(target, month, now, ctx));
  const rel = path.posix.join("reports", target.id, `${month}.pdf`);
  await mkdir(path.join(dataDir, "reports", target.id), { recursive: true });
  await writeFile(path.join(dataDir, rel), buffer);
  await prisma.monitorReport.upsert({
    where: { targetId_month: { targetId: target.id, month } },
    create: { targetId: target.id, month, path: rel },
    update: { path: rel, createdAt: new Date(now) },
  });
  return { path: rel, buffer };
}
