import { describe, expect, it } from "vitest";
import type { Operation, PhpAgentState, SiteMonitorBadge, SiteSummary } from "@hub/contract";
import { displayState, divergence, isDown, matchesState, phpHostingChoice, stateBucket } from "@/lib/sites";

type Input = Pick<SiteSummary, "state" | "operation" | "domainStatus" | "monitor">;

const NOW = new Date("2026-10-18T20:00:00");
const SINCE = new Date("2026-10-18T18:26:00").toISOString();

function site(over: Partial<Input> = {}): Input {
  return { state: "ONLINE", operation: null, domainStatus: "ACTIVE", monitor: null, ...over };
}

function monitor(verdict: SiteMonitorBadge["verdict"], over: Partial<SiteMonitorBadge> = {}): SiteMonitorBadge {
  return { verdict, watched: 1, uptime30d: 100, openIncidentSince: null, expiresInDays: null, ...over };
}

function op(status: Operation["status"], kind: Operation["kind"] = "PUBLISH", steps: Operation["steps"] = []): Operation {
  return { id: "op", kind, status, steps, error: null, startedAt: SINCE, finishedAt: null };
}

const waiting: Operation["steps"] = [{ key: "certificate", label: "Certificat", status: "waiting" }];

describe("displayState : un seul état, par priorité", () => {
  it("en ligne, hors ligne", () => {
    expect(displayState(site()).key).toBe("online");
    expect(displayState(site()).label).toBe("En ligne");
    expect(displayState(site({ state: "OFFLINE" })).key).toBe("offline");
  });

  it("la panne passe avant tout le reste", () => {
    const down = monitor("down");
    for (const base of [
      site(),
      site({ state: "OFFLINE" }),
      site({ state: "CREATING" }),
      site({ operation: op("FAILED") }),
      site({ domainStatus: "ERROR" }),
      site({ operation: op("RUNNING") }),
      site({ state: "DELETING" }),
    ]) {
      expect(displayState({ ...base, monitor: down }).key).toBe("down");
    }
  });

  it("panne avec incident ouvert : depuis quand", () => {
    const s = displayState(site({ monitor: monitor("down", { openIncidentSince: SINCE }) }), NOW);
    expect(s.label).toBe("Panne depuis 18 h 26");
    expect(s.tone).toBe("red");
    expect(displayState(site({ monitor: monitor("down") })).label).toBe("En panne");
  });

  it("problème local, vu par Cloudflare seul, inconnu : pas une panne, l'état du site reste", () => {
    for (const v of ["local_only", "edge_only", "unknown", "up"] as const) {
      expect(displayState(site({ monitor: monitor(v) })).key).toBe("online");
      expect(isDown(site({ monitor: monitor(v) }))).toBe(false);
    }
  });

  it("aucune cible surveillée : le verdict est ignoré", () => {
    expect(displayState(site({ monitor: monitor("down", { watched: 0 }) })).key).toBe("online");
  });

  it("erreur : opération en échec ou domaine en erreur, avant création et hors ligne", () => {
    expect(displayState(site({ operation: op("FAILED") })).key).toBe("error");
    expect(displayState(site({ domainStatus: "ERROR" })).key).toBe("error");
    expect(displayState(site({ state: "CREATING", operation: op("FAILED", "CREATE") })).key).toBe("error");
    expect(displayState(site({ state: "OFFLINE", operation: op("FAILED", "DISABLE") })).key).toBe("error");
  });

  it("suppression, création, certificat et opérations en cours", () => {
    expect(displayState(site({ state: "DELETING" })).key).toBe("deleting");
    expect(displayState(site({ state: "CREATING" })).key).toBe("creating");
    expect(displayState(site({ operation: op("DONE", "CREATE", waiting) })).label).toBe("Certificat en cours");
    expect(displayState(site({ domainStatus: "PENDING" })).label).toBe("Certificat en cours");
    expect(displayState(site({ operation: op("RUNNING", "PUBLISH") })).label).toBe("Publication en cours");
    expect(displayState(site({ state: "OFFLINE", operation: op("RUNNING", "ENABLE") })).label).toBe("Mise en ligne en cours");
  });
});

