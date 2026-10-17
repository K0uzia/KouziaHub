import { filterClients, type ErpClient, type ErpDirectory } from "@/lib/erp/types.js";

/** Clients de démonstration (dev sans ERP_BASE_URL) : noms marqués « démo », aucun client réel. */
export const DEMO_CLIENTS: ErpClient[] = [
  { id: "demo-01", clientNumber: "DEMO-0001", displayName: "Démo 01 : boulangerie", type: "B2B" },
  { id: "demo-02", clientNumber: "DEMO-0002", displayName: "Démo 02 : cabinet d'architecture", type: "B2B" },
  { id: "demo-03", clientNumber: "DEMO-0003", displayName: "Démo 03 : association sportive", type: "ASSOCIATION" },
  { id: "demo-04", clientNumber: "DEMO-0004", displayName: "Démo 04 : photographe", type: "B2C" },
  { id: "demo-05", clientNumber: "DEMO-0005", displayName: "Démo 05 : garage automobile", type: "B2B" },
  { id: "demo-06", clientNumber: "DEMO-0006", displayName: "Démo 06 : école de musique", type: "ASSOCIATION" },
  { id: "demo-07", clientNumber: "DEMO-0007", displayName: "Démo 07 : restaurant", type: "B2B" },
  { id: "demo-08", clientNumber: "DEMO-0008", displayName: "Démo 08 : coach sportif", type: "B2C" },
  { id: "demo-09", clientNumber: "DEMO-0009", displayName: "Démo 09 : fleuriste", type: "B2B" },
  { id: "demo-10", clientNumber: "DEMO-0010", displayName: "Démo 10 : gîte rural", type: "B2C" },
];

export class FakeErpDirectory implements ErpDirectory {
  readonly mode = "fake" as const;

  constructor(private readonly clients: ErpClient[] = DEMO_CLIENTS) {}

  async list(q?: string): Promise<ErpClient[]> {
    return filterClients(this.clients, q);
  }

  async get(id: string): Promise<ErpClient | null> {
    return this.clients.find((c) => c.id === id) ?? null;
  }
}
