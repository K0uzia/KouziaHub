// Types du capteur d'e-mails (mail.mjs), pour les tests du hub.
import type { Server, Socket } from "node:net";

export const MAIL_PORT: number;
export const MAIL_MAX_BYTES: number;
export const MAILS_KEPT: number;
export const MAIL_QUOTA_BYTES: number;
export const MAIL_ID_RE: RegExp;

export type MailMeta = {
  id: string;
  receivedAt: string;
  size: number;
  envelopeFrom: string;
  envelopeTo: string[];
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  attachments: number;
};

export type MailStore = {
  save(slug: string, raw: Buffer, envelope: { from: string; to: string[] }): Promise<MailMeta>;
  list(slug: string): Promise<{ mails: MailMeta[] }>;
  file(slug: string, id: string): Promise<{ file: string; keep: true; type: string }>;
  remove(slug: string, id: string): Promise<{ ok: true }>;
  clear(slug: string): Promise<{ removed: number }>;
  drop(slug: string): Promise<void>;
};

export function uidFromProcNet(text: string, clientPort: number, serverPort: number): number | null;
export function slugOfUid(passwd: string, uid: number, uidMin?: number, uidMax?: number): string | null;
export function summarize(id: string, raw: Buffer, envelope: { from: string; to: string[] }, receivedAt: string): MailMeta;
export function mailStore(options: { dir: string; now?: () => number; kept?: number; quota?: number }): MailStore;
export function createMailCatcher(options: {
  store: Pick<MailStore, "save">;
  siteOf: (socket: Socket) => string | null | Promise<string | null>;
  maxBytes?: number;
  log?: (line: string) => void;
}): Server;
