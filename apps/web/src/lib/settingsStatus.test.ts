import { describe, expect, it } from "vitest";
import type { MonitorOverview, OrphanReport, PhpAgentState, PhpServerStatus, StorageUsage, SystemStatus } from "@hub/contract";
import {
  cloudflareStatus,
  erpStatus,
  phpServerStatus,
  journalStatus,
  notificationsStatus,
  reportsStatus,
  securityStatus,
  storageStatus,
  veilleStatus,
  VEILLE_READY,
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
    const health = (edge: Partial<MonitorOverview["health"]["edge"]>, watched = 3) =>
      ({
        health: { edge: { configured: true, lastSeenAt: "2026-10-18T11:58:00Z", lastSyncAt: null, error: null, ...edge } },
        stats: { watched, up: watched, down: 0, warnings: 0, openIncidents: 0 },
      }) as Pick<MonitorOverview, "health" | "stats">;
    expect(veilleStatus(read(health({ configured: false })), now)?.level).toBe("todo");
    expect(veilleStatus(read(health({ error: "signature refusée" })), now)?.level).toBe("error");
    expect(veilleStatus(read(health({ lastSeenAt: null })), now)?.level).toBe("todo");
    expect(veilleStatus(read(health({ lastSeenAt: "2026-10-18T11:30:00Z" })), now)?.level).toBe("error");
    expect(veilleStatus(read(health({})), now)?.level).toBe("ok");
  });

  it("veille prête sans adresse surveillée : « À faire », message qui dit quoi faire (pas « pas encore de passage »)", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const ready = (edge: Partial<MonitorOverview["health"]["edge"]> = {}) =>
      ({
        health: { edge: { configured: true, lastSeenAt: null, lastSyncAt: "2026-10-18T11:59:00Z", error: null, ...edge } },
        stats: { watched: 0, up: 0, down: 0, warnings: 0, openIncidents: 0 },
      }) as Pick<MonitorOverview, "health" | "stats">;
    expect(veilleStatus(read(ready()), now)).toEqual({ level: "todo", label: "À faire", reason: "Veille prête : ajoutez un site ou une adresse à surveiller." });
    // Déployée sans adresse, mais déjà passée : toujours « prête », jamais « muette » ni « active ».
    expect(veilleStatus(read(ready({ lastSeenAt: "2026-10-18T10:00:00Z" })), now)?.reason).toBe(VEILLE_READY);
    // Non déployée ou en erreur : ces états passent avant.
    expect(veilleStatus(read(ready({ configured: false })), now)?.reason).toMatch(/non déployé/);
    expect(veilleStatus(read(ready({ error: "signature refusée" })), now)?.level).toBe("error");
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

describe("serveur des sites PHP", () => {
  const state: PhpAgentState = {
    agentVersion: "1",
    alpine: "3.22.2",
    node: "22.23.4",
    php: ["8.3"],
    services: { nginx: "running", mariadb: "running", tunnel: "running", firewall: "running" },
    cgroups: { result: "ok", checkedAt: "2026-10-24 11:50" },
    lastUpgrade: "2026-10-20",
    disk: null,
    memoryBytes: null,
    scripts: null,
    sites: 1,
    time: "2026-10-24T12:00:00.000Z",
  };
  const status = (data: PhpServerStatus) => phpServerStatus({ data, error: null });

  it("non installé, injoignable, service arrêté, mises à jour en retard, puis tout va bien", () => {
    expect(status({ configured: false })?.level).toBe("todo");
    expect(status({ configured: true, reachable: false, error: "Serveur des sites PHP injoignable." })).toMatchObject({ level: "error", reason: "Serveur des sites PHP injoignable." });
    expect(status({ configured: true, reachable: true, sitesMemoryMb: 512, scriptsAvailable: "a".repeat(64), state: { ...state, services: { ...state.services, tunnel: "stopped" } } })).toMatchObject({ level: "error", reason: "Arrêté ou absent : tunnel." });
    expect(status({ configured: true, reachable: true, sitesMemoryMb: 512, scriptsAvailable: "a".repeat(64), state: { ...state, lastUpgrade: "2026-10-01" } })?.level).toBe("todo");
    expect(status({ configured: true, reachable: true, sitesMemoryMb: 512, scriptsAvailable: "a".repeat(64), state: { ...state, lastUpgrade: null } })?.level).toBe("todo");
    expect(status({ configured: true, reachable: true, state, sitesMemoryMb: 512, scriptsAvailable: "a".repeat(64) })).toMatchObject({ level: "ok", reason: "Joignable : PHP 8.3, 1 site." });
  });
});
