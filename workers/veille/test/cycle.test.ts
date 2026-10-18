import { describe, expect, it } from "vitest";
import { OBSERVER_STALE_MS } from "../../../apps/api/src/lib/monitor/core.js";
import { checkTarget, Budget, slotAt, slotOf } from "../src/checks.js";
import { runCycle } from "../src/cycle.js";
import { PUSH_PER_PASS, type Deps } from "../src/env.js";
import { handleFetch } from "../src/http.js";
import { formatDuration, type PushPayload } from "../src/push.js";
import { at, idsInSlot, makeD1, makeEnv, makeNet, makeSubscription, makeVapid, signed, type FakeReply } from "./helpers.js";

const urlOf = (id: string) => `https://${id}.example.fr/`;
const DOWN: FakeReply = { status: 503 };
/** Demi-cadratin et cadratin, écrits par leur code (jamais le caractère lui-même dans le dépôt). */
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

/** Banc de test : D1, réseau, clés VAPID, appareils abonnés, cibles synchronisées. */
async function bench(opts: { ids: string[]; devices?: number; rules?: Record<string, FakeReply | ((n: number) => FakeReply)> }) {
  const d1 = makeD1();
  const vapid = await makeVapid();
  const env = makeEnv(d1.db, vapid);
  const net = makeNet(opts.rules ?? {});
  const subs = await Promise.all(Array.from({ length: opts.devices ?? 1 }, (_, i) => makeSubscription(`https://fcm.googleapis.com/fcm/send/dev${i}`)));
  const deps = (now: number): Deps => ({ now: () => now, fetch: net.fetch });
  const targets = opts.ids.map((id) => ({ id, label: `${id}.example.fr`, url: urlOf(id), keyword: null }));
  const res = await handleFetch(await signed("POST", "/sync", { v: 1, targets, subscriptions: subs.map(({ endpoint, keys }) => ({ endpoint, keys })) }, at(0)), env, deps(at(0)));
  expect(res.status).toBe(200);

  const report = async (now: number, results: Record<string, boolean>) => {
    const observations = Object.entries(results).map(([targetId, ok]) => ({ targetId, observer: "hub", at: now, ok, status: ok ? 200 : 503, ms: 50, reason: ok ? null : "statut 503" }));
    const r = await handleFetch(await signed("POST", "/report", { v: 1, at: now, observations }, now), env, deps(now));
    expect(r.status).toBe(200);
  };
  const cycle = (now: number) => runCycle(env, deps(now), now);
  /** Notifications reçues par les services push (déchiffrées : non, on lit la file envoyée). */
  const pushCalls = () => net.calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/fcm/send/"));
  const queued = () => d1.rows<{ payload: string }>("SELECT payload FROM push_queue ORDER BY id").map((r) => JSON.parse(r.payload) as PushPayload);
  return { ...d1, env, net, deps, report, cycle, pushCalls, queued };
}

/** Garde les notifications avant envoi : file lue juste après l'écriture, envoi coupé (VAPID absent). */
async function notificationsOf(b: Awaited<ReturnType<typeof bench>>, now: number): Promise<PushPayload[]> {
  const env = { ...b.env, VAPID_PRIVATE_KEY: undefined };
  const before = b.queued().length;
  await runCycle(env, b.deps(now), now);
  return b.queued().slice(before);
}

