import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { MonitorCheck, MonitorTarget } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { availability } from "@/lib/monitor/view.js";

// Polices standard du PDF (Helvetica, comme les PDF de l'ERP) : l'Exo 2 du hub, en woff2 variable,
// n'est pas lisible par le moteur de react-pdf. Encodage WinAnsi : pas de caractère hors de ce jeu.
Font.registerHyphenationCallback((word) => [word]);

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type ReportData = {
  label: string;
  url: string;
  month: string;
  monthLabel: string;
  /** Disponibilité au sens de la règle de décision, null sans contrôle dans le mois. */
  uptime: number | null;
  /** Taux de réussite vu par chaque point de contrôle (agrégats horaires). */
  hubRate: number | null;
  edgeRate: number | null;
  incidents: Array<{ start: string; end: string | null; duration: string; cause: string | null }>;
  certificate: { issuer: string | null; validTo: string | null; ok: boolean; error: string | null } | null;
  domainExpiry: { expiresAt: string | null; registrar: string | null } | null;
  speed: { last: { date: string; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null } | null; previousLcpMs: number | null; available: boolean };
  dns: { checks: number; drifts: string[] };
  content: { checks: number; changes: string[] };
};

const frDate = (d: Date | string) => new Date(d).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
const frDateTime = (d: Date) =>
  `${frDate(d)} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;

export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function monthBounds(month: string): { start: Date; end: Date } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error("mois invalide");
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { start: new Date(year, index, 1), end: new Date(year, index + 1, 1) };
}

const parse = <T,>(c: MonitorCheck | null | undefined): T | null => {
  if (!c?.detail) return null;
  try {
    return JSON.parse(c.detail) as T;
  } catch {
    return null;
  }
};

/** Chiffres du rapport d'une cible pour un mois (fonction testée à part du rendu). */
export async function buildReportData(target: MonitorTarget, month: string, now = Date.now()): Promise<ReportData> {
  const { start, end } = monthBounds(month);
  const to = Math.min(end.getTime(), now);
  const inMonth = { gte: start, lt: end };
  const [incidents, firstHttp, hourly, tls, domain, speeds, dnsChecks, contentChecks] = await Promise.all([
    prisma.monitorIncident.findMany({
      where: { targetId: target.id, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
      orderBy: { startedAt: "asc" },
    }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "http" }, orderBy: { at: "asc" }, select: { at: true } }),
    prisma.monitorHourly.findMany({ where: { targetId: target.id, hour: inMonth } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "tls", at: { lt: end } }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.findFirst({ where: { targetId: target.id, kind: "domain", at: { lt: end } }, orderBy: { at: "desc" } }),
    prisma.monitorCheck.findMany({ where: { targetId: target.id, kind: "speed", at: { lt: end } }, orderBy: { at: "desc" }, take: 2 }),
    prisma.monitorCheck.findMany({ where: { targetId: target.id, kind: "dns", at: inMonth }, orderBy: { at: "asc" } }),
    prisma.monitorCheck.findMany({ where: { targetId: target.id, kind: "content", at: inMonth }, orderBy: { at: "asc" } }),
  ]);
  // Les heures agrégées et le premier contrôle HTTP fixent le début de l'observation.
  const firstSeen = Math.min(firstHttp?.at.getTime() ?? Infinity, ...hourly.map((h) => h.hour.getTime()));
  const rate = (observer: string) => {
    const rows = hourly.filter((h) => h.observer === observer);
    const checks = rows.reduce((s, h) => s + h.checks, 0);
    return checks ? Math.round((1 - rows.reduce((s, h) => s + h.failures, 0) / checks) * 10_000) / 100 : null;
  };
  const tlsDetail = parse<{ issuer: string | null; validTo: string | null; ok: boolean; error: string | null }>(tls);
  const domainDetail = parse<{ expiresAt: string | null; registrar: string | null }>(domain);
  const lastSpeed = parse<{ available?: boolean; ttfbMs: number | null; lcpMs: number | null; cls: number | null; bytes: number | null; requests: number | null }>(speeds[0]);
  const prevSpeed = parse<{ lcpMs: number | null }>(speeds[1]);
  const { monthLabel } = { monthLabel: start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }) };
  return {
    label: target.label,
    url: target.url,
    month,
    monthLabel,
    uptime: availability(incidents, start.getTime(), to, Number.isFinite(firstSeen) ? firstSeen : null),
    hubRate: rate("hub"),
    edgeRate: rate("edge"),
    incidents: incidents.map((i) => ({
      start: frDateTime(i.startedAt),
      end: i.endedAt ? frDateTime(i.endedAt) : null,
      duration: durationLabel(Math.min(i.endedAt?.getTime() ?? to, to) - Math.max(i.startedAt.getTime(), start.getTime())),
      cause: i.cause,
    })),
    certificate: tlsDetail ? { issuer: tlsDetail.issuer, validTo: tlsDetail.validTo, ok: tlsDetail.ok, error: tlsDetail.error } : null,
    domainExpiry: domainDetail ? { expiresAt: domainDetail.expiresAt, registrar: domainDetail.registrar } : null,
    speed: {
      available: lastSpeed?.available !== false && speeds.length > 0,
      last:
        lastSpeed && lastSpeed.available !== false && speeds[0]
          ? { date: frDate(speeds[0].at), ttfbMs: lastSpeed.ttfbMs, lcpMs: lastSpeed.lcpMs, cls: lastSpeed.cls, bytes: lastSpeed.bytes, requests: lastSpeed.requests }
          : null,
      previousLcpMs: prevSpeed?.lcpMs ?? null,
    },
    dns: {
      checks: dnsChecks.length,
      drifts: dnsChecks.filter((c) => parse<{ status: string }>(c)?.status === "drift").map((c) => `${frDate(c.at)} : ${(parse<{ drift?: string[] }>(c)?.drift ?? []).join(", ")}`),
    },
    content: {
      checks: contentChecks.length,
      changes: contentChecks.filter((c) => parse<{ status: string }>(c)?.status === "changed").map((c) => frDate(c.at)),
    },
  };
}

const INK = "#0b1020";
const MUTED = "#5b6478";
const LINE = "#e3e6ee";
const ACCENT = "#f5a524";

const styles = StyleSheet.create({
  page: { paddingTop: 34, paddingBottom: 48, paddingHorizontal: 40, fontSize: 10, fontFamily: "Helvetica", color: INK },
  accent: { position: "absolute", top: 0, left: 0, right: 0, height: 6, backgroundColor: ACCENT },
  kind: { fontSize: 8, fontFamily: "Helvetica-Bold", letterSpacing: 1.5, color: MUTED },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginTop: 4 },
  subtitle: { color: MUTED, marginTop: 2, marginBottom: 18 },
  h2: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6, paddingBottom: 3, borderBottomWidth: 1, borderBottomColor: LINE },
  big: { fontSize: 26, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", gap: 24 },
  cell: { flex: 1 },
  label: { color: MUTED, fontSize: 8.5 },
  value: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 1 },
  line: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: LINE },
  col: { flex: 1 },
  muted: { color: MUTED },
  footer: { position: "absolute", bottom: 22, left: 40, right: 40, fontSize: 7.5, color: MUTED },
});

/**
 * Nombre à la française sans toLocaleString (son espace fine U+202F est hors du jeu WinAnsi de
 * Helvetica) : virgule décimale, milliers séparés par une espace insécable U+00A0.
 */
export function frNumber(value: number, decimals = 0): string {
  const fixed = decimals > 0 ? String(Math.round(value * 10 ** decimals) / 10 ** decimals) : String(Math.round(value));
  const [int, dec] = fixed.split(".");
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")}${dec ? `,${dec}` : ""}`;
}
const pct = (v: number | null) => (v === null ? "non mesurée" : `${frNumber(v, 2)}\u00a0%`);
const ms = (v: number | null) => (v === null ? "non mesuré" : `${frNumber(v)}\u00a0ms`);

