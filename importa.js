// Conversione del vecchio file Excel (Data, Cliente, Dettaglio, Omaggio, Fatturato, Entrate, Uscite, Guadagno)
// in ordini dell'app. Funzione pura: riceve le righe del foglio come array di array.
import { IO, STORICO, chiave } from "./calc.js?v=19";

export function parseEuro(v) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").replace(/[^\d,.\-]/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export function parseData(v) {
  if (v instanceof Date && !isNaN(v)) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "number" && v > 20000 && v < 80000) { // numero seriale di Excel
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const m = String(v ?? "").trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    const anno = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${anno}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  const iso = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

const pulisci = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ").trim();

// "Mousse detergente, 3 mini prodotti Natale, 30 campioncini, siero x2" → [{nome, qta}]
export function parseOmaggi(testo) {
  const out = [];
  for (let pezzo of pulisci(testo).split(/[,;+]|\s+e\s+/i)) {
    pezzo = pezzo.replace(/^[-•*\s]+|[.\s]+$/g, "").trim();
    if (!pezzo) continue;
    let qta = 1, m;
    if ((m = pezzo.match(/^(\d+)\s*(?:x|×|pz\.?|pezzi)?\s+(.+)$/i))) { qta = +m[1]; pezzo = m[2]; }
    else if ((m = pezzo.match(/^(.+?)\s*(?:x|×)\s*(\d+)$/i))) { pezzo = m[1]; qta = +m[2]; }
    const nome = pezzo.charAt(0).toUpperCase() + pezzo.slice(1);
    const esist = out.find(x => chiave(x.nome) === chiave(nome));
    if (esist) esist.qta += qta; else out.push({ nome, qta: Math.max(1, qta) });
  }
  return out;
}

// "Cipria (MTA), Set uomo (NR), aceto, detox, blush (io), 3 burrocacao (MF), calendario x2"
// → [{ nome, qta, sigla }]. Una sigla tra parentesi vale anche per i prodotti senza sigla scritti subito prima.
export function dividiProdotti(testo) {
  const pezzi = [];
  let buf = "", liv = 0;
  for (const ch of pulisci(testo)) {
    if (ch === "(") liv++; if (ch === ")") liv = Math.max(0, liv - 1);
    if ((ch === "," || ch === ";") && liv === 0) { pezzi.push(buf); buf = ""; } else buf += ch;
  }
  pezzi.push(buf);
  const out = [];
  for (let p of pezzi) {
    p = p.trim(); if (!p) continue;
    let sigla = null, m;
    if ((m = p.match(/^(.*?)\s*\(([A-Za-zÀ-ÿ]{1,5})\)\s*$/))) { p = m[1].trim(); sigla = m[2]; }
    let qta = 1;
    if ((m = p.match(/^(\d+)\s*(?:x|×)?\s+(.+)$/i))) { qta = +m[1]; p = m[2]; }
    else if ((m = p.match(/^(.+?)\s*(?:x|×)\s*(\d+)$/i))) { p = m[1]; qta = +m[2]; }
    if (!p) continue;
    out.push({ nome: p.charAt(0).toUpperCase() + p.slice(1), qta: Math.max(1, qta), sigla, siglaPropria: !!sigla });
  }
  // la sigla si estende ai prodotti precedenti senza sigla
  for (let i = out.length - 1, ultima = null; i >= 0; i--) {
    if (out[i].sigla) ultima = out[i].sigla; else if (ultima) out[i].sigla = ultima;
  }
  // ...ma i prodotti finali senza nessuna sigla dopo restano senza
  return out;
}

// Abbina una sigla (es. "MTA", "NR", "io") a uno dei nomi: restituisce l'indice, "io", oppure null
export function abbinaSigla(sigla, nomi) {
  if (!sigla) return null;
  const s = sigla.toUpperCase();
  if (s === "IO") return "io";
  const punti = nomi.map(n => {
    const parole = chiave(n).split(" ").filter(Boolean);
    const iniz = parole.map(w => w[0]).join("").toUpperCase();
    if (iniz === s) return 3;
    if (s.startsWith(iniz) || iniz.startsWith(s)) return 2;
    if (iniz[0] === s[0]) return 1;
    return 0;
  });
  const max = Math.max(...punti);
  if (max === 0 || punti.filter(x => x === max).length > 1) return null;
  return punti.indexOf(max);
}

export function dividiClienti(testo) {
  const nomi = pulisci(testo).split(/,|;|\s+e\s+|\//i).map(s => s.trim()).filter(Boolean);
  return { io: nomi.some(n => chiave(n) === "io"), altri: nomi.filter(n => chiave(n) !== "io") };
}

export function convertiFoglio(righeFoglio) {
  // Trova la riga di intestazione
  const iHead = righeFoglio.findIndex(r => r && r.some(c => chiave(c) === "data") && r.some(c => chiave(c) === "cliente"));
  if (iHead < 0) throw new Error("Non trovo le colonne “Data” e “Cliente” nel file.");
  const head = righeFoglio[iHead].map(chiave);
  const col = (nome) => head.indexOf(nome);
  const C = { data: col("data"), cliente: col("cliente"), dettaglio: col("dettaglio"), omaggio: col("omaggio"),
              fatturato: col("fatturato"), entrate: col("entrate"), uscite: col("uscite") };
  if (C.entrate < 0 || C.uscite < 0) throw new Error("Mancano le colonne “Entrate” o “Uscite”.");

  const ordini = [], nomiClienti = new Map(), scartate = [];
  righeFoglio.slice(iHead + 1).forEach((r, i) => {
    if (!r || r.every(c => c === null || c === undefined || String(c).trim() === "")) return;
    if (r.some(c => /^totale?\b/i.test(String(c ?? "").trim()))) return; // riga dei totali
    const data = parseData(r[C.data]);
    if (!data) { scartate.push({ riga: iHead + i + 2, motivo: "data non valida" }); return; }

    const entrate = parseEuro(r[C.entrate]);
    const uscite = parseEuro(r[C.uscite]);
    const fatturato = C.fatturato >= 0 ? parseEuro(r[C.fatturato]) : entrate;
    const dettaglio = pulisci(r[C.dettaglio]);
    const { io, altri } = dividiClienti(r[C.cliente]);
    altri.forEach(n => { if (!nomiClienti.has(chiave(n))) nomiClienti.set(chiave(n), n); });

    const righe = [];
    const base = { omaggiDati: [], pagato: true, consegnato: true };
    if (altri.length === 1) righe.push({ ...base, clienteNome: altri[0], prodotti: dettaglio, importo: entrate });
    else if (altri.length > 1) righe.push({ ...base, clienteId: STORICO, clientiStorico: altri.join(", "), prodotti: dettaglio, importo: entrate });

    if (io) {
      const valoreIo = altri.length ? Math.max(0, Math.round((fatturato - entrate) * 100) / 100) : (fatturato || uscite);
      righe.push({ ...base, clienteId: IO, prodotti: altri.length ? "Acquisti personali" : dettaglio, importo: valoreIo });
    }
    if (!righe.length) { scartate.push({ riga: iHead + i + 2, motivo: "nessun cliente" }); return; }

    const testoOmaggi = pulisci(r[C.omaggio]);
    ordini.push({ data, costo: uscite, costoIoManuale: null, omaggiRicevuti: parseOmaggi(testoOmaggi), omaggiNote: "", omaggiNoteOriginale: testoOmaggi,
      note: "Importato da Excel", importato: true, righe,
      _controllo: { fatturato, entrate, uscite } });
  });
  return { ordini, nomiClienti: [...nomiClienti.values()], scartate };
}
