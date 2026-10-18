import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Circle, Document, Font, Page, Path, Rect, StyleSheet, Svg, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { MonitorCheck, MonitorTarget } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { availability } from "@/lib/monitor/view.js";
import {
  INCIDENTS_DETAILED,
  PARIS,
  STATE_LABEL,
  frDay,
  frDayYear,
  frDuration,
  frMonthYear,
  frPercent,
  frSeconds,
  incidentSentence,
  reportState,
  speedComparison,
  speedVerdict,
  stabilityText,
  summarizeShortIncidents,
  verdictSentence,
  type ReportState,
  type SpeedVerdict,
} from "@/lib/monitor/report-text.js";

// Rapport mensuel envoyé au client (cadrage 10.7) : une page A4 (deux au plus), langage clair, aucun
// terme technique. Le détail technique reste dans le hub, pour Alexandre ; il n'est pas joint au PDF.
// Police : Helvetica (police standard du PDF, comme les documents de l'ERP) ; l'Exo 2 du hub, en woff2
// variable, n'est pas lisible par le moteur de react-pdf. Jeu de caractères WinAnsi.
Font.registerHyphenationCallback((word) => [word]);

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const DAY_MS = 86_400_000;

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

/** Minuit à Paris le 1er du mois (index 0 à 11, débordement accepté). */
function parisMonthStart(year: number, monthIndex: number): Date {
  const guess = Date.UTC(year, monthIndex, 1);
  const first = guess - parisOffset(guess);
  return new Date(guess - parisOffset(first));
}

/** Début et fin du mois, au fuseau de Paris. */
export function monthBounds(month: string): { start: Date; end: Date } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error("mois invalide");
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { start: parisMonthStart(year, index), end: parisMonthStart(year, index + 1) };
}

const parse = <T,>(c: Pick<MonitorCheck, "detail"> | null | undefined): T | null => {
  if (!c?.detail) return null;
  try {
    return JSON.parse(c.detail) as T;
  } catch {
    return null;
  }
};

