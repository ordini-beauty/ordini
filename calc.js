// Calcoli puri (nessuna dipendenza da Firebase), testabili a parte.
export const IO = "__io";           // cliente speciale: acquisti personali
export const SCORTA = "__scorta";   // prodotti comprati per rivenderli (bundle): soldi anticipati
export const STORICO = "__storico"; // righe importate con più clienti insieme

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const chiave = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const somma = (righe) => righe.reduce((s, r) => s + (Number(r.importo) || 0), 0);
const haValore = (v) => v !== undefined && v !== null && v !== "";
export const isSpeciale = (id) => id === IO || id === SCORTA;

// ---------- Articoli e scorta ----------
// Articolo: { nome, prezzo (di vendita, a pezzo), qta, fonte?: "scorta", costo?: costo a pezzo se preso dalla scorta }
const qtaDi = (a) => Math.max(1, Number(a.qta) || 1);
export const articoliDi = (r) => r.articoli || [];
const costoPezzo = (a) => a.costo ?? a._costo ?? 0;     // _costo: calcolato quando non era noto al momento della vendita
const daScortaRiga = (r) => {
  const arr = articoliDi(r).filter(a => a.fonte === "scorta");
  return { valore: arr.reduce((s, a) => s + (Number(a.prezzo) || 0) * qtaDi(a), 0),
           costo: arr.reduce((s, a) => s + costoPezzo(a) * qtaDi(a), 0) };
};

// ---------- Guadagno per ordine ----------
// "costo" = quanto pagato a Yves Rocher, solo per i prodotti ordinati ora.
// I prodotti presi dalla scorta portano il loro costo con sé (articolo.costo).
// Vecchi ordini "daScorta" (versione 8): costo = costo dei prodotti presi dalla scorta.
export function calcolaOrdine(o) {
  const righe = o.righe || [];
  const costo = Number(o.costo) || 0;
  const fatturato = somma(righe);
  const isRiga = (id) => (r) => r.clienteId === id;
  const valoreIo = somma(righe.filter(isRiga(IO)));
  const valoreScortaTot = somma(righe.filter(isRiga(SCORTA)));
  const venditaClienti = fatturato - valoreIo - valoreScortaTot;

  // Parte di ogni riga presa dalla scorta (non pagata ora a Yves Rocher)
  const ds = righe.map(r => r.clienteId === SCORTA ? { valore: 0, costo: 0 } : daScortaRiga(r));
  const valoreDaScorta = ds.reduce((s, x) => s + x.valore, 0);
  const costoDaScortaIo = righe.reduce((s, r, i) => s + (r.clienteId === IO ? ds[i].costo : 0), 0);
  const costoDaScortaClienti = righe.reduce((s, r, i) => s + (!isSpeciale(r.clienteId) ? ds[i].costo : 0), 0);

  const legacy = !!o.daScorta;
  const fatturatoYR = legacy ? 0 : fatturato - valoreDaScorta;          // valore dei prodotti ordinati ora
  const valoreIoYR = valoreIo - righe.reduce((s, r, i) => s + (r.clienteId === IO ? ds[i].valore : 0), 0);
  const valoreScorta = legacy ? 0 : valoreScortaTot;

  const quotaIoYR = haValore(o.costoIoManuale) ? Number(o.costoIoManuale) : (fatturatoYR > 0 ? costo * valoreIoYR / fatturatoYR : 0);
  const quotaScorta = haValore(o.costoScortaManuale) ? Number(o.costoScortaManuale) : (fatturatoYR > 0 ? costo * valoreScorta / fatturatoYR : 0);
  const quotaIo = legacy ? (fatturato > 0 ? costo * valoreIo / fatturato : 0) : quotaIoYR + costoDaScortaIo;
  const costoClienti = legacy ? costo - quotaIo : costo - quotaIoYR - quotaScorta + costoDaScortaClienti;
  const usatoScorta = legacy ? costo : costoDaScortaIo + costoDaScortaClienti;

  const clienti = righe.filter(r => !isSpeciale(r.clienteId));
  const incassato = somma(clienti.filter(r => r.pagato));
  const tuttoDaScorta = !legacy && fatturato > 0 && valoreScortaTot === 0 && Math.abs(fatturato - valoreDaScorta) < 0.005;

  return {
    fatturato: r2(fatturato),
    valoreIo: r2(valoreIo),
    valoreScorta: r2(valoreScorta),
    valoreDaScorta: r2(valoreDaScorta),
    tuttoDaScorta,
    venditaClienti: r2(venditaClienti),
    quotaIo: r2(quotaIo),
    quotaIoManuale: haValore(o.costoIoManuale),
    quotaScorta: r2(quotaScorta),          // soldi messi in scorta con quest'ordine
    costoClienti: r2(costoClienti),
    pagatoYR: r2(legacy ? 0 : costo),      // uscito davvero verso Yves Rocher
    usatoScorta: r2(usatoScorta),          // costo dei prodotti presi dalla scorta
    incassato: r2(incassato),
    daIncassare: r2(venditaClienti - incassato),
    guadagnoAtteso: r2(venditaClienti - costoClienti), // quando tutti avranno pagato
    guadagnoReale: r2(incassato - costoClienti),       // con quanto incassato finora
    daConsegnare: righe.filter(r => !r.consegnato).length
  };
}

