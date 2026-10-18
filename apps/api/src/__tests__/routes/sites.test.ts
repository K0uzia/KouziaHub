import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogResponse, SiteDetail } from "@/contract.js";
import { FakeCloudflare } from "@/lib/cloudflare/fake.js";
import { ErpUnavailableError, type ErpDirectory } from "@/lib/erp/types.js";
import { INTERRUPTED } from "@/lib/operations.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, createPersoSite, settle, type TestHub } from "../helpers/hub.js";

let hub: TestHub;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
});

const get = async (id: string): Promise<SiteDetail> => {
  const res = await hub.app.inject({ method: "GET", url: `/api/sites/${id}`, headers: hub.headers });
  expect(res.statusCode).toBe(200);
  return res.json() as SiteDetail;
};

describe("sous-domaines", () => {
  const check = async (query: string) => (await hub.app.inject({ method: "GET", url: `/api/sites/slug-check?${query}`, headers: hub.headers })).json();

  it("refuse format, noms réservés, sous-domaine pris et enregistrement DNS existant", async () => {
    expect(await check("slug=alpha")).toEqual({ slug: "alpha", ok: true, reason: null });
    for (const bad of ["-alpha", "alpha-", "al--pha", "Al pha", "été", "a".repeat(41), ""]) {
      expect((await check(`slug=${encodeURIComponent(bad)}`)).ok, bad).toBe(false);
    }
    for (const reserved of ["www", "erp", "api", "hub", "mail", "admin", "kouzia", "autodiscover", "ns1"]) {
      expect(await check(`slug=${reserved}`)).toMatchObject({ ok: false, reason: "Nom réservé." });
    }
    hub.cf.seedDnsRecord({ type: "A", name: "boutique.kouzia.com", content: "192.0.2.1", proxied: true, comment: null });
    expect(await check("slug=boutique")).toMatchObject({ ok: false, reason: expect.stringMatching(/enregistrement DNS A/) });
    hub.cf.seedProject("kz-ancien");
    expect(await check("slug=ancien")).toMatchObject({ ok: false, reason: expect.stringMatching(/hors du hub/) });
    await createPersoSite(hub, "alpha");
    expect(await check("slug=alpha")).toMatchObject({ ok: false, reason: expect.stringMatching(/déjà utilisé/) });
  });

  it("propose un sous-domaine depuis un nom (minuscules, sans accent)", async () => {
    expect(await check(`name=${encodeURIComponent("Boulangerie Éclair & Fils")}`)).toMatchObject({ slug: "boulangerie-eclair-fils", ok: true });
  });
});

