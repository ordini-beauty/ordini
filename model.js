// Ordini Beauty — modello "acquisti + vendite" (funzioni pure, senza Firebase)
//
// ACQUISTO (ordine a Yves Rocher)
//   { id, data, numeroOrdine, note, arrivato, arrivatoIl, spedizione, omaggiRicevuti:[{nome,qta}],
//     prodotti: [{ id, nome, qta, costo /*a pezzo*/, confezione?: { valore /*catalogo a confezione*/ } }] }
// VENDITA (ordine di una cliente, oppure "Per me")
//   { id, data, clienteId (o IO o STORICO + clientiStorico), pagato, pagatoIl, note, sconto,
//     omaggiDati:[{nome,qta}], riacquistoGiorni,
//     righe: [{ id, nome, qta, prezzo /*a pezzo*/, consegnato,
//               fonte?: { acquistoId, prodottoId }   // prodotto acquistato (magazzino)
//               costo?: numero                       // costo a pezzo noto senza fonte (solo dati convertiti)
//            }] }
//   Riga senza fonte e senza costo = "da ordinare" (richiesta della cliente non ancora acquistata).
import { IO, SCORTA, STORICO, chiave, calcolaOrdine } from "./calc.js?v=24";

export { IO, STORICO, chiave };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const qtaDi = (x) => Math.max(1, Number(x?.qta) || 1);
export const isMia = (v) => v.clienteId === IO;
const chiaveFonte = (f) => f ? `${f.acquistoId}:${f.prodottoId}` : null;

// ---------- Acquisti ----------
export function totaleAcquisto(a) {
  return r2((a.prodotti || []).reduce((s, p) => s + (Number(p.costo) || 0) * qtaDi(p), 0) + (Number(a.spedizione) || 0));
}

// Indice dei prodotti acquistati con il costo a pezzo comprensivo della spedizione (ripartita sul valore)
export function indiceProdotti(acquisti) {
  const m = new Map();
  for (const a of acquisti) {
    const base = (a.prodotti || []).reduce((s, p) => s + (Number(p.costo) || 0) * qtaDi(p), 0);
    const sped = Number(a.spedizione) || 0;
    for (const p of a.prodotti || []) {
      const costo = Number(p.costo) || 0;
      const costoPezzo = costo + (base > 0 ? sped * costo / base : 0);
      m.set(`${a.id}:${p.id}`, { acquisto: a, prodotto: p, costoPezzo,
        valoreConf: p.confezione ? (Number(p.confezione.valore) || 0) * qtaDi(p) : 0 });
    }
  }
  return m;
}

// ---------- Costi delle righe vendute ----------
// restituisce il costo totale della riga, oppure null se non si sa ancora (da ordinare)
export function costoRiga(riga, indice) {
  const k = chiaveFonte(riga.fonte);
  if (k && indice.has(k)) {
    const x = indice.get(k);
    if (x.prodotto.confezione) {
      const tot = x.costoPezzo * qtaDi(x.prodotto);
      return x.valoreConf > 0 ? (Number(riga.prezzo) || 0) * qtaDi(riga) * tot / x.valoreConf : 0;
    }
    return x.costoPezzo * qtaDi(riga);
  }
  if (riga.costo !== undefined && riga.costo !== null) return (Number(riga.costo) || 0) * qtaDi(riga);
  return null;
}
export const daOrdinare = (riga, indice) => costoRiga(riga, indice) === null;

export function calcolaVendita(v, indice) {
  const righe = v.righe || [];
  const lordo = righe.reduce((s, r) => s + (Number(r.prezzo) || 0) * qtaDi(r), 0);
  const totale = Math.max(0, lordo - (Number(v.sconto) || 0));
  const fattore = lordo > 0 ? totale / lordo : 1;   // lo sconto si ripartisce sulle righe
  let ricavoNoto = 0, costo = 0, nDaOrdinare = 0;
  for (const r of righe) {
    const c = costoRiga(r, indice);
    if (c === null) { nDaOrdinare++; continue; }
    costo += c; ricavoNoto += (Number(r.prezzo) || 0) * qtaDi(r) * fattore;
  }
  const mia = isMia(v);
  return {
    totale: r2(totale), costo: r2(costo), nDaOrdinare,
    guadagno: mia ? 0 : r2(ricavoNoto - costo),
    daIncassare: mia || v.pagato ? 0 : r2(totale),
    incassato: mia || !v.pagato ? 0 : r2(totale),
    spesoPerMe: mia ? r2(costo) : 0,
    daConsegnare: righe.filter(r => !r.consegnato).length
  };
}