describe("découpage par minute", () => {
  it("tranche stable par identifiant, tranche de la minute", () => {
    expect(slotOf("t0")).toBe(slotOf("t0"));
    expect(new Set(Array.from({ length: 200 }, (_, i) => slotOf(`site-${i}`))).size).toBe(5);
    expect([0, 1, 2, 3, 4, 5].map((m) => slotAt(at(0) + m * 60_000))).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it("un passage ne contrôle que les cibles de sa tranche", async () => {
    const ids = [...idsInSlot(0, 2), ...idsInSlot(3, 2)];
    const b = await bench({ ids });
    const r = await b.cycle(at(3));
    expect(r.slot).toBe(3);
    expect(b.net.calls.map((c) => c.url).sort()).toEqual(idsInSlot(3, 2).map(urlOf).sort());
  });

  it("40 sous-requêtes au plus : le surplus attend le tour suivant", async () => {
    const ids = idsInSlot(1, 45);
    const b = await bench({ ids, devices: 0 });
    const r = await b.cycle(at(1));
    expect(r.checked).toBe(40);
    expect(r.skipped).toBe(5);
    expect(b.net.calls).toHaveLength(40);
  });
});

describe("contrôle HTTP", () => {
  const run = async (rules: Record<string, FakeReply>, keyword: string | null = null, budget = 40) => {
    const net = makeNet(rules);
    const r = await checkTarget({ id: "a", label: "a", url: "https://a.example.fr/", keyword }, { now: () => 0, fetch: net.fetch }, new Budget(budget), 0);
    return { r, calls: net.calls };
  };
  it("redirections suivies (5 au plus), statut, mot-clé, délai", async () => {
    const chain: Record<string, FakeReply> = {};
    for (let i = 0; i < 5; i++) chain[i === 0 ? "https://a.example.fr/" : `https://a.example.fr/${i}`] = { status: 301, headers: { location: `/${i + 1}` } };
    chain["https://a.example.fr/5"] = { status: 200, body: "<h1>Bienvenue chez nous</h1>" };
    const ok = await run(chain, "Bienvenue");
    expect(ok.r).toMatchObject({ skipped: false, obs: { ok: true, status: 200 } });
    expect(ok.calls).toHaveLength(6);
    expect(ok.calls[0]!.init?.redirect).toBe("manual");

    chain["https://a.example.fr/5"] = { status: 302, headers: { location: "/6" } };
    expect((await run(chain)).r).toMatchObject({ obs: { ok: false, reason: "trop de redirections" } });
    expect((await run({ "https://a.example.fr/": { status: 200, body: "autre" } }, "Bienvenue")).r).toMatchObject({ obs: { ok: false, reason: "mot-clé absent" } });
    expect((await run({ "https://a.example.fr/": { status: 503 } })).r).toMatchObject({ obs: { ok: false, status: 503, reason: "statut 503" } });
    expect((await run({ "https://a.example.fr/": "timeout" })).r).toMatchObject({ obs: { ok: false, status: null, reason: "délai dépassé" } });
    expect((await run({ "https://a.example.fr/": "error" })).r).toMatchObject({ obs: { ok: false, reason: "connexion impossible" } });
    expect((await run({}, null, 0)).r).toEqual({ skipped: true });
  });
});

describe("décision et notifications", () => {
  it("panne vue des deux côtés : ouverture, rappel à 24 h, retour avec la durée", async () => {
    const [id] = idsInSlot(2, 1);
    const b = await bench({ ids: [id!], rules: { [urlOf(id!)]: DOWN } });

    await b.report(at(2, 0, -30_000), { [id!]: false });
    expect(await notificationsOf(b, at(2, 0))).toEqual([]); // 1 échec de chaque côté : rien
    await b.report(at(2, 1, -30_000), { [id!]: false });
    const opened = await notificationsOf(b, at(2, 1));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ title: `Site en panne : ${id}.example.fr`, body: `${id}.example.fr ne répond plus (statut 503). Vu par le hub et par Cloudflare.` });
    expect(b.rows("SELECT basis, ended_at FROM incidents")).toEqual([{ basis: "hub,edge", ended_at: null }]);

    // Toujours en panne au tour suivant : pas de doublon.
    await b.report(at(2, 2, -30_000), { [id!]: false });
    expect(await notificationsOf(b, at(2, 2))).toEqual([]);

    // 24 h après l'ouverture (288 tours) : un rappel, une seule fois.
    await b.report(at(2, 289, -30_000), { [id!]: false });
    const reminder = await notificationsOf(b, at(2, 289));
    expect(reminder).toHaveLength(1);
    expect(reminder[0]!.title).toBe(`Toujours en panne : ${id}.example.fr`);
    expect(reminder[0]!.body).toContain("depuis 1 j");
    await b.report(at(2, 290, -30_000), { [id!]: false });
    expect(await notificationsOf(b, at(2, 290))).toEqual([]);

    // Retour.
    b.net.rules[urlOf(id!)] = { status: 200, body: "ok" };
    await b.report(at(2, 291, -30_000), { [id!]: true });
    const back = await notificationsOf(b, at(2, 291));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ title: `Site rétabli : ${id}.example.fr`, body: `${id}.example.fr répond de nouveau, après ${formatDuration(290 * 300_000)} de panne.` });
    expect(b.rows("SELECT ended_at FROM incidents")).toEqual([{ ended_at: at(2, 291) }]);
  });

  it("aucune notification sur local_only (hub seul en échec) ni edge_only (Cloudflare seul)", async () => {
    const [a, c] = idsInSlot(4, 2);
    const b = await bench({ ids: [a!, c!], rules: { [urlOf(c!)]: DOWN } });
    for (let round = 0; round < 4; round++) {
      await b.report(at(4, round, -30_000), { [a!]: false, [c!]: true });
      expect(await notificationsOf(b, at(4, round))).toEqual([]);
    }
    expect(b.rows("SELECT * FROM incidents")).toEqual([]);
  });

  it("hub muet : Cloudflare décide seul et le dit", async () => {
    const [id] = idsInSlot(0, 1);
    const b = await bench({ ids: [id!], rules: { [urlOf(id!)]: DOWN } });
    await b.report(at(0, 0, -30_000), { [id!]: true });
    await notificationsOf(b, at(0, 0));
    await notificationsOf(b, at(0, 1));
    // Plus de 15 min sans rapport : « hub hors ligne » puis panne vue par Cloudflare seulement.
    const later = await notificationsOf(b, at(0, 4));
    expect(later.map((p) => p.title)).toEqual([`Site en panne : ${id}.example.fr`, "Hub hors ligne"]);
    expect(later[0]!.body).toContain("Vu par Cloudflare seulement");
    expect(b.rows("SELECT basis FROM incidents")).toEqual([{ basis: "edge" }]);
  });

  it("plus de 3 cibles en panne dans le même cycle : une notification groupée", async () => {
    const ids = idsInSlot(1, 5);
    const rules = Object.fromEntries(ids.map((id) => [urlOf(id), DOWN]));
    const b = await bench({ ids, rules });
    const fails = Object.fromEntries(ids.map((id) => [id, false]));
    await b.report(at(1, 0, -30_000), fails);
    await notificationsOf(b, at(1, 0));
    await b.report(at(1, 1, -30_000), fails);
    const n = await notificationsOf(b, at(1, 1));
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe("5 sites en panne");
    expect(n[0]!.body).toMatch(/ et 2 autres ne répondent plus\.$/);
    expect(b.rows("SELECT COUNT(*) AS n FROM incidents")).toEqual([{ n: 5 }]);
  });

  it("hub hors ligne : une seule notification, puis son retour avec la durée", async () => {
    const b = await bench({ ids: [] });
    await b.report(at(0), {});
    expect(await notificationsOf(b, at(0, 3))).toEqual([]); // 15 min pile : pas encore
    const off = await notificationsOf(b, at(0, 3, 60_000));
    expect(off.map((p) => p.title)).toEqual(["Hub hors ligne"]);
    expect(off[0]!.body).not.toMatch(LONG_DASHES);
    expect(await notificationsOf(b, at(0, 4))).toEqual([]);
    expect(b.rows("SELECT value FROM meta WHERE key = 'hub_offline_since'")).toEqual([{ value: String(at(0)) }]);

    const before = b.queued().length;
    await b.report(at(0, 6), {});
    const back = b.queued().slice(before);
    expect(back.map((p) => p.title)).toEqual(["Hub de nouveau en ligne"]);
    expect(back[0]!.body).toBe("Le hub donne de nouveau signe de vie, après 30 min hors ligne.");
    expect(b.rows("SELECT value FROM meta WHERE key = 'hub_offline_since'")).toEqual([{ value: null }]);
    expect(OBSERVER_STALE_MS).toBe(15 * 60_000);
  });
});