describe("création d'un site", () => {
  it("crée projet, page d'attente, domaine puis CNAME, et passe en ligne", async () => {
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "Portfolio" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ slug: "alpha", hostname: "alpha.kouzia.com", url: "https://alpha.kouzia.com", kind: "PERSO", name: "Portfolio" });
    await settle(hub);
    expect(hub.cf.calls).toEqual(["createProject:kz-alpha", "deploy:kz-alpha", "addDomain:alpha.kouzia.com", "createCname:alpha.kouzia.com"]);
    const site = await get(res.json().id);
    expect(site).toMatchObject({ state: "ONLINE", domainStatus: "ACTIVE", pagesProject: "kz-alpha", pagesSubdomain: "kz-alpha.pages.dev", operation: null });
    expect(site.currentVersion?.number).toBe(1);
    const dns = hub.cf.snapshot().dns[0]!;
    expect(dns).toMatchObject({ type: "CNAME", name: "alpha.kouzia.com", content: "kz-alpha.pages.dev", proxied: true, comment: `kouzia-hub:${site.id}` });
    const placeholder = hub.cf.deployments("kz-alpha")[0]!;
    expect(Object.keys(placeholder.manifest)).toEqual(["/index.html"]);
    expect(placeholder.workerJs).toContain('"alpha.kouzia.com"');
    const audit = await prisma.auditEvent.findFirst({ where: { action: "site.create" } });
    expect(audit).toMatchObject({ result: "ok", siteSlug: "alpha" });
  });

  it("utilise le sous-domaine pages.dev renvoyé par Cloudflare (suffixe si le nom est pris)", async () => {
    hub.cf.takenSubdomains.add("kz-beta");
    const id = await createPersoSite(hub, "beta");
    const site = await get(id);
    expect(site.pagesSubdomain).toMatch(/^kz-beta-[0-9a-f]{4}\.pages\.dev$/);
    expect(hub.cf.snapshot().dns[0]!.content).toBe(site.pagesSubdomain);
  });

  it("site client : vérifie le client dans l'ERP et affiche son nom", async () => {
    process.env.ERP_PUBLIC_ORIGIN = "https://erp.kouzia.com";
    try {
      const bad = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "CLIENT", erpClientId: "inconnu", slug: "gamma" } });
      expect(bad.statusCode).toBe(400);
      const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "CLIENT", erpClientId: "demo-01", slug: "gamma" } });
      expect(res.statusCode).toBe(201);
      await settle(hub);
      const site = await get(res.json().id);
      expect(site).toMatchObject({ kind: "CLIENT", clientName: "Démo 01 : boulangerie", name: "Démo 01 : boulangerie", erpClientUrl: "https://erp.kouzia.com/clients/demo-01" });
      const row = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
      expect(row.label).toBeNull();
    } finally {
      delete process.env.ERP_PUBLIC_ORIGIN;
    }
  });

  it("site perso : libellé obligatoire ; sous-domaine indisponible : 409", async () => {
    const noLabel = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "delta" } });
    expect(noLabel.statusCode).toBe(400);
    const reserved = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "www", label: "x" } });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json().error).toBe("Nom réservé.");
  });

  it("modifie libellé et client ; un site perso garde un libellé", async () => {
    const id = await createPersoSite(hub, "alpha");
    const toClient = await hub.app.inject({ method: "PATCH", url: `/api/sites/${id}`, headers: hub.headers, payload: { erpClientId: "demo-02", label: null } });
    expect(toClient.json()).toMatchObject({ kind: "CLIENT", erpClientId: "demo-02", label: null, name: "Démo 02 : cabinet d'architecture" });
    const noLabel = await hub.app.inject({ method: "PATCH", url: `/api/sites/${id}`, headers: hub.headers, payload: { erpClientId: null } });
    expect(noLabel.statusCode).toBe(400);
    const toPerso = await hub.app.inject({ method: "PATCH", url: `/api/sites/${id}`, headers: hub.headers, payload: { erpClientId: null, label: "Perso" } });
    expect(toPerso.json()).toMatchObject({ kind: "PERSO", erpClientId: null, name: "Perso" });
  });
});

