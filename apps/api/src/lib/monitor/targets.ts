import { contentHash } from "@/lib/monitor/checks.js";
import { prisma } from "@/lib/prisma.js";

export const finalHost = (finalDomain: string, canonicalHost: string) => (canonicalHost === "apex" ? finalDomain : `www.${finalDomain}`);

/**
 * Cibles d'un site tenues à jour depuis son profil : version de travail (<slug>.kouzia.com) et
 * domaine final (forme canonique). Créées actives ; l'interrupteur choisi par Alexandre est gardé.
 * Libellés tirés des noms d'hôte seulement : aucune donnée de client ne part vers le Worker.
 * Renvoie vrai si quelque chose a changé (synchronisation du Worker à relancer).
 */
export async function syncSiteTargets(siteId: string, sitesDomain: string): Promise<boolean> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });
  if (!site) return false;
  const existing = await prisma.monitorTarget.findMany({ where: { siteId } });
  let changed = false;

  const wanted: Array<{ role: "working" | "final"; hostname: string; label: string }> = [
    { role: "working", hostname: `${site.slug}.${sitesDomain}`, label: `${site.slug}.${sitesDomain} (version de travail)` },
  ];
  if (site.finalDomain) {
    const host = finalHost(site.finalDomain, site.canonicalHost);
    wanted.push({ role: "final", hostname: host, label: `${host} (domaine final)` });
  }

  for (const w of wanted) {
    const url = `https://${w.hostname}/`;
    const current = existing.find((t) => t.siteRole === w.role);
    if (!current) {
      await prisma.monitorTarget.create({
        data: { siteId, siteRole: w.role, label: w.label, url, hostname: w.hostname, source: "site", erpClientId: site.erpClientId, enabled: true },
      });
      changed = true;
    } else if (current.url !== url || current.erpClientId !== site.erpClientId || current.label !== w.label) {
      // Adresse changée : les références DNS et de contenu ne valent plus.
      const moved = current.url !== url;
      await prisma.monitorTarget.update({
        where: { id: current.id },
        data: {
          url,
          hostname: w.hostname,
          label: w.label,
          erpClientId: site.erpClientId,
          ...(moved ? { dnsReference: null, dnsReferenceAt: null, contentHash: null, contentHashAt: null } : {}),
        },
      });
      changed = true;
    }
  }
  const stale = existing.filter((t) => !wanted.some((w) => w.role === t.siteRole));
  if (stale.length > 0) {
    await prisma.monitorTarget.deleteMany({ where: { id: { in: stale.map((t) => t.id) } } });
    changed = true;
  }
  return changed;
}

/**
 * Publication par le hub : l'accueil publié devient la référence du contrôle de contenu de la
 * version de travail (le Worker de Pages sert index.html tel quel).
 */
export async function recalibrateContent(siteId: string, readBlob: (sha256: string) => Promise<Buffer>): Promise<void> {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { currentVersionId: true } });
  if (!site?.currentVersionId) return;
  const index = await prisma.versionFile.findFirst({ where: { versionId: site.currentVersionId, path: "index.html" } });
  if (!index) return;
  const html = (await readBlob(index.sha256)).toString("utf8");
  await prisma.monitorTarget.updateMany({
    where: { siteId, siteRole: "working" },
    data: { contentHash: contentHash(html), contentHashAt: new Date() },
  });
}

/**
 * Rattrapage au démarrage : les sites créés avant la surveillance (ou dont le profil a changé sans
 * passer par le hub) reçoivent leurs cibles. Idempotent ; l'interrupteur « Surveillé » d'une cible
 * existante n'est jamais modifié. Renvoie le nombre de sites mis à jour.
 */
export async function backfillSiteTargets(sitesDomain: string): Promise<number> {
  const sites = await prisma.site.findMany({ where: { state: { not: "DELETING" } }, select: { id: true } });
  let changed = 0;
  for (const s of sites) if (await syncSiteTargets(s.id, sitesDomain)) changed++;
  return changed;
}