// ---------- Magazzino ----------
// quantità (o valore per le confezioni) già assegnate a vendite, per prodotto acquistato
export function usoProdotti(vendite, escludiVenditaId) {
  const uso = new Map();
  for (const v of vendite) {
    if (escludiVenditaId && v.id === escludiVenditaId) continue;
    for (const r of v.righe || []) {
      const k = chiaveFonte(r.fonte); if (!k) continue;
      const u = uso.get(k) || { qta: 0, valore: 0 };
      u.qta += qtaDi(r); u.valore += (Number(r.prezzo) || 0) * qtaDi(r);
      uso.set(k, u);
    }
  }
  return uso;
}

// Prodotti ancora disponibili, raggruppati per nome (i più vecchi prima)
export function magazzino(acquisti, vendite, opz = {}) {
  const indice = indiceProdotti(acquisti);
  const uso = usoProdotti(vendite, opz.escludiVenditaId);
  const extra = opz.usoExtra || new Map();   // righe della vendita in modifica
  const gruppi = new Map();
  const ordinati = [...acquisti].sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));
  for (const a of ordinati) for (const p of a.prodotti || []) {
    const k = `${a.id}:${p.id}`, x = indice.get(k);
    const u = uso.get(k) || { qta: 0, valore: 0 }, e = extra.get(k) || { qta: 0, valore: 0 };
    const conf = !!p.confezione;
    const disp = conf ? x.valoreConf - u.valore - e.valore : qtaDi(p) - u.qta - e.qta;
    const g = chiave(p.nome) + (conf ? "#conf" : "");
    if (!gruppi.has(g)) gruppi.set(g, { nome: p.nome, confezione: conf, disponibili: 0, costoTot: 0, fonti: [], inArrivo: 0 });
    const G = gruppi.get(g);
    if (disp > 0.004) {
      G.disponibili += disp;
      G.costoTot += conf ? (x.valoreConf > 0 ? disp * x.costoPezzo * qtaDi(p) / x.valoreConf : 0) : disp * x.costoPezzo;
      G.fonti.push({ acquistoId: a.id, prodottoId: p.id, disponibili: disp, costoPezzo: x.costoPezzo, arrivato: a.arrivato !== false,
        rapporto: conf && x.valoreConf > 0 ? x.costoPezzo * qtaDi(p) / x.valoreConf : null });
      if (a.arrivato === false) G.inArrivo += disp;
    }
  }
  return [...gruppi.values()].filter(g => g.disponibili > 0.004)
    .map(g => ({ ...g, disponibili: g.confezione ? r2(g.disponibili) : Math.round(g.disponibili), costoTot: r2(g.costoTot) }))
    .sort((a, b) => (b.confezione - a.confezione) || a.nome.localeCompare(b.nome, "it"));
}
export const valoreMagazzino = (acquisti, vendite) => r2(magazzino(acquisti, vendite).reduce((s, g) => s + g.costoTot, 0));

// ---------- Riepiloghi ----------
const nelPeriodo = (data, prefisso) => !prefisso || String(data || "").startsWith(prefisso);
export function riepilogo(acquisti, vendite, prefisso) {
  const indice = indiceProdotti(acquisti);
  const t = { spesoAcquisti: 0, nAcquisti: 0, venduto: 0, incassato: 0, daIncassare: 0, spesoPerMe: 0, guadagno: 0, costoVenduto: 0, nVendite: 0 };
  for (const a of acquisti) if (nelPeriodo(a.data, prefisso)) { t.spesoAcquisti += totaleAcquisto(a); t.nAcquisti++; }
  for (const v of vendite) {
    const c = calcolaVendita(v, indice);
    if (!isMia(v) && v.pagato && nelPeriodo(v.pagatoIl || v.data, prefisso)) t.incassato += c.totale;
    if (!nelPeriodo(v.data, prefisso)) continue;
    if (isMia(v)) { t.spesoPerMe += c.spesoPerMe; continue; }
    t.nVendite++; t.venduto += c.totale; t.daIncassare += c.daIncassare; t.guadagno += c.guadagno; t.costoVenduto += c.costo;
  }
  for (const k of Object.keys(t)) if (!k.startsWith("n")) t[k] = r2(t[k]);
  return t;
}