/** Contenu du rapport, déjà rédigé : le rendu ne fait que le placer. */
export type ReportView = {
  hostname: string;
  monthLabel: string;
  state: ReportState;
  stateLabel: string;
  verdict: string;
  /** « 99,9 » ou null sans mesure. */
  uptime: string | null;
  availabilityNote: string;
  incidents: { lines: string[]; summary: string | null };
  certificate: string[] | null;
  domain: string[] | null;
  speed: { verdict: SpeedVerdict; seconds: string; comparison: string; stability: string | null } | null;
  /** Faits du mois, chiffres tirés des données (lignes à zéro masquées). */
  kouzia: string[];
};

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("fr-FR").replace(/[  ]/g, " ")} ${n > 1 ? many : one}`;

/** Données du mois d'une cible, rédigées en langage clair (fonction testée à part du rendu). */
export async function buildReportView(target: MonitorTarget, month: string, now = Date.now()): Promise<ReportView> {
  const { start, end } = monthBounds(month);
  const to = Math.min(end.getTime(), now);
  const inMonth = { gte: start, lt: end };
  const prevStart = parisMonthStart(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2);

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

  // « Revenu tout seul » : seulement si le site est connu du hub et qu'aucune action n'y a été faite pendant la coupure.
  const recovered = await Promise.all(
    incidents.map(async (i) => {
      if (!i.endedAt || !target.siteId) return null;
      const actions = await prisma.auditEvent.count({
        where: { siteId: target.siteId, at: { gte: i.startedAt, lte: i.endedAt }, NOT: { action: { startsWith: "auth." } } },
      });
      return actions === 0;
    }),
  );

  // Coupures : les plus longues en phrases, les plus courtes résumées au-delà de INCIDENTS_DETAILED.
  const withDuration = incidents.map((i, n) => ({ i, n, ms: (i.endedAt?.getTime() ?? to) - i.startedAt.getTime() }));
  const detailed = [...withDuration].sort((a, b) => b.ms - a.ms).slice(0, INCIDENTS_DETAILED).sort((a, b) => a.i.startedAt.getTime() - b.i.startedAt.getTime());
  const rest = withDuration.filter((x) => !detailed.includes(x));
  const lines = detailed.map((x) => incidentSentence({ startedAt: x.i.startedAt, endedAt: x.i.endedAt, selfRecovered: recovered[x.n] ?? null }, to));
  const summary = rest.length ? summarizeShortIncidents(rest.length, rest.reduce((s, x) => s + x.ms, 0), Math.max(...rest.map((x) => x.ms))) : null;
  const downMs = withDuration.reduce((s, x) => s + Math.min(x.i.endedAt?.getTime() ?? to, to) - Math.max(x.i.startedAt.getTime(), start.getTime()), 0);

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
      certificate = [`Certificat de sécurité (le cadenas) valable jusqu'au ${frDayYear(certUntil)}.`, "Kouzia est prévenu 30 jours avant cette date."];
    }
  }

  const domainDetail = parse<{ expiresAt: string | null }>(domain);
  const domainUntil = domainDetail?.expiresAt ? new Date(domainDetail.expiresAt) : null;
  const domainDays = domainUntil ? Math.floor((domainUntil.getTime() - to) / DAY_MS) : null;
  let domainLines: string[] | null = null;
  if (domain) {
    domainLines = [domainUntil ? `Nom de domaine réservé jusqu'au ${frDayYear(domainUntil)}.` : "La date de fin de réservation du nom de domaine n'a pas pu être lue."];
    if (dnsChecks.length) {
      const drift = dnsChecks.filter((c) => parse<{ status: string }>(c)?.status === "drift").sort((a, b) => a.at.getTime() - b.at.getTime());
      domainLines.push(drift.length ? `Les réglages techniques de l'adresse ont changé le ${frDay(drift[0]!.at)}.` : "Réglages techniques de l'adresse inchangés.");
    }
  } else if (dnsChecks.length) {
    domainLines = ["Réglages techniques de l'adresse inchangés."];
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

  // Ce que Kouzia a fait : seulement des comptes tirés des données, lignes à zéro masquées.
  const availabilityChecks = hourly.reduce((s, h) => s + h.checks, 0);
  const kouzia = [
    availabilityChecks ? `${plural(availabilityChecks, "vérification", "vérifications")} que le site s'ouvre, de jour comme de nuit.` : null,
    tlsCount ? `${plural(tlsCount, "vérification", "vérifications")} du cadenas de sécurité.` : null,
    domainCount ? `${plural(domainCount, "vérification", "vérifications")} du nom de domaine.` : null,
    dnsChecks.length ? `${plural(dnsChecks.length, "vérification", "vérifications")} des réglages de l'adresse.` : null,
    speedCount ? `${plural(speedCount, "mesure", "mesures")} de la vitesse d'ouverture.` : null,
    incidents.length ? `${plural(incidents.length, "coupure détectée et suivie", "coupures détectées et suivies")}.` : null,
    alerts ? `${plural(alerts, "alerte reçue", "alertes reçues")} par Kouzia (échéances ou changements de réglages).` : null,
  ].filter((l): l is string => l !== null);

  return {
    hostname: target.hostname,
    monthLabel: frMonthYear(start),
    state,
    stateLabel: STATE_LABEL[state],
    verdict: verdictSentence({ state, reasons, uptime: uptimeValue, incidents: incidents.length, openSince: open?.startedAt ?? null, certificateUntil: certUntil, domainUntil }),
    uptime: uptimeValue === null ? null : frPercent(uptimeValue),
    availabilityNote:
      uptimeValue === null
        ? "Pas encore de mesure ce mois-ci."
        : incidents.length === 0
          ? "Aucune coupure ce mois-ci."
          : `${plural(incidents.length, "coupure", "coupures")}, ${frDuration(downMs)} au total.`,
    incidents: { lines, summary },
    certificate,
    domain: domainLines,
    speed: speedView,
    kouzia,
  };
}