describe("moteur d'opérations", () => {
  it("off : CNAME supprimé PUIS domaine retiré ; on : domaine PUIS CNAME", async () => {
    const id = await createPersoSite(hub, "alpha");
    hub.cf.calls.length = 0;
    const off = await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    expect(off.statusCode).toBe(200);
    await settle(hub);
    expect(hub.cf.calls).toEqual(["deleteDnsRecord:alpha.kouzia.com", "removeDomain:alpha.kouzia.com"]);
    expect(await get(id)).toMatchObject({ state: "OFFLINE", domainStatus: "NONE" });
    expect(hub.cf.snapshot().dns).toEqual([]);

    const again = await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    expect(again.statusCode).toBe(409);

    hub.cf.calls.length = 0;
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/enable`, headers: hub.headers });
    await settle(hub);
    expect(hub.cf.calls).toEqual(["addDomain:alpha.kouzia.com", "createCname:alpha.kouzia.com"]);
    expect(await get(id)).toMatchObject({ state: "ONLINE", domainStatus: "ACTIVE" });
  });

  it("suppression : confirmation exacte, puis CNAME, domaine, projet dans cet ordre ; l'historique garde le slug", async () => {
    const id = await createPersoSite(hub, "alpha");
    const wrong = await hub.app.inject({ method: "DELETE", url: `/api/sites/${id}`, headers: hub.headers, payload: { confirm: "ALPHA" } });
    expect(wrong.statusCode).toBe(400);
    hub.cf.calls.length = 0;
    const res = await hub.app.inject({ method: "DELETE", url: `/api/sites/${id}`, headers: hub.headers, payload: { confirm: "alpha" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "DELETING", operation: { kind: "DELETE" } });
    await settle(hub);
    expect(hub.cf.calls).toEqual(["deleteDnsRecord:alpha.kouzia.com", "removeDomain:alpha.kouzia.com", "deleteProject:kz-alpha"]);
    expect((await hub.app.inject({ method: "GET", url: `/api/sites/${id}`, headers: hub.headers })).statusCode).toBe(404);
    const op = await prisma.operation.findFirstOrThrow({ where: { kind: "DELETE" } });
    expect(op).toMatchObject({ siteId: null, siteSlug: "alpha", status: "DONE" });
    expect(await prisma.version.count()).toBe(0);
    expect(await prisma.auditEvent.findFirst({ where: { action: "site.delete" } })).toMatchObject({ result: "ok", siteSlug: "alpha" });
  });

  it("échec injecté : opération FAILED à l'étape nommée, reprise sans recréer le projet", async () => {
    hub.cf.failNext("addDomain");
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "A" } });
    await settle(hub);
    const failed = await get(res.json().id);
    expect(failed.state).toBe("CREATING");
    expect(failed.operation).toMatchObject({ kind: "CREATE", status: "FAILED", error: expect.stringMatching(/^Adresse ajoutée au projet : /) });
    expect(failed.operation!.steps.map((s) => s.status)).toEqual(["done", "done", "failed", "todo", "todo"]);

    const retry = await hub.app.inject({ method: "POST", url: `/api/sites/${failed.id}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    expect(retry.statusCode).toBe(200);
    await settle(hub);
    expect(await get(failed.id)).toMatchObject({ state: "ONLINE", operation: null });
    expect(hub.cf.calls.filter((c) => c.startsWith("createProject"))).toHaveLength(1);
    expect(hub.cf.calls.filter((c) => c.startsWith("deploy"))).toHaveLength(1);
  });

  it("refuse une deuxième opération pendant qu'une autre est en cours", async () => {
    const id = await createPersoSite(hub, "alpha");
    const first = hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    const second = hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    const codes = (await Promise.all([first, second])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    await settle(hub);
  });

  it("redémarrage : une opération restée RUNNING passe en échec « interrompue », puis se reprend", async () => {
    const id = await createPersoSite(hub, "alpha");
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    await settle(hub);
    // Simule un arrêt au milieu d'une remise en ligne.
    const op = await prisma.operation.create({
      data: {
        siteId: id,
        siteSlug: "alpha",
        kind: "ENABLE",
        status: "RUNNING",
        steps: JSON.stringify([
          { key: "domain", label: "Adresse ajoutée au projet", status: "running" },
          { key: "dns", label: "Enregistrement DNS créé", status: "todo" },
          { key: "certificate", label: "Certificat HTTPS", status: "todo" },
        ]),
      },
    });
    expect(await hub.services.engine.recoverInterrupted()).toBe(1);
    const site = await get(id);
    expect(site.operation).toMatchObject({ id: op.id, status: "FAILED", error: INTERRUPTED });
    expect(site.operation!.steps[0]).toMatchObject({ status: "failed", detail: INTERRUPTED });
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/operations/${op.id}/retry`, headers: hub.headers });
    await settle(hub);
    expect(await get(id)).toMatchObject({ state: "ONLINE", operation: null });
  });

  it("CNAME du hub réemployé avec une ancienne cible : recalé sur l'adresse pages.dev du projet", async () => {
    hub.cf.failNext("addDomain");
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "A" } });
    await settle(hub);
    const failed = await get(res.json().id);
    hub.cf.seedDnsRecord({ type: "CNAME", name: "alpha.kouzia.com", content: "kz-ancien.pages.dev", proxied: true, comment: `kouzia-hub:${failed.id}` });
    await hub.app.inject({ method: "POST", url: `/api/sites/${failed.id}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    await settle(hub);
    expect(hub.cf.calls).toContain("updateCname:alpha.kouzia.com");
    expect(hub.cf.calls).not.toContain("createCname:alpha.kouzia.com");
    expect(hub.cf.snapshot().dns).toEqual([expect.objectContaining({ name: "alpha.kouzia.com", content: "kz-alpha.pages.dev" })]);
    expect(await get(failed.id)).toMatchObject({ state: "ONLINE" });
  });

  it("refuse le CNAME si un enregistrement hors hub occupe le nom", async () => {
    // Enregistrement créé hors hub entre le contrôle du sous-domaine et l'étape DNS : posé à l'ajout du
    // domaine, juste avant l'étape CNAME (sans fenêtre de temps, le test ne dépend pas de l'ordonnancement).
    class RacingCloudflare extends FakeCloudflare {
      override async addDomain(project: string, hostname: string) {
        const domain = await super.addDomain(project, hostname);
        if (!this.snapshot().dns.some((r) => r.name === hostname)) {
          this.seedDnsRecord({ type: "A", name: hostname, content: "192.0.2.1", proxied: false, comment: null });
        }
        return domain;
      }
    }
    await hub.app.close();
    hub = await buildTestHub({ cloudflare: new RacingCloudflare() });
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "A" } });
    await settle(hub);
    const site = await get(res.json().id);
    expect(site.operation).toMatchObject({ status: "FAILED", error: expect.stringMatching(/hors du hub/) });
  });
});

