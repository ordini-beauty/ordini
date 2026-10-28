// Calcoli puri (nessuna dipendenza da Firebase), testabili a parte.
export const IO = "__io";           // cliente speciale: acquisti personali
export const STORICO = "__storico"; // righe importate con più clienti insieme

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const chiave = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// ---------- Guadagno per ordine ----------
export function calcolaOrdine(o) {
  const righe = o.righe || [];
  const costo = Number(o.costo) || 0;
  const fatturato = righe.reduce((s, r) => s + (Number(r.importo) || 0), 0);
  const valoreIo = righe.filter(r => r.clienteId === IO).reduce((s, r) => s + (Number(r.importo) || 0), 0);
  const venditaClienti = fatturato - valoreIo;

  // Quota del costo attribuita ai suoi acquisti: manuale se indicata, altrimenti proporzionale.
  const manuale = o.costoIoManuale !== undefined && o.costoIoManuale !== null && o.costoIoManuale !== "";
  const quotaIo = manuale ? Number(o.costoIoManuale) : (fatturato > 0 ? costo * valoreIo / fatturato : 0);
  const costoClienti = costo - quotaIo;

  const clienti = righe.filter(r => r.clienteId !== IO);
  const incassato = clienti.filter(r => r.pagato).reduce((s, r) => s + (Number(r.importo) || 0), 0);

  return {
    fatturato: r2(fatturato),
    valoreIo: r2(valoreIo),
    venditaClienti: r2(venditaClienti),
    quotaIo: r2(quotaIo),
    quotaIoManuale: manuale,
    costoClienti: r2(costoClienti),
    incassato: r2(incassato),
    daIncassare: r2(venditaClienti - incassato),
    guadagnoAtteso: r2(venditaClienti - costoClienti), // quando tutti avranno pagato
    guadagnoReale: r2(incassato - costoClienti),       // con quanto incassato finora
    daConsegnare: righe.filter(r => !r.consegnato).length
  };
}

export function riepilogoPeriodo(ordini) {
  const t = { ordini: 0, fatturato: 0, venditaClienti: 0, costo: 0, quotaIo: 0, incassato: 0,
              daIncassare: 0, guadagnoAtteso: 0, guadagnoReale: 0 };
  for (const o of ordini) {
    const c = calcolaOrdine(o);
    t.ordini++;
    t.fatturato += c.fatturato; t.venditaClienti += c.venditaClienti; t.costo += Number(o.costo) || 0;
    t.quotaIo += c.quotaIo; t.incassato += c.incassato; t.daIncassare += c.daIncassare;
    t.guadagnoAtteso += c.guadagnoAtteso; t.guadagnoReale += c.guadagnoReale;
  }
  for (const k of Object.keys(t)) if (k !== "ordini") t[k] = r2(t[k]);
  return t;
}

// ---------- Omaggi e campioncini: giacenza ----------
// ricevuti (dagli ordini) − dati ai clienti ± rettifiche manuali
export function giacenzaOmaggi(ordini, movimenti = []) {
  const m = new Map();
  const voce = (nome) => {
    const k = chiave(nome); if (!k) return null;
    if (!m.has(k)) m.set(k, { nome: String(nome).trim(), ricevuti: 0, dati: 0, rettifiche: 0, giacenza: 0 });
    return m.get(k);
  };
  for (const o of ordini) {
    for (const x of o.omaggiRicevuti || []) { const v = voce(x.nome); if (v) v.ricevuti += Number(x.qta) || 0; }
    for (const r of o.righe || []) for (const x of r.omaggiDati || []) { const v = voce(x.nome); if (v) v.dati += Number(x.qta) || 0; }
  }
  for (const mv of movimenti) { const v = voce(mv.nome); if (v) v.rettifiche += Number(mv.qta) || 0; }
  for (const v of m.values()) v.giacenza = v.ricevuti - v.dati + v.rettifiche;
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}

// ---------- Clienti da ricontattare ----------
// Date sempre in UTC: nessuno slittamento di un giorno per il fuso orario
const giorniTra = (a, b) => Math.round((Date.parse(b + "T00:00Z") - Date.parse(a + "T00:00Z")) / 86400000);
const piuGiorni = (iso, g) => new Date(Date.parse(iso + "T00:00Z") + Number(g) * 86400000).toISOString().slice(0, 10);
const nomiStorico = (r) => String(r.clientiStorico || "").split(",").map(chiave).filter(Boolean);

export function daRicontattare(clienti, ordini, oggi, giorniDefault = 60) {
  const out = [];
  for (const c of clienti) {
    const k = chiave(c.nome);
    const acquisti = [];
    for (const o of ordini) for (const r of o.righe || []) {
      if (r.clienteId === c.id || (r.clienteId === STORICO && nomiStorico(r).includes(k))) acquisti.push({ o, r });
    }
    if (!acquisti.length) continue;
    const ultimoAcquisto = acquisti.map(x => x.o.data).filter(Boolean).sort().pop();
    const contatto = c.ultimoContatto || "";
    const riferimento = [ultimoAcquisto, contatto].sort().pop();

    // 1) promemoria di riacquisto su un prodotto (es. crema che finisce in 60 giorni)
    const scaduti = acquisti.filter(({ o, r }) => r.riacquistoGiorni && o.data)
      .map(({ o, r }) => ({ prodotti: r.prodotti, scadenza: piuGiorni(o.data, r.riacquistoGiorni), data: o.data }))
      .filter(x => x.scadenza <= oggi && x.data >= ultimoAcquisto && contatto < x.scadenza);
    if (scaduti.length) {
      out.push({ cliente: c, tipo: "riacquisto", prodotti: scaduti.map(x => x.prodotti).join(", "),
        giorni: giorniTra(ultimoAcquisto, oggi), ultimoAcquisto });
      continue;
    }
    // 2) nessun acquisto/contatto da troppo tempo
    if (giorniDefault > 0 && piuGiorni(riferimento, giorniDefault) <= oggi) {
      out.push({ cliente: c, tipo: "inattivo", giorni: giorniTra(ultimoAcquisto, oggi), ultimoAcquisto });
    }
  }
  return out.sort((a, b) => b.giorni - a.giorni);
}

// ---------- WhatsApp ----------
export function linkWhatsApp(telefono, testo) {
  let n = String(telefono || "").replace(/[^\d+]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  else if (n.startsWith("00")) n = n.slice(2);
  else if (n && /^3\d{8,9}$/.test(n)) n = "39" + n; // cellulare italiano senza prefisso
  return `https://wa.me/${n}?text=${encodeURIComponent(testo)}`;
}

export const euro = (n) => (Number(n) || 0).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