// --- Rendu : grille « bento » sur une page A4 ---

/** Couleurs d'impression : fond clair, encre sombre (contrastes vérifiés par un test, 4,5:1 au moins). */
export const REPORT_COLORS = {
  paper: "#ffffff",
  ink: "#0b1020",
  muted: "#4b5367",
  tile: "#f4f5f8",
  line: "#d9dce4",
  accent: "#fe9a00",
  ok: { tint: "#e6f4eb", mark: "#1d7a44" },
  watch: { tint: "#fff1db", mark: "#9a5600" },
  resolved: { tint: "#e7effc", mark: "#1f5bb8" },
} as const;

const C = REPORT_COLORS;

const s = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 40, paddingHorizontal: 34, fontFamily: "Helvetica", fontSize: 10, color: C.ink, backgroundColor: C.paper },
  band: { position: "absolute", top: 0, left: 0, right: 0, height: 5, backgroundColor: C.accent },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 14, gap: 10 },
  brand: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  headerRight: { marginLeft: "auto", alignItems: "flex-end" },
  kind: { fontSize: 9, fontFamily: "Helvetica-Bold", color: C.muted },
  site: { fontSize: 13, fontFamily: "Helvetica-Bold", marginTop: 2 },
  month: { fontSize: 10, color: C.muted, marginTop: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { backgroundColor: C.tile, borderRadius: 8, padding: 12 },
  full: { width: "100%" },
  half: { width: "48.9%" },
  third: { width: "31.9%" },
  twoThirds: { width: "65.9%" },
  tileTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", color: C.muted, marginBottom: 6 },
  big: { fontSize: 28, fontFamily: "Helvetica-Bold", lineHeight: 1.1 },
  body: { fontSize: 10, lineHeight: 1.45 },
  note: { fontSize: 9, color: C.muted, lineHeight: 1.4, marginTop: 3 },
  verdictRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stateWord: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  verdict: { fontSize: 12.5, lineHeight: 1.4, marginTop: 3 },
  bullet: { flexDirection: "row", gap: 6, marginTop: 3 },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.muted, marginTop: 5 },
  footer: { position: "absolute", bottom: 18, left: 34, right: 34, flexDirection: "row", fontSize: 7.5, color: C.muted },
});

function StateIcon({ state }: { state: ReportState }) {
  const color = C[state].mark;
  return (
    <Svg width={34} height={34} viewBox="0 0 24 24">
      {state === "watch" ? (
        <>
          <Path d="M12 2.5 L22.5 21 H1.5 Z" fill={color} />
          <Rect x={11} y={8.5} width={2} height={7} fill={C.paper} />
          <Circle cx={12} cy={18} r={1.2} fill={C.paper} />
        </>
      ) : (
        <>
          <Circle cx={12} cy={12} r={11} fill={color} />
          {state === "ok" ? (
            <Path d="M6.5 12.5 L10.5 16.5 L17.5 8" stroke={C.paper} strokeWidth={2.4} fill="none" />
          ) : (
            <Path d="M12 6 A6 6 0 1 1 6.3 10.2 M6 5.5 L6.3 10.2 L10.8 9.6" stroke={C.paper} strokeWidth={2.2} fill="none" />
          )}
        </>
      )}
    </Svg>
  );
}

function Logo() {
  return (
    <Svg width={22} height={22} viewBox="0 0 32 32">
      <Rect width={32} height={32} rx={6} fill={C.ink} />
      <Path d="M10 7v18M10 17l9-10M13 14l7 11" stroke={C.accent} strokeWidth={3} fill="none" />
    </Svg>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((l, n) => (
        <Text key={n} style={n === 0 ? s.body : s.note}>
          {l}
        </Text>
      ))}
    </>
  );
}

function Bullets({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((l, n) => (
        <View key={n} style={s.bullet} wrap={false}>
          <View style={s.dot} />
          <Text style={[s.body, { flex: 1 }]}>{l}</Text>
        </View>
      ))}
    </>
  );
}

