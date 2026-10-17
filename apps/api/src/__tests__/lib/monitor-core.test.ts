import { describe, expect, it } from "vitest";
import {
  decide,
  nextObserverState,
  OBSERVER_STALE_MS,
  signRequest,
  verifyRequest,
  type HttpObservation,
  type ObserverState,
} from "@/lib/monitor/core.js";

const NOW = 1_760_000_000_000;
const obs = (ok: boolean, observer: "hub" | "edge"): HttpObservation => ({
  targetId: "t1",
  observer,
  at: NOW,
  ok,
  status: ok ? 200 : 503,
  ms: ok ? 120 : null,
  reason: ok ? null : "statut 503",
});
const state = (failures: number, observer: "hub" | "edge"): ObserverState => ({ consecutiveFailures: failures, last: obs(failures === 0, observer) });
const both = { hubSeenAt: NOW, edgeSeenAt: NOW, now: NOW };

describe("règle de décision (cadrage 10.1)", () => {
  it("panne seulement si les deux points voient 2 échecs consécutifs", () => {
    expect(decide({ hub: state(2, "hub"), edge: state(2, "edge"), ...both })).toEqual({ verdict: "down", basis: ["hub", "edge"] });
    expect(decide({ hub: state(1, "hub"), edge: state(2, "edge"), ...both }).verdict).not.toBe("down");
  });

  it("échec vu d'un seul côté : local_only ou edge_only, jamais une panne", () => {
    expect(decide({ hub: state(3, "hub"), edge: state(0, "edge"), ...both }).verdict).toBe("local_only");
    expect(decide({ hub: state(0, "hub"), edge: state(3, "edge"), ...both }).verdict).toBe("edge_only");
  });

  it("point de contrôle muet : l'autre décide seul et le dit", () => {
    const stale = NOW - OBSERVER_STALE_MS - 1;
    expect(decide({ hub: state(0, "hub"), edge: state(2, "edge"), hubSeenAt: stale, edgeSeenAt: NOW, now: NOW })).toEqual({ verdict: "down", basis: ["edge"] });
    expect(decide({ hub: state(2, "hub"), edge: state(0, "edge"), hubSeenAt: NOW, edgeSeenAt: stale, now: NOW })).toEqual({ verdict: "down", basis: ["hub"] });
    expect(decide({ hub: null, edge: null, hubSeenAt: null, edgeSeenAt: null, now: NOW })).toEqual({ verdict: "unknown", basis: [] });
  });

  it("compte les échecs consécutifs et repart à zéro au premier succès", () => {
    let s = nextObserverState(null, obs(false, "hub"));
    s = nextObserverState(s, obs(false, "hub"));
    expect(s.consecutiveFailures).toBe(2);
    expect(nextObserverState(s, obs(true, "hub")).consecutiveFailures).toBe(0);
  });
});

describe("signature hub <-> Worker", () => {
  const SECRET = "secret-partage-de-test-veille";
  const body = JSON.stringify({ v: 1, at: NOW, observations: [] });

  it("vérifie une requête signée et refuse corps, chemin, méthode ou secret modifiés", async () => {
    const ts = String(Math.floor(NOW / 1000));
    const sig = await signRequest(SECRET, ts, "POST", "/report", body);
    const ok = (s: string, method: string, path: string, b: string, secret = SECRET) =>
      verifyRequest(secret, { timestamp: ts, signature: s }, method, path, b, NOW);
    expect(await ok(sig, "POST", "/report", body)).toBe(true);
    expect(await ok(sig, "POST", "/report", body + " ")).toBe(false);
    expect(await ok(sig, "POST", "/sync", body)).toBe(false);
    expect(await ok(sig, "GET", "/report", body)).toBe(false);
    expect(await ok(sig, "POST", "/report", body, "autre-secret")).toBe(false);
  });

  it("refuse un horodatage hors fenêtre ou des en-têtes mal formés", async () => {
    const old = String(Math.floor(NOW / 1000) - 600);
    const sig = await signRequest(SECRET, old, "GET", "/state");
    expect(await verifyRequest(SECRET, { timestamp: old, signature: sig }, "GET", "/state", "", NOW)).toBe(false);
    expect(await verifyRequest(SECRET, { timestamp: null, signature: sig }, "GET", "/state", "", NOW)).toBe(false);
    expect(await verifyRequest(SECRET, { timestamp: "abc", signature: "sha256=zz" }, "GET", "/state", "", NOW)).toBe(false);
  });
});
