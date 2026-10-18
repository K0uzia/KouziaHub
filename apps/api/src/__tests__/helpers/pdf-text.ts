import { inflateSync } from "node:zlib";

/**
 * Texte d'un PDF produit par react-pdf avec des polices embarquées (codage Identity-H) : chaque code de
 * glyphe est relu par la table ToUnicode de sa police (une ligature donne plusieurs caractères : « <0066 0066> »). Renvoie aussi les noms des polices embarquées.
 */
export function readPdf(pdf: Buffer): { text: string; fonts: string[] } {
  const raw = pdf.toString("latin1");
  const objects = new Map<string, { dict: string; stream: string | null }>();
  const starts = [...raw.matchAll(/(\d+) 0 obj/g)];
  starts.forEach((m, n) => {
    const chunk = raw.slice(m.index! + m[0].length, n + 1 < starts.length ? starts[n + 1]!.index : raw.length);
    const at = chunk.search(/stream\r?\n/);
    if (at < 0) return objects.set(m[1]!, { dict: chunk, stream: null });
    const dict = chunk.slice(0, at);
    const body = chunk.slice(chunk.indexOf("\n", at) + 1, chunk.lastIndexOf("endstream")).replace(/\r?\n$/, "");
    let stream = body;
    if (/FlateDecode/.test(dict)) {
      try {
        stream = inflateSync(Buffer.from(body, "latin1")).toString("latin1");
      } catch {
        stream = "";
      }
    }
    objects.set(m[1]!, { dict, stream });
  });

  // Polices : nom de ressource (/F1) -> table code -> texte.
  const cmaps = new Map<string, Map<number, string>>();
  const fonts: string[] = [];
  const utf16 = (hex: string) => Buffer.from(hex.replace(/\s+/g, ""), "hex").swap16().toString("utf16le");
  for (const { dict } of objects.values()) {
    for (const ref of dict.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
      const font = objects.get(ref[2]!);
      const toUnicode = font && /\/ToUnicode\s+(\d+) 0 R/.exec(font.dict);
      const base = font && /\/BaseFont\s*\/([^\s/<>]+)/.exec(font.dict);
      if (base && !fonts.includes(base[1]!)) fonts.push(base[1]!);
      if (!toUnicode || cmaps.has(ref[1]!)) continue;
      const cmap = objects.get(toUnicode[1]!)?.stream ?? "";
      const map = new Map<number, string>();
      for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
        for (const p of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(p[1]!, 16), utf16(p[2]!));
      }
      for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
        for (const r of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
          const lo = parseInt(r[1]!, 16);
          const hi = parseInt(r[2]!, 16);
          if (r[3]!.startsWith("[")) {
            [...r[3]!.matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((d, i) => map.set(lo + i, utf16(d[1]!)));
          } else {
            const first = parseInt(r[3]!.slice(1, -1), 16);
            for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(first + c - lo));
          }
        }
      }
      cmaps.set(ref[1]!, map);
    }
  }

  let text = "";
  for (const { stream } of objects.values()) {
    if (!stream || !/\bT[Jj]\b/.test(stream)) continue;
    let font = "";
    for (const op of stream.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|(\[(?:[^\]]*)\])\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      if (op[1]) {
        font = op[1];
        continue;
      }
      const map = cmaps.get(font);
      const hexes = op[2] ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!) : [op[3]!];
      for (const hex of hexes) {
        const width = map ? 4 : 2;
        for (let i = 0; i + width <= hex.length; i += width) {
          const code = parseInt(hex.slice(i, i + width), 16);
          text += map ? (map.get(code) ?? "") : String.fromCharCode(code);
        }
      }
      text += " ";
    }
  }
  return { text: text.replace(/[ \t\r\n]+/g, " "), fonts };
}