function ReportDocument({ v }: { v: ReportView }) {
  const tint = C[v.state].tint;
  const hasIncidents = v.incidents.lines.length > 0;
  return (
    <Document title={`Surveillance de ${v.hostname}, ${v.monthLabel}`} author="Kouzia" creator="Kouzia" producer="Kouzia" language="fr">
      <Page size="A4" style={s.page}>
        <View style={s.band} fixed />
        <View style={s.header}>
          <Logo />
          <Text style={s.brand}>Kouzia</Text>
          <View style={s.headerRight}>
            <Text style={s.kind}>Rapport de surveillance</Text>
            <Text style={s.site}>{v.hostname}</Text>
            <Text style={s.month}>{v.monthLabel}</Text>
          </View>
        </View>

        <View style={s.grid}>
          <View style={[s.tile, s.full, { backgroundColor: tint }]} wrap={false}>
            <View style={s.verdictRow}>
              <StateIcon state={v.state} />
              <View style={{ flex: 1 }}>
                <Text style={s.stateWord}>{v.stateLabel}</Text>
                <Text style={s.verdict}>{v.verdict}</Text>
              </View>
            </View>
          </View>

          <View style={[s.tile, s.third]} wrap={false}>
            <Text style={s.tileTitle}>Accessible</Text>
            <Text style={s.big}>{v.uptime === null ? "En attente" : `${v.uptime} %`}</Text>
            <Text style={s.note}>du temps. {v.availabilityNote}</Text>
          </View>

          {v.speed ? (
            <View style={[s.tile, s.twoThirds]} wrap={false}>
              <Text style={s.tileTitle}>Vitesse</Text>
              <Text style={s.big}>{v.speed.verdict}</Text>
              <Text style={s.note}>
                Temps d'ouverture de la page : {v.speed.seconds} s sur téléphone. {v.speed.comparison}
              </Text>
              {v.speed.stability ? <Text style={s.note}>{v.speed.stability}</Text> : null}
            </View>
          ) : (
            <View style={[s.tile, s.twoThirds]} wrap={false}>
              <Text style={s.tileTitle}>Vitesse</Text>
              <Text style={s.body}>Pas encore de mesure de vitesse ce mois-ci.</Text>
            </View>
          )}

          {v.certificate ? (
            <View style={[s.tile, v.domain ? s.half : s.full]} wrap={false}>
              <Text style={s.tileTitle}>Sécurité</Text>
              <Lines lines={v.certificate} />
            </View>
          ) : null}
          {v.domain ? (
            <View style={[s.tile, v.certificate ? s.half : s.full]} wrap={false}>
              <Text style={s.tileTitle}>Nom de domaine</Text>
              <Lines lines={v.domain} />
            </View>
          ) : null}

          <View style={[s.tile, s.full]}>
            <Text style={s.tileTitle}>Coupures</Text>
            {hasIncidents ? (
              <>
                <Bullets lines={v.incidents.lines} />
                {v.incidents.summary ? <Text style={s.note}>{v.incidents.summary}</Text> : null}
              </>
            ) : (
              <Text style={s.body}>{v.uptime === null ? "Pas encore de mesure ce mois-ci." : "Aucune coupure : le site a répondu à chaque vérification."}</Text>
            )}
          </View>

          {v.kouzia.length ? (
            <View style={[s.tile, s.full]} wrap={false}>
              <Text style={s.tileTitle}>Ce que Kouzia a fait pour vous ce mois-ci</Text>
              <Bullets lines={v.kouzia} />
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <Text>Surveillance des pages publiques du site par Kouzia, depuis son serveur et depuis Cloudflare. Heures de Paris.</Text>
          <Text style={{ marginLeft: "auto" }} render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} sur ${totalPages}` : "")} />
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
export async function generateReport(dataDir: string, target: MonitorTarget, month: string, now = Date.now()): Promise<{ path: string; buffer: Buffer }> {
  const buffer = await renderReportPdf(await buildReportView(target, month, now));
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