describe("écritures D1 limitées aux changements", () => {
  it("cible saine : état écrit au premier contrôle seulement, une ligne meta par passage", async () => {
    const [id] = idsInSlot(2, 1);
    const b = await bench({ ids: [id!], devices: 0 });
    expect((await b.cycle(at(2, 0))).stateWrites).toBe(1);
    b.log.length = 0;
    expect((await b.cycle(at(2, 1))).stateWrites).toBe(0);
    const writes = b.log.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^INSERT INTO meta/);
    expect(b.rows("SELECT value FROM meta WHERE key = 'edge_seen_at'")).toEqual([{ value: String(at(2, 1)) }]);
  });
});

describe("file d'envoi", () => {
  it(`plafond de ${PUSH_PER_PASS} envois par passage, reprise au passage suivant`, async () => {
    const ids = idsInSlot(3, 3);
    const rules = Object.fromEntries(ids.map((id) => [urlOf(id), DOWN]));
    const b = await bench({ ids, devices: 2, rules });
    const fails = Object.fromEntries(ids.map((id) => [id, false]));
    await b.report(at(3, 0, -30_000), fails);
    await b.cycle(at(3, 0));
    await b.report(at(3, 1, -30_000), fails);
    const r = await b.cycle(at(3, 1)); // 3 pannes x 2 appareils = 6 envois
    expect(r.notifications).toBe(3);
    expect(r.push.sent).toBe(PUSH_PER_PASS);
    expect(b.queued()).toHaveLength(6 - PUSH_PER_PASS);
    const call = b.pushCalls()[0]!;
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toMatch(/^vapid t=/);
    expect(headers.urgency).toBe("high");

    const next = await b.cycle(at(4, 1)); // autre tranche, la file continue
    expect(next.push.sent).toBe(6 - PUSH_PER_PASS);
    expect(b.queued()).toEqual([]);
    expect(b.pushCalls()).toHaveLength(6);
  });

  it("410 : l'abonnement est retiré avec ses notifications en attente ; autre échec : nouvel essai", async () => {
    const [id] = idsInSlot(0, 1);
    const b = await bench({ ids: [id!], devices: 2, rules: { [urlOf(id!)]: DOWN, "https://fcm.googleapis.com/fcm/send/dev0": { status: 410 }, "https://fcm.googleapis.com/fcm/send/dev1": { status: 500 } } });
    await b.report(at(0, 0, -30_000), { [id!]: false });
    await b.cycle(at(0, 0));
    await b.report(at(0, 1, -30_000), { [id!]: false });
    const r = await b.cycle(at(0, 1));
    expect(r.push).toEqual({ sent: 0, gone: 1, failed: 1 });
    expect(b.rows("SELECT endpoint FROM subscriptions")).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/dev1" }]);
    expect(b.rows("SELECT endpoint, attempts FROM push_queue")).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/dev1", attempts: 1 }]);

    // Abandon après 5 essais.
    for (let i = 1; i <= 4; i++) {
      await b.report(at(1, i, -30_000), {}); // battement de cœur : pas de « hub hors ligne »
      await b.cycle(at(1, i));
    }
    expect(b.rows("SELECT * FROM push_queue")).toEqual([]);
  });

  it("textes sans tiret long ni demi-cadratin", async () => {
    const { buildNotifications, hubBackNotification, hubOfflineNotification } = await import("../src/push.js");
    const all = [
      ...buildNotifications(0, [{ targetId: "a", label: "a.fr", reason: "statut 503", basis: ["edge"] }], [{ targetId: "a", label: "a.fr", startedAt: -7_380_000 }], [{ targetId: "a", label: "a.fr", startedAt: -90_000_000, incidentId: 1 }]),
      hubOfflineNotification(),
      hubBackNotification(0, -60_000),
    ];
    for (const p of all) expect(`${p.title} ${p.body}`).not.toMatch(LONG_DASHES);
    expect(formatDuration(7_380_000)).toBe("2 h 03");
    expect(formatDuration(90_000_000)).toBe("1 j 1 h");
  });
});