export function riepilogoPeriodo(ordini) {
  const t = { ordini: 0, fatturato: 0, venditaClienti: 0, costo: 0, quotaIo: 0, quotaScorta: 0, usatoScorta: 0,
              incassato: 0, daIncassare: 0, guadagnoAtteso: 0, guadagnoReale: 0 };
  for (const o of ordini) {
    const c = calcolaOrdine(o);
    t.ordini++;
    t.fatturato += c.fatturato; t.venditaClienti += c.venditaClienti; t.costo += c.pagatoYR;
    t.quotaIo += c.quotaIo; t.quotaScorta += c.quotaScorta; t.usatoScorta += c.usatoScorta;
    t.incassato += c.incassato; t.daIncassare += c.daIncassare;
    t.guadagnoAtteso += c.guadagnoAtteso; t.guadagnoReale += c.guadagnoReale;
  }
  for (const k of Object.keys(t)) if (k !== "ordini") t[k] = r2(t[k]);
  return t;
}

// Guadagno mese per mese, dal più recente
export function guadagnoPerMese(ordini) {
  const mesi = new Map();
  for (const o of ordini) {
    const m = (o.data || "").slice(0, 7); if (!m) continue;
    if (!mesi.has(m)) mesi.set(m, []);
    mesi.get(m).push(o);
  }
  return [...mesi.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([mese, lista]) => ({ mese, ...riepilogoPeriodo(lista) }));
}

// Scorta: due tipi di prodotti da rivendere
//  - pezzi (bundle di prodotti uguali): contati a pezzi, costo medio a pezzo
//  - confezioni miste (calendario dell'avvento, cofanetti): articolo con confezione:true e prezzo = valore a catalogo
//    dei prodotti dentro. I prodotti si vendono singolarmente (articolo.da = nome confezione) e il loro costo è
//    prezzo di vendita × (costo confezione / valore confezione).
export function inventarioScorta(ordini) {
  const m = new Map();
  const pezzo = (nome) => {
    const k = "p:" + chiave(nome);
    if (!m.has(k)) m.set(k, { tipo: "pezzi", nome: String(nome).trim(), comprati: 0, venduti: 0, costoComprati: 0, costoVenduti: 0, prezzo: 0, costoNoto: true });
    return m.get(k);
  };
  const confezione = (nome) => {
    const k = "c:" + chiave(nome);
    if (!m.has(k)) m.set(k, { tipo: "confezione", nome: String(nome).trim(), comprati: 0, valore: 0, costoComprati: 0, valoreVenduto: 0, costoVenduti: 0, venduti: 0, costoNoto: true });
    return m.get(k);
  };
  for (const o of ordini) {
    const c = calcolaOrdine(o);
    const rapporto = c.valoreScorta > 0 ? c.quotaScorta / c.valoreScorta : 0;
    const costoNoto = Number(o.costo) > 0 || haValore(o.costoScortaManuale);
    for (const r of o.righe || []) {
      if (r.clienteId === SCORTA && !o.daScorta) {
        // sconto della riga ripartito sui pezzi
        const lordo = articoliDi(r).reduce((s, a) => s + (Number(a.prezzo) || 0) * qtaDi(a), 0);
        const fattoreSconto = lordo > 0 ? (Number(r.importo) || 0) / lordo : 1;
        for (const a of articoliDi(r)) {
          const q = qtaDi(a), costo = (Number(a.prezzo) || 0) * fattoreSconto * rapporto * q;
          if (a.confezione) {
            const v = confezione(a.nome);
            v.comprati += q; v.valore += (Number(a.prezzo) || 0) * q; v.costoComprati += costo;
            if (!costoNoto) v.costoNoto = false;
          } else {
            const v = pezzo(a.nome);
            v.comprati += q; v.costoComprati += costo; v.prezzo = Number(a.prezzo) || v.prezzo;
            if (!costoNoto) v.costoNoto = false;
          }
        }
      } else {
        for (const a of articoliDi(r)) if (a.fonte === "scorta") {
          if (a.da) { const v = confezione(a.da); v.venduti += qtaDi(a); v.valoreVenduto += (Number(a.prezzo) || 0) * qtaDi(a); v.costoVenduti += costoPezzo(a) * qtaDi(a); }
          else { const v = pezzo(a.nome); v.venduti += qtaDi(a); v.costoVenduti += costoPezzo(a) * qtaDi(a); }
        }
      }
    }
  }
  return [...m.values()].map(v => v.tipo === "confezione"
      ? { ...v, rapportoCosto: v.valore > 0 ? v.costoComprati / v.valore : 0,
          valoreResiduo: r2(v.valore - v.valoreVenduto), rimasti: v.valore - v.valoreVenduto > 0.01 ? 1 : 0,
          valoreRimasto: r2(v.costoComprati - v.costoVenduti) }
      : { ...v, rimasti: v.comprati - v.venduti,
          costoPezzo: v.comprati > 0 ? r2(v.costoComprati / v.comprati) : 0,
          valoreRimasto: r2(v.costoComprati - v.costoVenduti) })
    .sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === "confezione" ? -1 : 1) || a.nome.localeCompare(b.nome, "it"));
}

