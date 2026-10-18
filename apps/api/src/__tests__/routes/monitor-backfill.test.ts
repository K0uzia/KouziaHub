import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startBackground } from "@/lib/services.js";
import { prisma, resetDb } from "../helpers/db.js";
import { buildTestHub, type TestHub } from "../helpers/hub.js";

let hub: TestHub;

beforeEach(async () => {
  await resetDb();
  hub = await buildTestHub();
});
afterEach(async () => {
  await hub.app.close();
});

describe("rattrapage des cibles au démarrage", () => {
  it("site créé avant la surveillance : cible working ajoutée, sans doublon, interrupteur coupé respecté", async () => {
    const site = await prisma.site.create({ data: { slug: "ancien", kind: "PERSO", label: "Ancien", pagesProject: "kz-ancien", state: "ONLINE" } });
    expect(await prisma.monitorTarget.count()).toBe(0);

    await startBackground(hub.services);
    const targets = await prisma.monitorTarget.findMany({ where: { siteId: site.id } });
    expect(targets).toEqual([expect.objectContaining({ siteRole: "working", url: "https://ancien.kouzia.com/", enabled: true, source: "site" })]);

    await prisma.monitorTarget.update({ where: { id: targets[0]!.id }, data: { enabled: false } });
    await startBackground(hub.services);
    const again = await prisma.monitorTarget.findMany({ where: { siteId: site.id } });
    expect(again).toHaveLength(1);
    expect(again[0]!.enabled).toBe(false);

    // Domaine final posé sans passer par le hub : la cible final est ajoutée au démarrage suivant.
    await prisma.site.update({ where: { id: site.id }, data: { finalDomain: "client-exemple.fr", canonicalHost: "apex" } });
    await startBackground(hub.services);
    const withFinal = await prisma.monitorTarget.findMany({ where: { siteId: site.id }, orderBy: { siteRole: "asc" } });
    expect(withFinal.map((t) => `${t.siteRole}:${t.url}:${t.enabled}`)).toEqual(["final:https://client-exemple.fr/:true", "working:https://ancien.kouzia.com/:false"]);
  });
});
