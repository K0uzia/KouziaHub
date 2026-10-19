import { filterClients, type ErpClient, type ErpDirectory } from "@/lib/erp/types.js";

/** Clients d'exemple (ERP pas encore relié, ERP_BASE_URL absente) : noms marqués « Exemple », aucun client réel. */
export const DEMO_CLIENTS: ErpClient[] = [
  { id: "demo-01", clientNumber: "EX-0001", displayName: "Exemple 01 : boulangerie", type: "B2B" },
  { id: "demo-02", clientNumber: "EX-0002", displayName: "Exemple 02 : cabinet d'architecture", type: "B2B" },
  { id: "demo-03", clientNumber: "EX-0003", displayName: "Exemple 03 : association sportive", type: "ASSOCIATION" },
  { id: "demo-04", clientNumber: "EX-0004", displayName: "Exemple 04 : photographe", type: "B2C" },
  { id: "demo-05", clientNumber: "EX-0005", displayName: "Exemple 05 : garage automobile", type: "B2B" },
  { id: "demo-06", clientNumber: "EX-0006", displayName: "Exemple 06 : école de musique", type: "ASSOCIATION" },
  { id: "demo-07", clientNumber: "EX-0007", displayName: "Exemple 07 : restaurant", type: "B2B" },
  { id: "demo-08", clientNumber: "EX-0008", displayName: "Exemple 08 : coach sportif", type: "B2C" },
  { id: "demo-09", clientNumber: "EX-0009", displayName: "Exemple 09 : fleuriste", type: "B2B" },
  { id: "demo-10", clientNumber: "EX-0010", displayName: "Exemple 10 : gîte rural", type: "B2C" },
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