describe("stateBucket et matchesState : chaque site sous le filtre de son badge", () => {
  it("un filtre par état affiché", () => {
    expect(stateBucket(site({ monitor: monitor("down") }))).toBe("down");
    expect(stateBucket(site({ operation: op("FAILED") }))).toBe("error");
    expect(stateBucket(site({ state: "CREATING" }))).toBe("creating");
    expect(stateBucket(site({ state: "OFFLINE" }))).toBe("offline");
    expect(stateBucket(site())).toBe("online");
  });

  it("opérations en cours : sous l'état de l'interrupteur ; suppression : sous « Tous » seulement", () => {
    expect(stateBucket(site({ operation: op("RUNNING") }))).toBe("online");
    expect(stateBucket(site({ state: "OFFLINE", operation: op("RUNNING", "ENABLE") }))).toBe("offline");
    expect(stateBucket(site({ domainStatus: "PENDING" }))).toBe("online");
    expect(stateBucket(site({ state: "DELETING" }))).toBeNull();
  });

  it("un site en panne n'est plus « En ligne »", () => {
    const s = site({ monitor: monitor("down") });
    expect(matchesState(s, "down")).toBe(true);
    expect(matchesState(s, "online")).toBe(false);
    expect(matchesState(s, "error")).toBe(false);
    expect(matchesState(s, "all")).toBe(true);
    expect(matchesState(site({ state: "DELETING" }), "all")).toBe(true);
  });
});

describe("divergence : état détaillé de la fiche", () => {
  it("en ligne mais en panne", () => {
    expect(divergence(site({ monitor: monitor("down", { openIncidentSince: SINCE }) }), NOW)).toBe(
      "En ligne, mais en panne vue de l'extérieur depuis 18 h 26.",
    );
    expect(divergence(site({ state: "OFFLINE", monitor: monitor("down") }))).toBe("Hors ligne, mais en panne vue de l'extérieur.");
  });

  it("problème local ou vu par Cloudflare seul : précisé sans changer l'état", () => {
    expect(divergence(site({ monitor: monitor("local_only") }))).toMatch(/^En ligne ; surveillance : problème local/);
    expect(divergence(site({ monitor: monitor("edge_only") }))).toMatch(/^En ligne ; surveillance : vu en échec par Cloudflare seulement/);
  });

  it("rien à préciser", () => {
    expect(divergence(site())).toBeNull();
    expect(divergence(site({ monitor: monitor("up") }))).toBeNull();
    expect(divergence(site({ monitor: monitor("down", { watched: 0 }) }))).toBeNull();
  });
});

describe("phpHostingChoice : choix PHP à la création", () => {
  const state = { php: ["8.3"] } as unknown as PhpAgentState;

  it("propose les versions quand l'agent répond", () => {
    expect(phpHostingChoice({ configured: true, reachable: true, state, sitesMemoryMb: 512 }, false)).toEqual({ versions: ["8.3"], unavailable: null });
  });

  it("dit pourquoi PHP manque, au lieu de le masquer sans un mot", () => {
    expect(phpHostingChoice({ configured: false }, false)?.unavailable).toMatch(/pas encore relié au hub/);
    expect(phpHostingChoice({ configured: true, reachable: false, error: "Serveur des sites PHP injoignable." }, false)?.unavailable).toMatch(/injoignable/);
    expect(phpHostingChoice({ configured: true, reachable: true, sitesMemoryMb: 512, state: { php: [] } as unknown as PhpAgentState }, false)?.unavailable).toMatch(/aucune version/);
    expect(phpHostingChoice(null, true)?.unavailable).toMatch(/illisible/);
  });

  it("rien pendant le chargement", () => {
    expect(phpHostingChoice(null, false)).toBeNull();
  });
});
