import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, type StateResponse } from "../../../apps/api/src/lib/monitor/core.js";
import { slotOf } from "../src/checks.js";
import { MAX_BODY_BYTES, type Deps } from "../src/env.js";
import { handleFetch } from "../src/http.js";
import { BASE, SECRET, makeD1, makeEnv, makeNet, signed } from "./helpers.js";

const deps = (now = BASE): Deps => ({ now: () => now, fetch: makeNet().fetch });

const target = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: `Site ${id}`, url: `https://${id}.example.fr/`, keyword: null, ...extra });
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: "BPk".padEnd(87, "A"), auth: "abcdefghijklmnopqrstuv" } });

async function expectRefused(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("Not Found");
  expect([...res.headers.entries()]).toEqual([["content-type", "text/plain; charset=utf-8"]]);
}

describe("points d'entrée : tout refus répond la même 404", () => {
  const syncBody = { v: 1, targets: [target("a")], subscriptions: [] };

  it("chemin inconnu, méthode inconnue, racine", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    await expectRefused(await handleFetch(new Request("https://v.example/"), env, deps()));
    await expectRefused(await handleFetch(await signed("POST", "/autre", syncBody, BASE), env, deps()));
    await expectRefused(await handleFetch(await signed("GET", "/sync", undefined, BASE), env, deps()));
    await expectRefused(await handleFetch(await signed("POST", "/state", {}, BASE), env, deps()));
  });

  it("signature absente, fausse, d'un autre secret, horodatage trop vieux", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    await expectRefused(await handleFetch(new Request("https://v.example/state"), env, deps()));
    const req = await signed("POST", "/sync", syncBody, BASE);
    const forged = new Request(req.url, {
      method: "POST",
      headers: { [TIMESTAMP_HEADER]: req.headers.get(TIMESTAMP_HEADER)!, [SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}` },
      body: JSON.stringify(syncBody),
    });
    await expectRefused(await handleFetch(forged, env, deps()));
    await expectRefused(await handleFetch(await signed("POST", "/sync", syncBody, BASE, "autre-secret"), env, deps()));
    await expectRefused(await handleFetch(await signed("POST", "/sync", syncBody, BASE - 301_000), env, deps()));
  });

  it("corps modifié après signature", async () => {
    const { db } = makeD1();
    const req = await signed("POST", "/sync", syncBody, BASE);
    const tampered = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ ...syncBody, targets: [] }) });
    await expectRefused(await handleFetch(tampered, makeEnv(db), deps()));
  });

  it("corps trop gros, JSON invalide, contenu invalide, secret absent du Worker", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const big = { v: 1, targets: [], subscriptions: [], pad: "x".repeat(MAX_BODY_BYTES) };
    await expectRefused(await handleFetch(await signed("POST", "/sync", big, BASE), env, deps()));
    const ts = String(Math.floor(BASE / 1000));
    const { signRequest } = await import("../../../apps/api/src/lib/monitor/core.js");
    const badJson = new Request("https://v.example/sync", {
      method: "POST",
      headers: { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: await signRequest(SECRET, ts, "POST", "/sync", "{non") },
      body: "{non",
    });
    await expectRefused(await handleFetch(badJson, env, deps()));
    for (const body of [
      { v: 2, targets: [], subscriptions: [] },
      { v: 1, targets: [target("a", { url: "ftp://x" })], subscriptions: [] },
      { v: 1, targets: [target("a"), target("a")], subscriptions: [] },
      { v: 1, targets: [target("a b")], subscriptions: [] },
      { v: 1, targets: [], subscriptions: [{ endpoint: "http://push.example.com/1", keys: { p256dh: "x", auth: "y" } }] },
    ]) {
      await expectRefused(await handleFetch(await signed("POST", "/sync", body, BASE), env, deps()));
    }
    await expectRefused(
      await handleFetch(await signed("POST", "/report", { v: 1, at: BASE, observations: [{ targetId: "a", observer: "edge", at: BASE, ok: true }] }, BASE), env, deps()),
    );
    await expectRefused(await handleFetch(await signed("GET", "/state", undefined, BASE), { ...env, MONITOR_SHARED_SECRET: "" }, deps()));
  });
});

describe("anti-rejeu et requête signée", () => {
  it("même requête rejouée, horodatage plus ancien : refusés ; horodatage suivant : accepté", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const body = { v: 1, targets: [target("a")], subscriptions: [] };
    const first = await signed("POST", "/sync", body, BASE);
    const replay = first.clone();
    expect((await handleFetch(first, env, deps())).status).toBe(200);
    await expectRefused(await handleFetch(replay, env, deps()));
    await expectRefused(await handleFetch(await signed("POST", "/sync", body, BASE - 1000), env, deps()));
    expect((await handleFetch(await signed("POST", "/sync", body, BASE + 1000), env, deps())).status).toBe(200);
    // Le compteur est propre à chaque route : /report au même horodatage passe.
    expect((await handleFetch(await signed("POST", "/report", { v: 1, at: BASE, observations: [] }, BASE), env, deps())).status).toBe(200);
  });

  it("paramètre « since » modifié après signature : refusé", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    const req = await signed("GET", "/state?since=1000", undefined, BASE);
    const tampered = new Request(req.url.replace("since=1000", "since=0"), { method: "GET", headers: req.headers });
    await expectRefused(await handleFetch(tampered, env, deps()));
    expect((await handleFetch(await signed("GET", "/state?since=1000", undefined, BASE), env, deps())).status).toBe(200);
  });

  it("abonnement hors des services push connus : refusé", async () => {
    const { db } = makeD1();
    const env = makeEnv(db);
    let ts = BASE;
    for (const endpoint of ["https://evil.example/push", "https://192.168.1.1/push", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x"]) {
      ts += 1000;
      const body = { v: 1, targets: [], subscriptions: [{ endpoint, keys: { p256dh: "BPk".padEnd(87, "A"), auth: "abcdefghijklmnopqrstuv" } }] };
      await expectRefused(await handleFetch(await signed("POST", "/sync", body, ts), env, deps(ts)));
    }
    ts += 1000;
    const ok = { v: 1, targets: [], subscriptions: [{ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc", keys: { p256dh: "BPk".padEnd(87, "A"), auth: "abcdefghijklmnopqrstuv" } }] };
    expect((await handleFetch(await signed("POST", "/sync", ok, ts), env, deps(ts))).status).toBe(200);
  });
});

describe("POST /sync", () => {
  it("remplace cibles et abonnements, nettoie ce qui est retiré", async () => {
    const { db, rows, raw } = makeD1();
    const env = makeEnv(db);
    const first = await handleFetch(await signed("POST", "/sync", { v: 1, targets: [target("a"), target("b", { keyword: "Bienvenue" })], subscriptions: [sub(1), sub(2)] }, BASE), env, deps());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, targets: 2, subscriptions: 2 });
    expect(rows("SELECT id, keyword, slot FROM targets ORDER BY id")).toEqual([
      { id: "a", keyword: null, slot: slotOf("a") },
      { id: "b", keyword: "Bienvenue", slot: slotOf("b") },
    ]);

    raw.exec(`INSERT INTO state VALUES ('b', 'edge', 2, 0, 503, 12, 'statut 503', ${BASE})`);
    raw.exec(`INSERT INTO incidents (target_id, started_at, basis) VALUES ('b', ${BASE}, 'hub,edge')`);
    raw.exec(`INSERT INTO push_queue (created_at, endpoint, payload) VALUES (${BASE}, 'https://fcm.googleapis.com/fcm/send/2', '{}')`);

    await handleFetch(await signed("POST", "/sync", { v: 1, targets: [target("a", { label: "Nouveau nom" })], subscriptions: [sub(1)] }, BASE + 1000), env, deps());
    expect(rows("SELECT id, label FROM targets")).toEqual([{ id: "a", label: "Nouveau nom" }]);
    expect(rows("SELECT * FROM state")).toEqual([]);
    expect(rows("SELECT * FROM incidents")).toEqual([]);
    expect(rows("SELECT endpoint FROM subscriptions")).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/1" }]);
    expect(rows("SELECT * FROM push_queue")).toEqual([]);
  });
});

describe("POST /report", () => {
  it("battement de cœur, états du hub écrits seulement s'ils changent, cibles inconnues ignorées", async () => {
    const { db, rows } = makeD1();
    const env = makeEnv(db);
    await handleFetch(await signed("POST", "/sync", { v: 1, targets: [target("a"), target("b")], subscriptions: [] }, BASE), env, deps());
    const obs = (id: string, t: number, ok: boolean) => ({ targetId: id, observer: "hub", at: t, ok, status: ok ? 200 : 503, ms: 40, reason: ok ? null : "statut 503" });

    const r1 = await handleFetch(
      await signed("POST", "/report", { v: 1, at: BASE, observations: [obs("a", BASE - 1000, true), obs("b", BASE - 2000, false), obs("b", BASE - 1000, false), obs("x", BASE, false)] }, BASE),
      env,
      deps(),
    );
    expect(await r1.json()).toEqual({ ok: true, accepted: 3 });
    expect(rows("SELECT target_id, failures, ok, at FROM state ORDER BY target_id")).toEqual([
      { target_id: "a", failures: 0, ok: 1, at: BASE - 1000 },
      { target_id: "b", failures: 2, ok: 0, at: BASE - 1000 },
    ]);
    expect(rows("SELECT value FROM meta WHERE key = 'hub_seen_at'")).toEqual([{ value: String(BASE) }]);

    // Même résultat pour « a » : rien n'est réécrit (son horodatage reste l'ancien).
    const later = BASE + 300_000;
    await handleFetch(await signed("POST", "/report", { v: 1, at: later, observations: [obs("a", later, true)] }, later), env, deps(later));
    expect(rows("SELECT at FROM state WHERE target_id = 'a'")).toEqual([{ at: BASE - 1000 }]);
    expect(rows("SELECT value FROM meta WHERE key = 'hub_seen_at'")).toEqual([{ value: String(later) }]);
  });
});

describe("GET /state", () => {
  it("observations de Cloudflare depuis « since », incidents, derniers signes de vie", async () => {
    const { db, raw } = makeD1();
    const env = makeEnv(db);
    raw.exec(`INSERT INTO state VALUES ('a', 'edge', 0, 1, 200, 30, NULL, ${BASE - 60_000})`);
    raw.exec(`INSERT INTO state VALUES ('b', 'edge', 2, 0, NULL, NULL, 'délai dépassé', ${BASE - 600_000})`);
    raw.exec(`INSERT INTO state VALUES ('a', 'hub', 0, 1, 200, 30, NULL, ${BASE})`);
    raw.exec(`INSERT INTO incidents (target_id, started_at, basis) VALUES ('b', ${BASE - 600_000}, 'edge')`);
    raw.exec(`INSERT INTO incidents (target_id, started_at, ended_at, basis) VALUES ('c', ${BASE - 9e6}, ${BASE - 8e6}, 'hub,edge')`);
    raw.exec(`INSERT INTO meta VALUES ('edge_seen_at', '${BASE - 60_000}'), ('hub_seen_at', '${BASE - 30_000}')`);

    const res = await handleFetch(await signed("GET", `/state?since=${BASE - 120_000}`, undefined, BASE), env, deps());
    const body = (await res.json()) as StateResponse;
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.now).toBe(BASE);
    expect(body.edgeSeenAt).toBe(BASE - 60_000);
    expect(body.hubSeenAt).toBe(BASE - 30_000);
    expect(body.observations).toEqual([{ targetId: "a", observer: "edge", at: BASE - 60_000, ok: true, status: 200, ms: 30, reason: null, failures: 0 }]);
    // État courant de chaque cible, même sans changement depuis « since » (cible b), avec ses échecs consécutifs.
    expect(body.current).toEqual([
      { targetId: "a", observer: "edge", at: BASE - 60_000, ok: true, status: 200, ms: 30, reason: null, failures: 0 },
      { targetId: "b", observer: "edge", at: BASE - 600_000, ok: false, status: null, ms: null, reason: "délai dépassé", failures: 2 },
    ]);
    expect(body.incidents).toEqual([{ targetId: "b", startedAt: BASE - 600_000, endedAt: null, basis: ["edge"] }]);
  });
});