describe("anti-rafale sur un cycle complet (fenêtre glissante de 5 min)", () => {
  it("pannes ouvertes à des minutes différentes : au-delà de 3, une seule notification groupée remplace les autres", async () => {
    const ids = [0, 1, 2, 3, 4].map((slot) => idsInSlot(slot, 1, `w${slot}-`)[0]!);
    const rules = Object.fromEntries(ids.map((id) => [urlOf(id), DOWN]));
    const b = await bench({ ids, rules });
    const fails = Object.fromEntries(ids.map((id) => [id, false]));
    for (let slot = 0; slot < 5; slot++) {
      await b.report(at(slot, 0, -30_000), fails);
      await notificationsOf(b, at(slot, 0));
    }
    // File relue après chaque passage (envoi coupé : rien ne part).
    const queue: string[][] = [];
    for (let slot = 0; slot < 5; slot++) {
      await b.report(at(slot, 1, -30_000), fails);
      await notificationsOf(b, at(slot, 1));
      queue.push(b.queued().map((p) => p.title));
    }
    expect(queue.map((q) => q.length)).toEqual([1, 2, 3, 1, 1]);
    expect(queue[2]!.every((t) => t.startsWith("Site en panne : "))).toBe(true);
    // Au-delà de 3 dans la fenêtre : les ouvertures en file et la version groupée précédente sont remplacées.
    expect(queue[3]).toEqual(["4 sites en panne"]);
    expect(queue[4]).toEqual(["5 sites en panne"]);
    expect(b.queued()[0]!.tag).toBe("panne-groupe");
    expect(b.rows("SELECT COUNT(*) AS n FROM incidents")).toEqual([{ n: 5 }]);
  });
});

