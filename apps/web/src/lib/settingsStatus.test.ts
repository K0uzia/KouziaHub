import { describe, expect, it } from "vitest";
import type { MonitorOverview, OrphanReport, StorageUsage, SystemStatus } from "@hub/contract";
import {
  cloudflareStatus,
  erpStatus,
  journalStatus,
  notificationsStatus,
  reportsStatus,
  securityStatus,
  storageStatus,
  veilleStatus,
} from "@/lib/settingsStatus";

const system = (over: Partial<SystemStatus["cloudflare"]> = {}, erp: Partial<SystemStatus["erp"]> = {}): SystemStatus => ({
  cloudflare: { mode: "real", projectsUsed: 10, projectsLimit: 100, ...over },
  erp: { mode: "http", reachable: true, ...erp },
  thumbnails: { capture: true, reason: null },
  speed: { available: true, reason: null },
  sitesDomain: "kouzia.com",
});
const orphans = (over: Partial<OrphanReport> = {}): OrphanReport => ({ checkedAt: "2026-10-18T10:00:00Z", mode: "real", error: null, findings: [], ...over }) as OrphanReport;
const read = <T,>(data: T | null, error: string | null = null) => ({ data, error });

describe("état des tuiles des Réglages", () => {
  it("lecture en cours : pas d'état ; lecture en échec : Erreur", () => {
    for (const f of [securityStatus, notificationsStatus, erpStatus, storageStatus, journalStatus] as const) {
      expect(f(read(null))).toBeNull();
      expect(f(read(null, "réseau"))?.label).toBe("Erreur");
    }
    expect(cloudflareStatus(read(null), null)).toBeNull();
    expect(cloudflareStatus(read(null, "réseau"), null)?.level).toBe("error");
    expect(veilleStatus(read(null, "réseau"))?.level).toBe("error");
  });

  it("compte et sécurité", () => {
    expect(securityStatus(read({ enabled: false, recoveryCodesRemaining: 0 }))).toMatchObject({ level: "todo", label: "À faire" });
    expect(securityStatus(read({ enabled: true, recoveryCodesRemaining: 0 }))?.level).toBe("todo");
    expect(securityStatus(read({ enabled: true, recoveryCodesRemaining: 8 }))).toMatchObject({ level: "ok", label: "Configuré", reason: expect.stringContaining("8 codes de secours") });
  });

  it("notifications : clés, appareils", () => {
    expect(notificationsStatus(read({ publicKey: null, devices: 2 }))?.reason).toMatch(/push-keys/);
    expect(notificationsStatus(read({ publicKey: "k", devices: 0 }))?.level).toBe("todo");
    expect(notificationsStatus(read({ publicKey: "k", devices: 1 }))).toMatchObject({ level: "ok", reason: "1 appareil reçoit les alertes." });
  });

  it("Cloudflare : erreur avant à faire avant configuré", () => {
    expect(cloudflareStatus(read(system({ projectsUsed: 100 })), null)?.level).toBe("error");
    expect(cloudflareStatus(read(system()), orphans({ error: "jeton refusé" }))?.level).toBe("error");
    expect(cloudflareStatus(read(system({ mode: "fake" })), null)?.reason).toMatch(/démonstration/);
    expect(cloudflareStatus(read(system({ projectsUsed: 92 })), null)?.level).toBe("todo");
    expect(cloudflareStatus(read(system()), orphans({ findings: [{ type: "dns", name: "x.kouzia.com", detail: "", deletable: true }] }))?.reason).toBe("1 orphelin à regarder.");
    expect(cloudflareStatus(read(system()), orphans())).toMatchObject({ level: "ok", reason: "Compte réel, 10 projets sur 100." });
    expect(cloudflareStatus(read(system({ projectsUsed: null })), null)?.level).toBe("ok");
  });

  it("lien ERP", () => {
    expect(erpStatus(read(system({}, { mode: "fake" })))?.level).toBe("todo");
    expect(erpStatus(read(system({}, { reachable: false })))?.level).toBe("error");
    expect(erpStatus(read(system()))?.level).toBe("ok");
  });

  it("stockage", () => {
    const usage = (orphanBytes: number, tempBytes: number) =>
      ({ total: { totalBytes: 1, blobsBytes: 1, thumbnailsBytes: 0, uploadsBytes: 0, tempBytes, orphanBytes }, sites: [] }) as unknown as StorageUsage;
    expect(storageStatus(read(usage(0, 0)))?.level).toBe("ok");
    expect(storageStatus(read(usage(10, 0)))?.level).toBe("todo");
    expect(storageStatus(read(usage(0, 10)))?.level).toBe("todo");
  });

  it("veille : non déployée, en erreur, muette, active", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const health = (edge: Partial<MonitorOverview["health"]["edge"]>) =>
      ({ health: { edge: { configured: true, lastSeenAt: "2026-10-18T11:58:00Z", lastSyncAt: null, error: null, ...edge } } }) as Pick<MonitorOverview, "health">;
    expect(veilleStatus(read(health({ configured: false })), now)?.level).toBe("todo");
    expect(veilleStatus(read(health({ error: "signature refusée" })), now)?.level).toBe("error");
    expect(veilleStatus(read(health({ lastSeenAt: null })), now)?.level).toBe("todo");
    expect(veilleStatus(read(health({ lastSeenAt: "2026-10-18T11:30:00Z" })), now)?.level).toBe("error");
    expect(veilleStatus(read(health({})), now)?.level).toBe("ok");
  });

  it("journal : échecs de la semaine", () => {
    expect(journalStatus(read({ errorsLastWeek: 0 }))?.level).toBe("ok");
    expect(journalStatus(read({ errorsLastWeek: 3 }))).toMatchObject({ level: "todo", reason: "3 échecs sur les 7 derniers jours." });
  });

  it("rapports : nom et au moins un contact", () => {
    const r = (displayName: string | null, email: string | null, phone: string | null) => reportsStatus(read({ displayName, email, phone }));
    expect(reportsStatus(read(null))).toBeNull();
    expect(reportsStatus(read(null, "réseau"))?.level).toBe("error");
    expect(r(null, null, null)).toMatchObject({ level: "todo", label: "À faire", reason: "Coordonnées absentes du pied de page des rapports." });
    expect(r("  ", "a@b.fr", null)?.reason).toMatch(/^Nom affiché absent/);
    expect(r("Kouzia", null, null)?.reason).toMatch(/^Aucun moyen de contact/);
    expect(r("Kouzia", "a@b.fr", null)?.level).toBe("ok");
    expect(r("Kouzia", null, "0612345678")).toMatchObject({ level: "ok", label: "Configuré" });
  });
});