function ReportDocument({ data }: { data: ReportData }) {
  const s = data.speed;
  return (
    <Document title={`Surveillance ${data.label} ${data.month}`} author="Kouzia" creator="Hub Kouzia" producer="Hub Kouzia">
      <Page size="A4" style={styles.page}>
        <View style={styles.accent} fixed />
        <Text style={styles.kind}>RAPPORT DE SURVEILLANCE</Text>
        <Text style={styles.title}>{data.label}</Text>
        <Text style={styles.subtitle}>
          {data.url} : {data.monthLabel}
        </Text>

        <Text style={styles.h2}>Disponibilité</Text>
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.big}>{pct(data.uptime)}</Text>
            <Text style={styles.muted}>temps sans panne confirmée par les deux points de contrôle</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.label}>Contrôles réussis depuis le serveur Kouzia</Text>
            <Text style={styles.value}>{pct(data.hubRate)}</Text>
            <Text style={[styles.label, { marginTop: 6 }]}>Contrôles réussis depuis Cloudflare</Text>
            <Text style={styles.value}>{pct(data.edgeRate)}</Text>
          </View>
        </View>

        <Text style={styles.h2}>Incidents</Text>
        {data.incidents.length === 0 ? (
          <Text>Aucune panne sur la période.</Text>
        ) : (
          data.incidents.map((i, n) => (
            <View key={n} style={styles.line}>
              <Text style={styles.col}>Début : {i.start}</Text>
              <Text style={styles.col}>Fin : {i.end ?? "en cours"}</Text>
              <Text style={styles.col}>Durée : {i.duration}</Text>
              <Text style={styles.col}>{i.cause ?? ""}</Text>
            </View>
          ))
        )}

        <Text style={styles.h2}>Certificat et nom de domaine</Text>
        <View style={styles.row}>
          <View style={styles.cell}>
            <Text style={styles.label}>Certificat HTTPS</Text>
            <Text style={styles.value}>
              {data.certificate
                ? data.certificate.ok
                  ? `valide jusqu'au ${data.certificate.validTo ? frDate(data.certificate.validTo) : "?"}`
                  : `invalide : ${data.certificate.error ?? "erreur"}`
                : "non contrôlé"}
            </Text>
            {data.certificate?.issuer ? <Text style={styles.muted}>Émetteur : {data.certificate.issuer}</Text> : null}
          </View>
          <View style={styles.cell}>
            <Text style={styles.label}>Échéance du nom de domaine</Text>
            <Text style={styles.value}>{data.domainExpiry?.expiresAt ? frDate(data.domainExpiry.expiresAt) : "inconnue"}</Text>
            {data.domainExpiry?.registrar ? <Text style={styles.muted}>Bureau d'enregistrement : {data.domainExpiry.registrar}</Text> : null}
          </View>
        </View>

        <Text style={styles.h2}>Vitesse de l'accueil (mobile)</Text>
        {s.last ? (
          <View style={styles.row}>
            <View style={styles.cell}>
              <Text style={styles.label}>Affichage du contenu principal (LCP)</Text>
              <Text style={styles.value}>{ms(s.last.lcpMs)}</Text>
              {s.previousLcpMs !== null && s.last.lcpMs !== null ? (
                <Text style={styles.muted}>mesure précédente : {ms(s.previousLcpMs)}</Text>
              ) : null}
            </View>
            <View style={styles.cell}>
              <Text style={styles.label}>Premier octet (TTFB)</Text>
              <Text style={styles.value}>{ms(s.last.ttfbMs)}</Text>
              <Text style={styles.label}>Stabilité visuelle (CLS)</Text>
              <Text style={styles.value}>{s.last.cls === null ? "non mesurée" : frNumber(s.last.cls, 3)}</Text>
            </View>
            <View style={styles.cell}>
              <Text style={styles.label}>Poids et requêtes</Text>
              <Text style={styles.value}>
                {s.last.bytes === null ? "non mesuré" : `${frNumber(s.last.bytes / 1024)}\u00a0Ko`}, {s.last.requests ?? "?"} requêtes
              </Text>
              <Text style={styles.muted}>mesuré le {s.last.date}</Text>
            </View>
          </View>
        ) : (
          <Text>{s.available ? "Pas encore de mesure." : "Mesure indisponible sur le serveur de surveillance."}</Text>
        )}

        <Text style={styles.h2}>DNS et contenu</Text>
        <Text>
          DNS : {data.dns.checks} contrôle{data.dns.checks > 1 ? "s" : ""},{" "}
          {data.dns.drifts.length === 0 ? "aucun écart avec la référence." : `${data.dns.drifts.length} écart(s) : ${data.dns.drifts.join(" ; ")}.`}
        </Text>
        <Text style={{ marginTop: 4 }}>
          Contenu de l'accueil : {data.content.checks} contrôle{data.content.checks > 1 ? "s" : ""},{" "}
          {data.content.changes.length === 0 ? "aucun changement inattendu." : `changement(s) le ${data.content.changes.join(", ")}.`}
        </Text>

        <Text style={styles.footer} fixed>
          Surveillance technique des pages publiques par Kouzia, depuis son serveur et depuis Cloudflare (sous-traitant).
        </Text>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(data: ReportData): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Buffer.from(await renderToBuffer((<ReportDocument data={data} />) as any));
}

/** Génère (ou régénère) le rapport d'une cible pour un mois et l'enregistre. */
export async function generateReport(dataDir: string, target: MonitorTarget, month: string, now = Date.now()): Promise<{ path: string; buffer: Buffer }> {
  const buffer = await renderReportPdf(await buildReportData(target, month, now));
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