// Costo di un prodotto venduto da una confezione mista, dato il prezzo di vendita
export const costoDaConfezione = (inv, nomeConfezione, prezzo) => {
  const v = inv.find(x => x.tipo === "confezione" && chiave(x.nome) === chiave(nomeConfezione));
  return v && v.costoNoto ? r2(prezzo * v.rapportoCosto) : null;
};

// Completa il costo dei pezzi venduti dalla scorta quando al momento della vendita non era noto
export function completaCostiScorta(ordini) {
  const inv = inventarioScorta(ordini.map(o => ({ ...o })));
  const pezzi = new Map(inv.filter(v => v.tipo === "pezzi").map(v => [chiave(v.nome), v]));
  for (const o of ordini) for (const r of o.righe || []) for (const a of articoliDi(r)) {
    if (a.fonte !== "scorta" || (a.costo !== null && a.costo !== undefined)) continue;
    if (a.da) { const v = inv.find(x => x.tipo === "confezione" && chiave(x.nome) === chiave(a.da)); a._costo = v ? r2((Number(a.prezzo) || 0) * v.rapportoCosto) : 0; }
    else a._costo = pezzi.get(chiave(a.nome))?.costoPezzo || 0;
  }
  return ordini;
}

// Scorta in euro: soldi anticipati in prodotti da rivendere, meno quelli già rivenduti
export function statoScorta(ordini) {
  let anticipato = 0, usato = 0;
  for (const o of ordini) { const c = calcolaOrdine(o); anticipato += c.quotaScorta; usato += c.usatoScorta; }
  const pezzi = inventarioScorta(ordini);
  return { anticipato: r2(anticipato), usato: r2(usato), saldo: r2(anticipato - usato), pezzi,
    pezziRimasti: pezzi.filter(v => v.tipo === "pezzi").reduce((s, v) => s + Math.max(0, v.rimasti), 0),
    confezioniAperte: pezzi.filter(v => v.tipo === "confezione" && v.rimasti > 0).length };
}

// ---------- Omaggi e campioncini: giacenza e storia ----------
// ricevuti (dagli ordini) − dati alle clienti ± movimenti manuali.
// Ogni voce ha anche "eventi": da quale ordine sono arrivati e a chi sono andati.
export function giacenzaOmaggi(ordini, movimenti = []) {
  const m = new Map();
  const voce = (nome) => {
    const k = chiave(nome); if (!k) return null;
    if (!m.has(k)) m.set(k, { nome: String(nome).trim(), ricevuti: 0, dati: 0, rettifiche: 0, giacenza: 0, eventi: [] });
    return m.get(k);
  };
  for (const o of ordini) {
    for (const x of o.omaggiRicevuti || []) {
      const v = voce(x.nome); if (!v) continue;
      v.ricevuti += Number(x.qta) || 0;
      v.eventi.push({ data: o.data, tipo: "arrivati", qta: Number(x.qta) || 0, ordineId: o.id });
    }
    for (const r of o.righe || []) for (const x of r.omaggiDati || []) {
      const v = voce(x.nome); if (!v) continue;
      v.dati += Number(x.qta) || 0;
      v.eventi.push({ data: o.data, tipo: "regalati", qta: Number(x.qta) || 0, ordineId: o.id, clienteId: r.clienteId });
    }
  }
  for (const mv of movimenti) {
    const v = voce(mv.nome); if (!v) continue;
    v.rettifiche += Number(mv.qta) || 0;
    v.eventi.push({ data: mv.data, tipo: "mano", qta: Number(mv.qta) || 0, movimentoId: mv.id, nota: mv.nota });
  }
  for (const v of m.values()) {
    v.giacenza = v.ricevuti - v.dati + v.rettifiche;
    v.eventi.sort((a, b) => String(b.data || "").localeCompare(String(a.data || "")));
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}

// Omaggi di un singolo ordine: arrivati e regalati (per cliente)
export function omaggiOrdine(o) {
  const arrivati = (o.omaggiRicevuti || []).filter(x => x.nome);
  const regalati = (o.righe || []).filter(r => (r.omaggiDati || []).length).map(r => ({ clienteId: r.clienteId, riga: r, omaggi: r.omaggiDati }));
  const n = (arr) => arr.reduce((s, x) => s + (Number(x.qta) || 0), 0);
  return { arrivati, regalati, nArrivati: n(arrivati), nRegalati: regalati.reduce((s, g) => s + n(g.omaggi), 0) };
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
    if (!ultimoAcquisto) continue; // ordini senza data: non posso calcolare niente
    const contatto = c.ultimoContatto || "";
    const riferimento = [ultimoAcquisto, contatto].filter(Boolean).sort().pop();

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
