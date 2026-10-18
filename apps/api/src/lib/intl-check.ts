import { parisParts } from "@/lib/fr-format.js";

// Auto-contrôle des données ICU de l'hôte (Alpine : icu-data-en seul fait retomber fr-FR sur l'anglais,
// « € » avant le montant sur l'ERP). Les PDF n'en dépendent plus (fr-format.ts), mais l'écart est dit au
// démarrage, dans /api/health et par « hubctl status ».

const FIX = "installer icu-data-full (hubctl update) puis redémarrer le hub";

/** Heure de Paris selon Intl (données de fuseau de l'hôte), comparée à la règle européenne. */
function intlParisHour(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")!.value);
}

/** Écarts trouvés, vide si Intl fr-FR et le fuseau Europe/Paris sont complets. */
export function checkIntl(): string[] {
  const problems: string[] = [];
  const spaces = (s: string) => s.replace(/[  ]/g, " ");
  try {
    const locale = new Intl.NumberFormat("fr-FR").resolvedOptions().locale;
    if (!locale.startsWith("fr")) problems.push(`Intl fr-FR indisponible (langue retenue : ${locale}) : ${FIX}.`);
    const amount = spaces(new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(1234.5));
    if (amount !== "1 234,50 €") problems.push(`Montant en fr-FR : ${amount} au lieu de 1 234,50 € : ${FIX}.`);
    const month = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "long" }).format(Date.UTC(2026, 9, 15));
    if (month !== "octobre") problems.push(`Mois en fr-FR : ${month} au lieu de octobre : ${FIX}.`);
  } catch (err) {
    problems.push(`Intl fr-FR en erreur (${err instanceof Error ? err.message : String(err)}) : ${FIX}.`);
  }
  try {
    // Hiver, été, et les deux côtés des changements d'heure de 2026 (29 mars et 25 octobre, 1 h UTC).
    const instants = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12), Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)];
    const wrong = instants.filter((at) => intlParisHour(at) !== parisParts(at).hour);
    if (wrong.length) problems.push(`Fuseau Europe/Paris faux dans Intl (${wrong.length} heure(s) sur ${instants.length}) : ${FIX}.`);
  } catch (err) {
    problems.push(`Fuseau Europe/Paris inconnu de Intl (${err instanceof Error ? err.message : String(err)}) : ${FIX}.`);
  }
  return problems;
}

let cached: string[] | null = null;

/** Résultat mis en cache : les données ICU ne changent pas sans redémarrage. */
export function intlProblems(): string[] {
  cached ??= checkIntl();
  return cached;
}