describe("certificat en attente", () => {
  it("attente n'est pas un échec : étape « waiting », puis en ligne quand Cloudflare dit actif", async () => {
    await hub.app.close();
    // Horloge du faux Cloudflare menée à la main : sous charge, une création plus lente que le délai
    // d'activation rendait le site déjà en ligne avant la première vérification.
    let t = 1_000_000;
    hub = await buildTestHub({ cloudflare: new FakeCloudflare({ activationDelayMs: 60_000, now: () => t }), watcherDelaysMs: [30] });
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "A" } });
    await settle(hub);
    const waiting = await get(res.json().id);
    expect(waiting).toMatchObject({ state: "CREATING", domainStatus: "PENDING" });
    expect(waiting.operation).toMatchObject({ status: "DONE" });
    expect(waiting.operation!.steps.at(-1)).toMatchObject({ key: "certificate", status: "waiting", detail: "certificat en cours, quelques minutes" });

    t += 120_000;
    const deadline = Date.now() + 10_000;
    let site = waiting;
    while (Date.now() < deadline && site.state !== "ONLINE") {
      await new Promise((r) => setTimeout(r, 40));
      site = await get(waiting.id);
    }
    expect(site).toMatchObject({ state: "ONLINE", domainStatus: "ACTIVE", operation: null });
    const op = await prisma.operation.findFirstOrThrow({ where: { siteId: waiting.id, kind: "CREATE" } });
    expect(JSON.parse(op.steps).at(-1)).toMatchObject({ key: "certificate", status: "done" });
  }, 20_000);
});