describe("course entre un passage et un /report", () => {
  it("rapport du hub reçu pendant les contrôles : ni « hub hors ligne » ni « de nouveau en ligne »", async () => {
    const [id] = idsInSlot(0, 1);
    const b = await bench({ ids: [id!] });
    await b.report(at(0, 0), { [id!]: true });
    const now = at(0, 4); // 20 min sans rapport au début du passage (tranche 0)
    const env = { ...b.env, VAPID_PRIVATE_KEY: undefined };
    const deps: Deps = {
      now: () => now,
      fetch: async (url, init) => {
        await b.report(now, { [id!]: true }); // le hub revient pendant le contrôle
        return b.net.fetch(url, init);
      },
    };
    await runCycle(env, deps, now);
    expect(b.queued().map((p) => p.title)).toEqual([]);
    expect(b.rows("SELECT value FROM meta WHERE key = 'hub_offline_since'")).toEqual([]);
    await b.report(now + 300_000, {});
    expect(b.queued()).toEqual([]);
  });
});

describe("purge de D1", () => {
  it("incidents fermés depuis plus de 30 jours supprimés (passage de l'heure pile)", async () => {
    const b = await bench({ ids: [] });
    const now = at(0, 0); // 12 h 00
    b.raw.exec(`INSERT INTO incidents (target_id, started_at, ended_at, basis) VALUES ('x', ${now - 40 * 86_400_000}, ${now - 31 * 86_400_000}, 'edge')`);
    b.raw.exec(`INSERT INTO incidents (target_id, started_at, ended_at, basis) VALUES ('y', ${now - 30 * 86_400_000}, ${now - 29 * 86_400_000}, 'edge')`);
    b.raw.exec(`INSERT INTO incidents (target_id, started_at, basis) VALUES ('z', ${now - 60 * 86_400_000}, 'edge')`);
    await b.cycle(now);
    expect(b.rows("SELECT target_id FROM incidents ORDER BY target_id")).toEqual([{ target_id: "y" }, { target_id: "z" }]);
  });
});