export function mesiPresenti(acquisti, vendite) {
  const s = new Set();
  for (const x of [...acquisti, ...vendite]) if (x.data) s.add(String(x.data).slice(0, 7));
  for (const v of vendite) if (v.pagato && v.pagatoIl) s.add(String(v.pagatoIl).slice(0, 7));
  return [...s].sort().reverse();
}

// ---------- Adattatori per le funzioni esistenti (ricontatti, omaggi) ----------
// vendite → forma "ordini" { id, data, righe:[{clienteId, clientiStorico, prodotti, riacquistoGiorni, omaggiDati}] }
export const venditeComeOrdini = (vendite) => vendite.map(v => ({ id: v.id, data: v.data, omaggiRicevuti: [],
  righe: [{ clienteId: v.clienteId, clientiStorico: v.clientiStorico, riacquistoGiorni: v.riacquistoGiorni,
    prodotti: (v.righe || []).map(r => r.nome).join(", "), omaggiDati: v.omaggiDati || [] }] }));
export const acquistiComeOrdini = (acquisti) => acquisti.map(a => ({ id: a.id, data: a.data, omaggiRicevuti: a.omaggiRicevuti || [], righe: [] }));

// ---------- Conversione dai vecchi ordini (versione 15 e precedenti) ----------
// Ogni vecchio ordine diventa un acquisto (i prodotti comprati con il loro costo) e una vendita per persona.
// Il costo dell'ordine è ripartito con le stesse regole di prima, così il guadagno resta identico.
export function convertiOrdini(ordini, nuovoId) {
  const acquisti = [], vendite = [];
  const scortaPerNome = new Map();       // prodotti comprati "da rivendere", per collegare le vendite successive
  const ordinati = [...ordini].sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));
  const qta = (a) => Math.max(1, Number(a.qta) || 1);
  const artDi = (r) => r.articoli?.length ? r.articoli : (r.prodotti || r.importo ? [{ nome: r.prodotti || "Prodotti", prezzo: Number(r.importo) || 0, qta: 1 }] : []);

  for (const o of ordinati) {
    const c = calcolaOrdine(o);
    const righe = o.righe || [];
    // valore di ogni articolo comprato ora (sconto di riga ripartito)
    const voci = [];
    for (const r of righe) {
      const arts = artDi(r);
      const lordo = arts.reduce((s, a) => s + (Number(a.prezzo) || 0) * qta(a), 0);
      const f = lordo > 0 ? (Number(r.importo) || 0) / lordo : 1;
      for (const a of arts) voci.push({ r, a, valore: (Number(a.prezzo) || 0) * qta(a) * f, daScorta: a.fonte === "scorta" });
    }
    const gruppo = (r) => r.clienteId === IO ? "io" : r.clienteId === SCORTA ? "scorta" : "clienti";
    const costoDaScortaDi = (g) => voci.filter(x => x.daScorta && gruppo(x.r) === g).reduce((s, x) => s + (x.a.costo ?? x.a._costo ?? 0) * qta(x.a), 0);
    const budget = o.daScorta ? { clienti: 0, io: 0, scorta: 0 } : {
      clienti: c.costoClienti - costoDaScortaDi("clienti"),
      io: c.quotaIo - costoDaScortaDi("io"),
      scorta: c.quotaScorta
    };
    const valoreGruppo = { clienti: 0, io: 0, scorta: 0 };
    for (const x of voci) if (!x.daScorta) valoreGruppo[gruppo(x.r)] += x.valore;

    const acq = { id: nuovoId(), migratoDa: o.id, data: o.data, numeroOrdine: "", note: o.note || "", arrivato: o.arrivato !== false,
      arrivatoIl: o.arrivatoIl || null, spedizione: 0, omaggiRicevuti: o.omaggiRicevuti || [], omaggiNote: o.omaggiNote || "", prodotti: [] };
    for (const x of voci) {
      if (x.daScorta || o.daScorta) continue;
      const g = gruppo(x.r);
      const costoTot = valoreGruppo[g] > 0 ? budget[g] * x.valore / valoreGruppo[g] : 0;
      const p = { id: nuovoId(), nome: x.a.nome, qta: qta(x.a), costo: Math.round(costoTot / qta(x.a) * 10000) / 10000 };
      if (x.a.confezione) p.confezione = { valore: Number(x.a.prezzo) || 0 };
      acq.prodotti.push(p);
      x.prodotto = p;
      if (g === "scorta") {
        const k = x.a.confezione ? "c:" + chiave(x.a.nome) : chiave(x.a.nome);
        if (!scortaPerNome.has(k)) scortaPerNome.set(k, []);
        scortaPerNome.get(k).push({ acquistoId: acq.id, prodottoId: p.id });
      }
    }
    if (acq.prodotti.length || acq.omaggiRicevuti.length) acquisti.push(acq);

    // legacy "dalla scorta" (versione 8): costo noto ripartito sulle righe
    const valoreTot = voci.reduce((s, x) => s + x.valore, 0);

    for (const r of righe) {
      if (r.clienteId === SCORTA) continue;
      const mieVoci = voci.filter(x => x.r === r);
      const v = { id: nuovoId(), migrataDa: o.id, data: o.data, clienteId: r.clienteId, pagato: r.clienteId === IO ? true : !!r.pagato,
        pagatoIl: r.pagato || r.clienteId === IO ? o.data : null, note: "", sconto: 0, omaggiDati: r.omaggiDati || [],
        riacquistoGiorni: r.riacquistoGiorni || null, righe: [] };
      if (r.clienteId === STORICO) v.clientiStorico = r.clientiStorico || "";
      if (r.omaggio) v.omaggioVecchio = r.omaggio;
      // lo sconto della vecchia riga diventa lo sconto della vendita; i prezzi restano quelli scritti
      const lordo = mieVoci.reduce((t, x) => t + (Number(x.a.prezzo) || 0) * qta(x.a), 0);
      if (r.clienteId !== IO) v.sconto = Math.max(0, Math.round((lordo - (Number(r.importo) || 0)) * 100) / 100);
      for (const x of mieVoci) {
        const riga = { id: nuovoId(), nome: x.a.nome, qta: qta(x.a), consegnato: typeof x.a.consegnato === "boolean" ? x.a.consegnato : !!r.consegnato,
          prezzo: Number(x.a.prezzo) || 0 };
        if (x.prodotto) riga.fonte = { acquistoId: acq.id, prodottoId: x.prodotto.id };
        else if (x.daScorta) {
          const k = x.a.da ? "c:" + chiave(x.a.da) : chiave(x.a.nome);
          const f = scortaPerNome.get(k)?.[0];
          if (f) riga.fonte = f; else riga.costo = x.a.costo ?? x.a._costo ?? 0;
        } else if (o.daScorta) riga.costo = valoreTot > 0 ? (Number(o.costo) || 0) * x.valore / valoreTot / qta(x.a) : 0;
        if (r.clienteId === IO) riga.valoreCatalogo = riga.prezzo;   // per me: conta il costo, non il prezzo
        v.righe.push(riga);
      }
      if (v.righe.length) vendite.push(v);
    }
  }
  // per le vendite "per me" il prezzo è il costo
  const indice = indiceProdotti(acquisti);
  for (const v of vendite) if (v.clienteId === IO) for (const riga of v.righe) {
    const c = costoRiga(riga, indice); riga.prezzo = c === null ? riga.prezzo : Math.round(c / qtaDi(riga) * 10000) / 10000;
  }
  return { acquisti, vendite };
}
