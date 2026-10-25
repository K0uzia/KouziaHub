import { describe, expect, it } from "vitest";
import type { PhpAgentState, PhpServerStatus } from "@hub/contract";
import { envDirty, envPayload, LIVE_KEY_RE, memoryWarning, type EnvRow } from "@/lib/phpApp";

const rows = (...r: Array<[string, string]>): EnvRow[] => r.map(([name, value], key) => ({ key, name, value }));

describe("variables d'un site PHP (écran)", () => {
  it("lignes vides ignorées, noms en majuscules ; modifiées ou non", () => {
    expect(envPayload(rows(["app_env", "production"], ["", ""], [" APP_URL ", "https://x.kouzia.com"]))).toEqual([
      { name: "APP_ENV", value: "production" },
      { name: "APP_URL", value: "https://x.kouzia.com" },
    ]);
    const saved = [{ name: "APP_ENV", value: "production" }];
    expect(envDirty(rows(["APP_ENV", "production"], ["", ""]), saved)).toBe(false);
    expect(envDirty(rows(["APP_ENV", "local"]), saved)).toBe(true);
    expect(envDirty(rows(["APP_ENV", "production"], ["A", "1"]), saved)).toBe(true);
  });

  it("clé live repérée, clé de test acceptée", () => {
    expect(LIVE_KEY_RE.test("sk_live_51Hx")).toBe(true);
    expect(LIVE_KEY_RE.test("sk_test_51Hx")).toBe(false);
  });
});

describe("alerte mémoire du CT", () => {
  const state = (memoryBytes: number | null) => ({ memoryBytes }) as unknown as PhpAgentState;
  const status = (sitesMemoryMb: number, memoryBytes: number | null): PhpServerStatus => ({ configured: true, reachable: true, sitesMemoryMb, state: state(memoryBytes) });

  it("rien si les plafonds tiennent ou si la mémoire du CT est inconnue ; alerte au-delà", () => {
    expect(memoryWarning(status(1792, 3 * 1024 ** 3))).toBeNull();
    expect(memoryWarning(status(1792, null))).toBeNull();
    expect(memoryWarning({ configured: false })).toBeNull();
    expect(memoryWarning(status(2304, 2 * 1024 ** 3))).toMatch(/dépassent la mémoire du CT/);
  });
});