describe("certificat : jamais bloqué", () => {
  const waitFor = async (pred: (s: SiteDetail) => boolean, id: string) => {
    const deadline = Date.now() + 3000;
    let site = await get(id);
    while (Date.now() < deadline && !pred(site)) {
      await new Promise((r) => setTimeout(r, 30));
      site = await get(id);
    }
    return site;
  };

  it("remise en ligne en attente de certificat (hors ligne, CNAME posé) : la coupure reste possible", async () => {
    await hub.app.close();
    hub = await buildTestHub({ cloudflare: new FakeCloudflare({ activationDelayMs: 600_000 }), watcherDelaysMs: [600_000] });
    const id = await createPersoSite(hub, "alpha");
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    await settle(hub);
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/enable`, headers: hub.headers });
    await settle(hub);
    expect(await get(id)).toMatchObject({ state: "OFFLINE", domainStatus: "PENDING" });
    expect(hub.cf.snapshot().dns).toHaveLength(1);
    const off = await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    expect(off.statusCode).toBe(200);
    await settle(hub);
    expect(await get(id)).toMatchObject({ state: "OFFLINE", domainStatus: "NONE" });
    expect(hub.cf.snapshot().dns).toEqual([]);
    expect(hub.cf.snapshot().projects[0]!.domains).toEqual([]);
  });

  it("erreur de validation du certificat : opération FAILED reprenable, puis en ligne", async () => {
    await hub.app.close();
    let t = 1_000_000;
    hub = await buildTestHub({ cloudflare: new FakeCloudflare({ activationDelayMs: 60_000, now: () => t }), watcherDelaysMs: [20] });
    const id = await createPersoSite(hub, "alpha");
    hub.cf.setDomainStatus("kz-alpha", "alpha.kouzia.com", "error");
    const failed = await waitFor((s) => s.operation?.status === "FAILED", id);
    expect(failed).toMatchObject({ state: "CREATING", domainStatus: "ERROR" });
    expect(failed.operation).toMatchObject({ kind: "CREATE", error: expect.stringMatching(/^Certificat HTTPS : /) });
    expect(failed.operation!.steps.at(-1)).toMatchObject({ key: "certificate", status: "failed" });

    hub.cf.setDomainStatus("kz-alpha", "alpha.kouzia.com", undefined);
    t += 120_000;
    const retry = await hub.app.inject({ method: "POST", url: `/api/sites/${id}/operations/${failed.operation!.id}/retry`, headers: hub.headers });
    expect(retry.statusCode).toBe(200);
    await settle(hub);
    expect(await get(id)).toMatchObject({ state: "ONLINE", domainStatus: "ACTIVE", operation: null });
  });

  it("deux reprises simultanées : une seule exécution", async () => {
    hub.cf.failNext("addDomain");
    const res = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "PERSO", slug: "alpha", label: "A" } });
    await settle(hub);
    const failed = await get(res.json().id);
    const url = `/api/sites/${failed.id}/operations/${failed.operation!.id}/retry`;
    const codes = (await Promise.all([1, 2].map(() => hub.app.inject({ method: "POST", url, headers: hub.headers })))).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    await settle(hub);
    expect(hub.cf.calls.filter((c) => c.startsWith("createCname"))).toHaveLength(1);
  });
});

describe("catalogue", () => {
  it("statistiques, compteur de projets et avis (Cloudflare simulé, ERP factice)", async () => {
    hub.cf.seedProject("autre-projet");
    await createPersoSite(hub, "alpha");
    const id = await createPersoSite(hub, "beta");
    await hub.app.inject({ method: "POST", url: `/api/sites/${id}/disable`, headers: hub.headers });
    await settle(hub);
    hub.services.projects.invalidate();
    const res = await hub.app.inject({ method: "GET", url: "/api/sites", headers: hub.headers });
    const body = res.json() as CatalogResponse;
    expect(body.sites.map((s) => s.slug)).toEqual(["beta", "alpha"]);
    expect(body.stats).toEqual({ online: 1, offline: 1, creating: 0, errors: 0, projectsUsed: 3, projectsLimit: 100 });
    expect(body.notices.map((n) => n.code).sort()).toEqual(["cloudflare_fake", "erp_fake"]);
  });

  it("projets proches de 100 : avis", async () => {
    for (let i = 0; i < 92; i++) hub.cf.seedProject(`p${i}`);
    const body = (await hub.app.inject({ method: "GET", url: "/api/sites", headers: hub.headers })).json() as CatalogResponse;
    expect(body.notices.find((n) => n.code === "projects_near_limit")?.message).toMatch(/92 projets/);
  });

  it("ERP indisponible : catalogue servi, avis affiché, nom du client inconnu", async () => {
    await hub.app.close();
    let up = true;
    const erp: ErpDirectory = {
      mode: "http",
      async list() {
        if (!up) throw new ErpUnavailableError();
        return [{ id: "c1", clientNumber: "CLI-0001", displayName: "Client réel", type: "B2B" }];
      },
      async get(id) {
        if (!up) throw new ErpUnavailableError();
        return id === "c1" ? { id: "c1", clientNumber: "CLI-0001", displayName: "Client réel", type: "B2B" } : null;
      },
    };
    hub = await buildTestHub({ erp });
    await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "CLIENT", erpClientId: "c1", slug: "alpha" } });
    await settle(hub);
    up = false;
    const res = await hub.app.inject({ method: "GET", url: "/api/sites", headers: hub.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CatalogResponse;
    expect(body.notices.find((n) => n.code === "erp_unavailable")?.message).toBe("Clients de l'ERP indisponibles.");
    expect(body.sites[0]).toMatchObject({ clientName: null, name: "alpha.kouzia.com" });
    const clients = await hub.app.inject({ method: "GET", url: "/api/erp/clients", headers: hub.headers });
    expect(clients.json()).toEqual({ clients: [], available: false });
    const create = await hub.app.inject({ method: "POST", url: "/api/sites", headers: hub.headers, payload: { kind: "CLIENT", erpClientId: "c1", slug: "beta" } });
    expect(create.statusCode).toBe(503);
  });
});
