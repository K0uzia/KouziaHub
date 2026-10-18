// Coût CPU d'un envoi Web Push (chiffrement ECDH, HKDF, AES-GCM, signature VAPID ECDSA), mesuré sous
// Node avec la même bibliothèque que le Worker. Le CPU d'un Worker n'est pas celui de Node : chiffres
// indicatifs, à confirmer en réel (cadrage 10.3). Le test échoue seulement si l'écart est grossier.
// process.cpuUsage a un grain de 15,6 ms sous Windows : on mesure des séries de 50 envois, pas un envoi.
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { describe, expect, it } from "vitest";
import { PUSH_PER_PASS } from "../src/env.js";
import { makeSubscription, makeVapid } from "./helpers.js";

const RUNS = 50;
const SERIES = 6;
const CPU_BUDGET_MS = 10;

const cpuMs = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000;

describe("coût CPU d'un envoi push", () => {
  it(`moyenne par envoi sur des séries de ${RUNS}`, async () => {
    const vapid = await makeVapid();
    const sub = await makeSubscription();
    const message = {
      data: { title: "Site en panne : exemple.fr", body: "exemple.fr ne répond plus (délai dépassé).", url: "/surveillance", tag: "x" },
      options: { ttl: 86_400, urgency: "high" as const, topic: "abc" },
    };
    // Échauffement : la première importation de clés compile le code.
    for (let i = 0; i < 5; i++) await buildPushPayload(message, sub, vapid);

    const means: number[] = [];
    for (let s = 0; s < SERIES; s++) {
      const before = process.cpuUsage();
      for (let i = 0; i < RUNS; i++) await buildPushPayload(message, sub, vapid);
      means.push(cpuMs(process.cpuUsage(before)) / RUNS);
    }
    const mean = means.reduce((a, b) => a + b, 0) / SERIES;
    const worst = Math.max(...means);
    console.log(
      `[push-cpu] ${SERIES} séries de ${RUNS} envois : moyenne ${mean.toFixed(2)} ms par envoi, pire série ${worst.toFixed(2)} ms ; ` +
        `${PUSH_PER_PASS} envois par passage = ${(worst * PUSH_PER_PASS).toFixed(2)} ms sur ${CPU_BUDGET_MS} ms`,
    );
    expect(worst).toBeLessThan(CPU_BUDGET_MS);
  });
});

describe("coût CPU d'un passage complet", () => {
  it("40 contrôles, décisions, écritures et 4 envois", async () => {
    const { runCycle } = await import("../src/cycle.js");
    const { handleFetch } = await import("../src/http.js");
    const { at, idsInSlot, makeD1, makeEnv, makeNet, signed } = await import("./helpers.js");
    const PASSES = 20;
    // Préparation d'abord, puis une seule mesure autour des 20 passages (grain de 15,6 ms sous Windows).
    const ready: Array<() => Promise<void>> = [];
    for (let p = 0; p < PASSES; p++) {
      const d1 = makeD1();
      const vapid = await makeVapid();
      const env = makeEnv(d1.db, vapid);
      const ids = idsInSlot(0, 40);
      // Toutes en panne des deux côtés au 2e tour : 40 états écrits, une notification groupée, 4 appareils.
      const net = makeNet(Object.fromEntries(ids.map((id) => [`https://${id}.example.fr/`, { status: 503 }])));
      const subs = await Promise.all([0, 1, 2, 3].map((i) => makeSubscription(`https://push.example.com/d${i}`)));
      const deps = (now: number) => ({ now: () => now, fetch: net.fetch });
      const targets = ids.map((id) => ({ id, label: id, url: `https://${id}.example.fr/`, keyword: null }));
      await handleFetch(await signed("POST", "/sync", { v: 1, targets, subscriptions: subs }, at(0)), env, deps(at(0)));
      const fails = ids.map((targetId) => ({ targetId, observer: "hub", at: at(0), ok: false, status: 503, ms: 9, reason: "statut 503" }));
      for (const round of [0, 1]) {
        const now = at(0, round);
        await handleFetch(await signed("POST", "/report", { v: 1, at: now, observations: fails.map((o) => ({ ...o, at: now - 1 })) }, now), env, deps(now));
        if (round === 0) await runCycle(env, deps(now), now);
      }
      const now = at(0, 1);
      ready.push(async () => {
        const report = await runCycle(env, deps(now), now);
        expect(report.checked).toBe(40);
        expect(report.push.sent).toBe(4);
      });
    }
    const before = process.cpuUsage();
    for (const run of ready) await run();
    const mean = cpuMs(process.cpuUsage(before)) / PASSES;
    console.log(`[cycle-cpu] ${PASSES} passages (40 contrôles, 40 états écrits, 4 envois) : moyenne ${mean.toFixed(2)} ms (SQLite local compris)`);
    expect(mean).toBeLessThan(50);
  });
});
