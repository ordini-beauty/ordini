import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  addDoc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { giacenzaOmaggi, daRicontattare, linkWhatsApp, euro, chiave, IO, STORICO, completaCostiScorta } from "./calc.js?v=24";
import { convertiFoglio, parseOmaggi, dividiProdotti, abbinaSigla } from "./importa.js?v=24";
import { qtaDi, isMia, totaleAcquisto, indiceProdotti, costoRiga, calcolaVendita, magazzino, valoreMagazzino,
  riepilogo, mesiPresenti, venditeComeOrdini, acquistiComeOrdini, convertiOrdini } from "./model.js?v=24";

// ---------- Configurazione ----------
// Il file viene letto come testo: funziona con o senza "export", con le righe import di Firebase e con i commenti.
async function leggiConfig() {
  const r = await fetch("firebase-config.js", { cache: "no-store" });
  if (!r.ok) throw new Error(`firebase-config.js non trovato (errore ${r.status}). Deve stare nella stessa cartella di index.html.`);
  const testo = (await r.text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const cfg = {};
  for (const m of testo.matchAll(/["']?(apiKey|authDomain|projectId|storageBucket|messagingSenderId|appId|measurementId)["']?\s*:\s*["'`]([^"'`]+)["'`]/g)) cfg[m[1]] = m[2].trim();
  if (!cfg.apiKey || !cfg.projectId || !cfg.appId) throw new Error("In firebase-config.js non trovo apiKey, projectId e appId. Incolla il blocco di configurazione copiato dalla console Firebase.");
  if (/INSERISCI/.test(JSON.stringify(cfg))) throw new Error("firebase-config.js contiene ancora i valori di esempio “INSERISCI…”: incolla la configurazione del tuo progetto Firebase.");
  return cfg;
}
const firebaseConfig = await leggiConfig();
window.__appAvviata = true;

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Cache locale: funziona anche offline e sincronizza quando torna la rete
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

// ---------- Stato ----------
let uid = null;
let clienti = [], acquisti = [], vendite = [], catalogo = [], movimenti = [], ordiniVecchi = [];
let impostazioni = { giorniRicontatto: 60, ultimoBackup: null };
let caricati = new Set();
let unsub = [];
let vista = "home";
let meseSel = oggi().slice(0, 7);
let cercaClienti = "";
let vistaAcquisti = "ordini";     // ordini | magazzino | omaggi
let vistaOmaggi = "ordini";
let filtroVendite = "tutte";
let selezione = null;            // { tipo: "acquisti" | "vendite", ids: Set } — scelta di più ordini da eliminare

// ---------- Utilità ----------
const col = (nome) => collection(db, "utenti", uid, nome);
const docImpostazioni = () => doc(db, "utenti", uid, "impostazioni", "generale");
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numIt = (v) => { const n = Number(String(v ?? "").replace(/\s|€/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const inIt = (v) => v === null || v === undefined || v === "" ? "" : (typeof v === "number" ? (Math.round(v * 100) / 100).toFixed(2) : String(v)).replace(".", ",");
const nuovoId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
function oggi() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const dataIt = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString("it-IT") : "";
const dataLunga = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString("it-IT", { day: "numeric", month: "long" }) : "";
const giorniDa = (iso) => iso ? Math.round((Date.parse(oggi() + "T00:00Z") - Date.parse(iso + "T00:00Z")) / 86400000) : 0;
const slug = (s) => chiave(s).replace(/[^a-z0-9àèéìòù]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || nuovoId();
const somma = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const plurale = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;
const pulisci = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith("_") ? undefined : v)));   // niente campi interni/undefined

const nomeClienteId = (id, v) => id === IO ? "Per me" : id === STORICO ? (v?.clientiStorico || "Più clienti") : (clienti.find(c => c.id === id)?.nome || "Cliente eliminata");
const nomeVendita = (v) => nomeClienteId(v.clienteId, v);
const primoNome = (c) => String(c?.nome || "").split(" ")[0];
const nomeArt = (r) => `${qtaDi(r) > 1 ? qtaDi(r) + "× " : ""}${r.nome}`;
const elencoRighe = (righe) => righe.map(nomeArt).join(", ");
const acquistoDi = (id) => acquisti.find(a => a.id === id);
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const compleannoTesto = (mmdd) => { if (!mmdd) return ""; const [m, d] = mmdd.split("-").map(Number); return `${d} ${MESI[m - 1]}`; };
function prossimoCompleanno(mmdd) {
  if (!/^\d{2}-\d{2}$/.test(mmdd || "")) return null;
  const oggiIso = oggi(), anno = Number(oggiIso.slice(0, 4));
  let data = `${anno}-${mmdd}`;
  if (data < oggiIso) data = `${anno + 1}-${mmdd}`;
  return { data, giorni: Math.round((Date.parse(data + "T00:00Z") - Date.parse(oggiIso + "T00:00Z")) / 86400000) };
}
// una riga è "da ordinare" se non è collegata a un acquisto e non ha un costo noto
const rigaDaOrdinare = (r) => !r.fonte && (r.costo === undefined || r.costo === null);
const rigaArrivata = (r) => !r.fonte ? !rigaDaOrdinare(r) : acquistoDi(r.fonte.acquistoId)?.arrivato !== false;

// Colore fisso per ogni persona (avatar)
const PALETTE = ["c-pink", "c-orange", "c-purple", "c-blue", "c-green", "c-gold"];
const coloreDi = (nome) => PALETTE[[...chiave(nome)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % PALETTE.length];
const iniziali = (nome) => String(nome || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("") || "?";
const avatar = (nome, isIo) => `<div class="avatar ${isIo ? "c-pink" : coloreDi(nome)}">${isIo ? "Io" : esc(iniziali(nome))}</div>`;
const avatarVendita = (v) => avatar(nomeVendita(v), isMia(v));

// ---------- Avvisi (con Annulla) ----------
let toastTimer;
function avviso(testo, annulla) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(testo)}</span>${annulla ? `<button id="toast-undo">Annulla</button>` : ""}`;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), annulla ? 6000 : 2500);
  $("#toast-undo")?.addEventListener("click", async () => { t.classList.add("hidden"); await annulla(); avviso("Annullato"); });
}

// ---------- Accesso ----------
onAuthStateChanged(auth, (user) => {
  unsub.forEach(u => u()); unsub = []; caricati = new Set();
  if (!user) { uid = null; $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); return; }
  uid = user.uid;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  const ascolta = (nome, cb) => unsub.push(onSnapshot(col(nome), s => { cb(s.docs.map(d => ({ id: d.id, ...d.data() }))); caricati.add(nome); render(); }));
  const perData = (a, b) => String(b.data || "").localeCompare(String(a.data || ""));
  ascolta("clienti", d => clienti = d.sort((a, b) => a.nome.localeCompare(b.nome, "it")));
  ascolta("acquisti", d => acquisti = d.sort(perData));
  ascolta("vendite", d => vendite = d.sort(perData));
  ascolta("ordini", d => ordiniVecchi = d);
  ascolta("catalogo", d => catalogo = d);
  ascolta("movimentiOmaggi", d => movimenti = d);
  unsub.push(onSnapshot(docImpostazioni(), s => { impostazioni = { giorniRicontatto: 60, ultimoBackup: null, ...(s.data() || {}) }; caricati.add("impostazioni"); render(); }));
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await signInWithEmailAndPassword(auth, $("#login-email").value, $("#login-pass").value); $("#login-error").textContent = ""; }
  catch { $("#login-error").textContent = "Email o password non corrette."; }
});
$("#btn-register").addEventListener("click", async () => {
  if (!$("#login-email").value || !$("#login-pass").value) { $("#login-error").textContent = "Scrivi email e password, poi tocca di nuovo qui."; return; }
  try { await createUserWithEmailAndPassword(auth, $("#login-email").value, $("#login-pass").value); }
  catch (err) { $("#login-error").textContent = err.code === "auth/weak-password" ? "La password deve avere almeno 6 caratteri." :
    err.code === "auth/email-already-in-use" ? "Questa email ha già un account: tocca Entra." : "Impossibile creare l'account."; }
});
$("#btn-reset").addEventListener("click", async () => {
  const email = $("#login-email").value.trim();
  if (!email) { $("#login-error").textContent = "Scrivi prima la tua email."; return; }
  try { await sendPasswordResetEmail(auth, email); $("#login-error").textContent = "Ti ho mandato un'email per cambiare la password."; }
  catch { $("#login-error").textContent = "Impossibile inviare l'email."; }
});

// ---------- Navigazione ----------
const VISTE = {
  home:     { titolo: "Oggi", fab: ["Nuovo", () => sceltaNuovo()] },
  acquisti: { titolo: "Acquisti", fab: ["Ordine a Yves Rocher", () => vistaAcquisti === "omaggi" ? apriNuovoOmaggio() : vistaAcquisti === "codici" ? sceltaNuovoCodice() : apriAcquisto()] },
  vendite:  { titolo: "Vendite", fab: ["Ordine di una cliente", () => apriVendita()] },
  clienti:  { titolo: "Clienti", fab: ["Nuova cliente", () => apriCliente()] },
  soldi:    { titolo: "Riepilogo", fab: null }
};
$$(".tabbar button").forEach(b => b.addEventListener("click", () => vai(b.dataset.view)));
$("#fab").addEventListener("click", () => VISTE[vista].fab?.[1]());

function vai(v) {
  vista = v; selezione = null;
  $$(".tabbar button").forEach(x => x.classList.toggle("active", x.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}

function render() {
  if (!uid) return;
  programmaNotificheTraPoco();
  const v = VISTE[vista];
  $("#view-title").textContent = v.titolo;
  $("#hello").textContent = vista === "home"
    ? "Buongiorno · " + new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" }) : "";
  $("#fab").classList.toggle("hidden", !v.fab || (vista === "acquisti" && vistaAcquisti === "magazzino") || !!selezione);
  if (v.fab) $("#fab span").textContent = vista === "acquisti" && vistaAcquisti === "omaggi" ? "Nuovo omaggio" : vista === "acquisti" && vistaAcquisti === "codici" ? "Nuovo prodotto" : v.fab[0];
  const nRich = somma(richiesteDaOrdinare(), x => x.qta);
  const tabAcq = $(".tabbar [data-view=acquisti]"); if (tabAcq) { if (nRich) tabAcq.dataset.badge = nRich; else delete tabAcq.dataset.badge; }
  if (selezione) { const esistenti = new Set((selezione.tipo === "acquisti" ? acquisti : vendite).map(x => x.id)); selezione.ids = new Set([...selezione.ids].filter(id => esistenti.has(id))); }
  if (serveConversione()) { $("#fab").classList.add("hidden"); renderConversione(); return; }
  ({ home: renderHome, acquisti: renderAcquisti, vendite: renderVendite, clienti: renderClienti, soldi: renderSoldi })[vista]();
  aggiornaSuggerimenti();
}

function sceltaNuovo() {
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Cosa vuoi segnare?", false) + `
    <div class="sh-main">
      <div class="question">Cosa vuoi segnare?</div>
      <div class="stack" style="margin-top:16px">
        <button class="big-choice c-blue" id="n-vendita"><span class="bc-ico"></span><span><b>Ordine di una cliente</b><br><small>Cosa ha preso o cosa ti ha chiesto</small></span></button>
        <button class="big-choice c-orange" id="n-acquisto"><span class="bc-ico"></span><span><b>Ordine a Yves Rocher</b><br><small>Cosa hai comprato e quanto l'hai pagato</small></span></button>
      </div>
    </div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#n-vendita").addEventListener("click", () => apriVendita());
  $("#n-acquisto").addEventListener("click", () => apriAcquisto());
  apriSheet();
}

// Suggerimenti per prodotti e omaggi
function aggiornaSuggerimenti() {
  const prodotti = new Map();
  const metti = (n) => { n = String(n || "").trim(); if (n && n.length < 60 && !prodotti.has(chiave(n))) prodotti.set(chiave(n), n); };
  catalogo.filter(p => p.tipo !== "set").forEach(p => metti(p.nome));
  acquisti.forEach(a => (a.prodotti || []).forEach(p => metti(p.nome)));
  vendite.forEach(v => (v.righe || []).forEach(r => metti(r.nome)));
  $("#dl-set").innerHTML = catalogo.filter(v => v.tipo === "set").map(v => `<option value="${esc(v.nome)}">`).join("");
  $("#dl-prodotti").innerHTML = [...prodotti.values()].sort((a, b) => a.localeCompare(b, "it")).map(n => `<option value="${esc(n)}">`).join("");
  $("#dl-omaggi").innerHTML = giacenzaOmaggi(ordiniPerOmaggi(), movimenti).map(v => `<option value="${esc(v.nome)}">`).join("");
}
const ordiniPerOmaggi = () => [...acquistiComeOrdini(acquisti), ...venditeComeOrdini(vendite)];
const voceCatalogo = (nome) => catalogo.find(x => x.tipo !== "set" && chiave(x.nome) === chiave(nome));
const voceSet = (nome) => catalogo.find(x => x.tipo === "set" && chiave(x.nome) === chiave(nome));
// Codici Yves Rocher: ogni prodotto ha un codice per l'acquisto singolo e uno per il bundle
const normCodice = (c) => String(c ?? "").replace(/\s+/g, "").toUpperCase();
const voceDaCodice = (c) => { const k = normCodice(c); if (!k) return null;
  for (const v of catalogo) { if (v.tipo === "set") { if (normCodice(v.codiceSet) === k) return { voce: v, tipo: "set" }; continue; }
    if (normCodice(v.codiceSingolo) === k) return { voce: v, tipo: "singolo" }; if (normCodice(v.codiceBundle) === k) return { voce: v, tipo: "bundle" }; }
  return null; };
const codiceDi = (nome, tipo) => { const v = voceCatalogo(nome); return (tipo === "bundle" ? v?.codiceBundle : v?.codiceSingolo) || ""; };
const pezziBundleDi = (nome) => Number(voceCatalogo(nome)?.pezziBundle) || 0;
const costoDi = (nome, tipo) => { const v = voceCatalogo(nome); return (tipo === "bundle" ? v?.costoBundle : v?.costo) ?? ""; };

// ---------- Schermata a comparsa ----------
let sheetChiudi = null;
function apriSheet() { if (!$("#sheet").open) $("#sheet").showModal(); }
function chiudiSheet(forza) {
  if (!forza && sheetChiudi && !sheetChiudi()) return;
  sheetChiudi = null; eliminaCorrente = null; $("#sheet").close();
}
$("#sheet").addEventListener("cancel", (e) => { e.preventDefault(); chiudiSheet(); });
let eliminaCorrente = null;      // azione del pulsante "Elimina" in alto (ordini esistenti)
$("#sheet-body").addEventListener("click", (e) => { if (e.target.closest("#sh-del") && eliminaCorrente) eliminaCorrente(); });
function testataSheet(titolo, indietro, passi, conElimina) {
  return `<div class="sh-head"><button id="sh-back">${indietro ? "‹ Indietro" : "✕"}</button><div class="sh-title">${esc(titolo)}</div>
    ${conElimina && eliminaCorrente ? `<button id="sh-del" class="sh-del">Elimina</button>` : `<span style="min-width:64px"></span>`}</div>
    ${passi ? `<div class="sh-steps">${[1, 2, 3].map(n => `<span class="${n <= passi ? "on" : ""}"></span>`).join("")}</div>` : ""}`;
}
const mantieniScroll = (fn) => { const y = $(".sh-main")?.scrollTop || 0; fn(); const m = $(".sh-main"); if (m) m.scrollTop = y; };

// ---------- Elenco omaggi con − + e suggerimenti (usato in acquisti e vendite) ----------
function editorOmaggi(lista, pref, suggerimenti, segnaposto) {
  const presenti = new Set(lista.map(x => chiave(x.nome)));
  const sugg = suggerimenti.filter(x => !presenti.has(chiave(x.nome))).slice(0, 12);
  return `<div class="items">${lista.map((x, i) => `<div class="item gift-item"><div class="i-name">${esc(x.nome)}</div>
      <div class="stepper"><button data-${pref}-d="${i}" data-d="-1" aria-label="Uno in meno">−</button><b>${x.qta}</b>
      <button data-${pref}-d="${i}" data-d="1" aria-label="Uno in più">＋</button></div></div>`).join("")}</div>
    ${sugg.length ? `<div class="chips small-chips" style="margin-bottom:10px">${sugg.map(x =>
      `<button class="chip gift-chip" data-${pref}-s="${esc(x.nome)}">＋ ${esc(x.nome)}${x.giacenza !== undefined ? ` <span class="muted">· ne hai ${x.giacenza}</span>` : ""}</button>`).join("")}</div>` : ""}
    <div class="two-col"><input id="${pref}-nome" list="dl-omaggi" placeholder="${segnaposto}" autocomplete="off">
      <button class="c-gold" id="${pref}-add">＋ Aggiungi</button></div>`;
}
function collegaOmaggi(lista, pref, ridisegna, segna) {
  const aggiungi = (nome) => { const e = lista.find(x => chiave(x.nome) === chiave(nome)); if (e) e.qta++; else lista.push({ nome, qta: 1 }); segna(); ridisegna(); };
  $$(`[data-${pref}-d]`).forEach(b => b.addEventListener("click", () => {
    const x = lista[+b.getAttribute(`data-${pref}-d`)]; x.qta += Number(b.dataset.d);
    if (x.qta <= 0) lista.splice(lista.indexOf(x), 1);
    segna(); ridisegna();
  }));
  $$(`[data-${pref}-s]`).forEach(b => b.addEventListener("click", () => aggiungi(b.getAttribute(`data-${pref}-s`))));
  $(`#${pref}-add`)?.addEventListener("click", () => { const n = $(`#${pref}-nome`).value.trim(); if (!n) return $(`#${pref}-nome`).focus(); aggiungi(n); });
  $(`#${pref}-nome`)?.addEventListener("keydown", (e) => { if (e.key === "Enter") $(`#${pref}-add`).click(); });
}

// ---------- WhatsApp ----------
function apriWhatsApp(cliente, testo) {
  if (!cliente?.telefono && !confirm(`Non hai il numero di ${cliente?.nome || "questa cliente"}. Apro WhatsApp e scegli tu il contatto?`)) return;
  window.open(linkWhatsApp(cliente?.telefono, testo), "_blank");
}
// ---------- Messaggi alle clienti (personalizzabili in Riepilogo → Messaggi) ----------
const MESSAGGI = [
  { k: "consegna", titolo: "Prodotti arrivati", quando: "Quando avvisi una cliente che i suoi prodotti sono arrivati", segnaposto: ["nome", "prodotti"],
    testo: "Ciao {nome}, sono arrivati i tuoi prodotti Yves Rocher: {prodotti}. Quando ci vediamo per la consegna?" },
  { k: "pagamento", titolo: "Promemoria pagamento", quando: "Quando ricordi a una cliente il saldo", segnaposto: ["nome", "importo", "prodotti"],
    testo: "Ciao {nome}, ti ricordo il saldo di {importo} per {prodotti}. Fammi sapere quando ti è comodo, grazie." },
  { k: "auguri", titolo: "Auguri di compleanno", quando: "Il giorno del compleanno", segnaposto: ["nome"],
    testo: "Tanti auguri {nome}! Ti auguro una splendida giornata. Ho un piccolo pensiero per te: quando ci vediamo?" },
  { k: "riacquisto", titolo: "Prodotto in esaurimento", quando: "Quando un prodotto che ha preso sta per finire", segnaposto: ["nome", "prodotti"],
    testo: "Ciao {nome}, come ti trovi con {prodotti}? Dovrebbe essere quasi finito: vuoi che te lo riordini?" },
  { k: "catalogo", titolo: "Nuovo catalogo", quando: "Per le clienti che non senti da un po' e per il messaggio a tutte", segnaposto: ["nome"],
    testo: "Ciao {nome}, è uscito il nuovo catalogo Yves Rocher con diverse novità e promozioni. Vuoi che ti mandi qualche proposta?" },
  { k: "promozioni", titolo: "Promozioni", quando: "Messaggio a tutte le clienti", segnaposto: ["nome"],
    testo: "Ciao {nome}, in questi giorni Yves Rocher ha delle promozioni interessanti. Se ti serve qualcosa dimmelo e te lo ordino." },
  { k: "ordine", titolo: "Sto per ordinare", quando: "Messaggio a tutte le clienti prima di fare l'ordine", segnaposto: ["nome"],
    testo: "Ciao {nome}, nei prossimi giorni faccio l'ordine Yves Rocher: se ti serve qualcosa scrivimi pure." },
  { k: "libero", titolo: "Messaggio libero", quando: "Il pulsante “Scrivile” nella scheda cliente", segnaposto: ["nome"], testo: "Ciao {nome}, " }
];
const testoMessaggio = (k) => (impostazioni.messaggi || {})[k] ?? MESSAGGI.find(m => m.k === k).testo;
const componi = (k, valori) => testoMessaggio(k).replace(/\{(nome|prodotti|importo)\}/g, (_, x) => valori[x] ?? "");
const msgConsegna = (c, righe) => componi("consegna", { nome: primoNome(c), prodotti: elencoRighe(righe) });
const msgPagamento = (c, importo, righe) => componi("pagamento", { nome: primoNome(c), importo: euro(importo), prodotti: elencoRighe(righe) });
const msgAuguri = (c) => componi("auguri", { nome: primoNome(c) });
const msgRicontatto = (x) => x.tipo === "riacquisto" ? componi("riacquisto", { nome: primoNome(x.cliente), prodotti: x.prodotti }) : componi("catalogo", { nome: primoNome(x.cliente) });

function apriMessaggi() {
  const bozze = Object.fromEntries(MESSAGGI.map(m => [m.k, testoMessaggio(m.k)]));
  let modificato = false;
  sheetChiudi = () => !modificato || confirm("Uscire senza salvare i messaggi?");
  const esempio = { nome: "Giulia", prodotti: "Crema mani, Siero viso", importo: euro(38.5) };
  $("#sheet-body").innerHTML = testataSheet("Messaggi alle clienti", false) + `
    <div class="sh-main">
      <div class="question">Messaggi alle clienti</div>
      <p class="q-hint">Scrivili come li scriveresti tu. Le parole tra parentesi graffe le riempio io: tocca un riquadro per inserirle dove c'è il cursore.</p>
      ${MESSAGGI.map(m => `<div class="msg-card" data-m="${m.k}">
        <div class="row"><b>${m.titolo}</b><button class="link small-link" data-ripristina="${m.k}">Ripristina</button></div>
        <div class="hint" style="margin:0 0 8px">${m.quando}</div>
        <textarea data-testo="${m.k}" rows="3">${esc(bozze[m.k])}</textarea>
        <div class="chips small-chips" style="margin-top:8px">${m.segnaposto.map(x => `<button class="chip tag-chip" data-ins="${m.k}" data-x="${x}">{${x}}</button>`).join("")}</div>
        <div class="anteprima" data-ante="${m.k}"></div></div>`).join("")}
    </div>
    <div class="sh-foot"><button class="big primary" id="msg-salva">Salva i messaggi</button></div>`;
  const ante = (k) => { $(`[data-ante="${k}"]`).textContent = bozze[k].replace(/\{(nome|prodotti|importo)\}/g, (_, x) => esempio[x]); };
  MESSAGGI.forEach(m => ante(m.k));
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $$("[data-testo]").forEach(t => t.addEventListener("input", () => { bozze[t.dataset.testo] = t.value; modificato = true; ante(t.dataset.testo); }));
  $$("[data-ins]").forEach(b => b.addEventListener("click", () => {
    const t = $(`[data-testo="${b.dataset.ins}"]`), ins = `{${b.dataset.x}}`;
    const i = t.selectionStart ?? t.value.length, j = t.selectionEnd ?? i;
    t.value = t.value.slice(0, i) + ins + t.value.slice(j); t.focus(); t.setSelectionRange(i + ins.length, i + ins.length);
    t.dispatchEvent(new Event("input"));
  }));
  $$("[data-ripristina]").forEach(b => b.addEventListener("click", () => {
    const m = MESSAGGI.find(x => x.k === b.dataset.ripristina), t = $(`[data-testo="${m.k}"]`);
    t.value = m.testo; t.dispatchEvent(new Event("input"));
  }));
  $("#msg-salva").addEventListener("click", async () => {
    const salvati = {};
    for (const m of MESSAGGI) if (bozze[m.k].trim() && bozze[m.k] !== m.testo) salvati[m.k] = bozze[m.k];
    await setDoc(docImpostazioni(), { messaggi: salvati }, { merge: true });
    chiudiSheet(true); avviso("Messaggi salvati");
  });
  apriSheet();
}

// ---------- Selezione di più ordini (per eliminarli insieme) ----------
const inSelezione = (tipo) => selezione?.tipo === tipo;
const casella = (tipo, id) => inSelezione(tipo) ? `<span class="sel-box ${selezione.ids.has(id) ? "on" : ""}">${selezione.ids.has(id) ? "✓" : ""}</span>` : "";
const intestazioneLista = (tipo, n) => n ? `<div class="lista-testa">${inSelezione(tipo)
  ? `<button class="link" data-sel-tutti="${tipo}">Seleziona tutti</button><button class="link" data-sel-fine>Fine</button>`
  : `<span></span><button class="link" data-sel-inizia="${tipo}">Seleziona</button>`}</div>` : "";
const barraSelezione = (tipo) => inSelezione(tipo) ? `<div class="barra-sel"><span>${plurale(selezione.ids.size, "selezionato", "selezionati")}</span>
  <button class="danger-pieno" data-sel-elimina ${selezione.ids.size ? "" : "disabled"}>Elimina</button></div>` : "";
function collegaSelezione(tipo, tuttiIds, apri) {
  $$("[data-sel-inizia]").forEach(b => b.addEventListener("click", () => { selezione = { tipo, ids: new Set() }; render(); }));
  $$("[data-sel-fine]").forEach(b => b.addEventListener("click", () => { selezione = null; render(); }));
  $$("[data-sel-tutti]").forEach(b => b.addEventListener("click", () => {
    const tutti = tuttiIds.every(id => selezione.ids.has(id)); selezione.ids = tutti ? new Set() : new Set(tuttiIds); render(); }));
  $$(`[data-${tipo === "acquisti" ? "acq" : "ven"}]`).forEach(el => el.addEventListener("click", () => {
    const id = el.dataset[tipo === "acquisti" ? "acq" : "ven"];
    if (!inSelezione(tipo)) return apri(id);
    selezione.ids.has(id) ? selezione.ids.delete(id) : selezione.ids.add(id); render();
  }));
  $("[data-sel-elimina]")?.addEventListener("click", () => tipo === "acquisti" ? eliminaAcquisti([...selezione.ids]) : eliminaVendite([...selezione.ids]));
}
async function scriviMolte(mod, messaggio) {
  if (mod.length <= 450) return scriviConAnnulla(mod, messaggio);
  await applicaModifiche(mod); avviso(messaggio);
}
async function eliminaAcquisti(ids) {
  const set = new Set(ids);
  const collegate = vendite.filter(v => (v.righe || []).some(r => r.fonte && set.has(r.fonte.acquistoId)));
  if (!confirm(`Eliminare ${plurale(ids.length, "ordine a Yves Rocher", "ordini a Yves Rocher")}?` +
    (collegate.length ? `\n\nAlcuni prodotti erano già assegnati a ${plurale(collegate.length, "vendita", "vendite")}: torneranno tra le cose “da ordinare”.` : "") +
    `\n\nPotrai annullare subito dopo.`)) return;
  const mod = acquisti.filter(a => set.has(a.id)).map(a => ({ ref: refAcquisto(a.id), prima: senzaId(a), dopo: null }));
  for (const v of collegate) mod.push({ ref: refVendita(v.id), prima: senzaId(v),
    dopo: { ...senzaId(v), righe: v.righe.map(r => { if (r.fonte && set.has(r.fonte.acquistoId)) { const { fonte, ...x } = r; return x; } return r; }) } });
  selezione = null;
  await scriviMolte(mod, `${plurale(ids.length, "ordine eliminato", "ordini eliminati")}`);
}
async function eliminaVendite(ids) {
  const set = new Set(ids);
  if (!confirm(`Eliminare ${plurale(ids.length, "vendita", "vendite")}? I prodotti presi dal magazzino tornano disponibili.\n\nPotrai annullare subito dopo.`)) return;
  selezione = null;
  await scriviMolte(vendite.filter(v => set.has(v.id)).map(v => ({ ref: refVendita(v.id), prima: senzaId(v), dopo: null })),
    `${plurale(ids.length, "vendita eliminata", "vendite eliminate")}`);
}

// ---------- Scritture con Annulla ----------
async function scriviConAnnulla(modifiche, messaggio) {
  // modifiche: [{ ref, prima (oggetto o null), dopo (oggetto o null) }]
  const b = writeBatch(db);
  modifiche.forEach(m => m.dopo ? b.set(m.ref, pulisci(m.dopo)) : b.delete(m.ref));
  await b.commit();
  if (messaggio) avviso(messaggio, async () => {
    const u = writeBatch(db);
    modifiche.forEach(m => m.prima ? u.set(m.ref, pulisci(m.prima)) : u.delete(m.ref));
    await u.commit();
  });
}
const senzaId = ({ id, ...resto }) => resto;
const refVendita = (id) => doc(col("vendite"), id);
const refAcquisto = (id) => doc(col("acquisti"), id);
// Soglia di spesa mensile per gli acquisti (0 = spenta)
const sogliaAcquisti = () => impostazioni.sogliaAcquisti === undefined || impostazioni.sogliaAcquisti === null ? 250 : Number(impostazioni.sogliaAcquisti) || 0;
const spesoMese = (mese, escludiId, extra = 0) => Math.round((somma(acquisti.filter(a => String(a.data || "").startsWith(mese) && a.id !== escludiId), totaleAcquisto) + extra) * 100) / 100;
function bannerSoglia(mese = oggi().slice(0, 7)) {
  const soglia = sogliaAcquisti(); if (!soglia) return "";
  const speso = spesoMese(mese), perc = speso / soglia;
  if (perc < 0.8) return "";
  const nome = new Date(mese + "-01T00:00").toLocaleDateString("it-IT", { month: "long" });
  return `<div class="banner ${perc >= 1 ? "rosso" : ""}" style="display:block">${perc >= 1 ? "" : ""} ${perc >= 1 ? `Hai superato la soglia: a ${nome} hai speso <b>${euro(speso)}</b> in acquisti (soglia ${euro(soglia)})`
    : `A ${nome} hai già speso <b>${euro(speso)}</b> in acquisti: la soglia è ${euro(soglia)}`}
    <div class="progress" style="margin-top:8px"><span style="width:${Math.min(100, Math.round(perc * 100))}%;background:${perc >= 1 ? "var(--red)" : "var(--gold)"}"></span></div></div>`;
}
// ---------- Livelli: in base a quanto vende alle clienti nel periodo ----------
const LIVELLI_BASE = { periodo: "trimestre", soglie: { base: 150, expert: 750, prestige: 1000 } };
const prefLivelli = () => { const l = impostazioni.livelli || {}; return { periodo: "trimestre", soglie: { ...LIVELLI_BASE.soglie, ...(l.soglie || {}) } }; };
const NOMI_PERIODO = { mese: "questo mese", trimestre: "questo trimestre", anno: "quest'anno", sempre: "da sempre" };
function periodoDi(dataIso, periodo) {        // chiave del periodo che contiene la data
  const d = String(dataIso || ""), y = d.slice(0, 4), m = Number(d.slice(5, 7));
  return periodo === "mese" ? d.slice(0, 7) : periodo === "trimestre" ? `${y}-T${Math.ceil(m / 3)}` : periodo === "anno" ? y : "sempre";
}
function nomePeriodo(chiaveP, periodo) {
  if (periodo === "mese") return new Date(chiaveP + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  if (periodo === "trimestre") { const [y, t] = chiaveP.split("-T"); return `${["gennaio–marzo", "aprile–giugno", "luglio–settembre", "ottobre–dicembre"][t - 1]} ${y}`; }
  return periodo === "anno" ? chiaveP : "da sempre";
}
function fineTrimestre(chiaveT) {          // "2026-T4" -> "2026-12-31"
  const [y, t] = chiaveT.split("-T").map(Number);
  return new Date(Date.UTC(y, t * 3, 0)).toISOString().slice(0, 10);
}
const giorniTra = (a, b) => Math.round((Date.parse(b + "T00:00Z") - Date.parse(a + "T00:00Z")) / 86400000);
const VICINO = 0.25;   // "vicina" al livello dopo = le manca meno del 25% della soglia
function statoLivello(dataRif = oggi()) {
  const { periodo, soglie } = prefLivelli(), k = periodoDi(dataRif, periodo);
  const indice = indiceProdotti(acquisti);   // tutti gli ordini (clienti e "Per me") per data dell'ordine, pagati o no
  const valore = (v) => { const c = calcolaVendita(v, indice); return isMia(v) ? Math.max(c.totale, c.spesoPerMe) : c.totale; };
  const speso = Math.round(somma(vendite.filter(v => periodoDi(v.data, periodo) === k), valore) * 100) / 100;
  const scala = [["Base", soglie.base, "lv-base"], ["Expert", soglie.expert, "lv-expert"], ["Prestige", soglie.prestige, "lv-prestige"]];
  let i = -1; scala.forEach(([, da], j) => { if (speso >= da) i = j; });
  const prossimo = scala[i + 1] || null;
  return { periodo, chiave: k, nomePeriodo: nomePeriodo(k, periodo), speso, scala, indice: i,
    nome: i >= 0 ? scala[i][0] : null, classe: i >= 0 ? scala[i][2] : "lv-nessuno", prossimo, mancano: prossimo ? Math.round((prossimo[1] - speso) * 100) / 100 : 0,
    fine: fineTrimestre(k), corrente: k === periodoDi(oggi(), periodo), giorniFine: giorniTra(oggi(), fineTrimestre(k)) };
}
// Chi e cosa rende di più nel trimestre (per guadagno)
function classificaTrimestre(dataRif) {
  const k = periodoDi(dataRif, "trimestre"), indice = indiceProdotti(acquisti), cl = new Map(), pr = new Map();
  for (const v of vendite) {
    if (isMia(v) || periodoDi(v.data, "trimestre") !== k) continue;
    const c = calcolaVendita(v, indice);
    if (v.clienteId !== STORICO) { const x = cl.get(v.clienteId) || { nome: nomeVendita(v), venduto: 0, guadagno: 0, n: 0 };
      x.venduto += c.totale; x.guadagno += c.guadagno; x.n++; cl.set(v.clienteId, x); }
    const lordo = somma(v.righe || [], r => (Number(r.prezzo) || 0) * qtaDi(r)), f = lordo > 0 ? c.totale / lordo : 1;
    for (const r of v.righe || []) {
      const nome = String(r.nome || "").trim(); if (!nome) continue;
      const kk = nome.toLowerCase(), x = pr.get(kk) || { nome, pezzi: 0, venduto: 0, guadagno: 0, senzaCosto: false };
      const ric = (Number(r.prezzo) || 0) * qtaDi(r) * f, co = costoRiga(r, indice);
      x.pezzi += qtaDi(r); x.venduto += ric; if (co === null) x.senzaCosto = true; else x.guadagno += ric - co;
      pr.set(kk, x);
    }
  }
  const ord = (m) => [...m.values()].sort((a, b) => b.guadagno - a.guadagno || b.venduto - a.venduto).slice(0, 5);
  return { nome: nomePeriodo(k, "trimestre"), clienti: ord(cl), prodotti: ord(pr) };
}
function htmlClassifica(dataRif) {
  const C = classificaTrimestre(dataRif);
  if (!C.clienti.length && !C.prodotti.length) return "";
  const riga = (i, nome, sub, val) => `<div class="top-riga"><span class="top-pos">${i + 1}</span><span class="top-nome"><b>${esc(nome)}</b><span class="sub">${sub}</span></span><b class="num top-val">${val}</b></div>`;
  const gColore = (g) => `<span style="color:${g >= 0 ? "var(--green)" : "var(--red)"}">${euro(Math.round(g * 100) / 100)}</span>`;
  return `<div class="section"><h2>I migliori</h2><span class="count c-blue" style="text-transform:capitalize">${esc(C.nome)}</span></div>
    ${C.clienti.length ? `<div class="card"><div class="livello-eti">Clienti · per guadagno</div>
      ${C.clienti.map((x, i) => riga(i, x.nome, `${x.n} ${x.n === 1 ? "ordine" : "ordini"} · venduto ${euro(Math.round(x.venduto * 100) / 100)}`, gColore(x.guadagno))).join("")}</div>` : ""}
    ${C.prodotti.length ? `<div class="card"><div class="livello-eti">Prodotti · per guadagno</div>
      ${C.prodotti.map((x, i) => riga(i, x.nome, `${x.pezzi} ${x.pezzi === 1 ? "pezzo" : "pezzi"} · venduto ${euro(Math.round(x.venduto * 100) / 100)}${x.senzaCosto ? " · in parte da ordinare" : ""}`, gColore(x.guadagno))).join("")}
      <div class="hint" style="margin-top:8px">Il guadagno conta solo i pezzi di cui conosci già il costo.</div></div>` : ""}`;
}
function htmlLivello(dataRif, compatto) {
  const L = statoLivello(dataRif), [b, e, p] = L.scala.map(x => x[1]);
  const vicina = L.corrente && L.prossimo && L.giorniFine <= 21 && L.mancano <= L.prossimo[1] * VICINO;
  const riemp = (da, a) => Math.max(0, Math.min(100, Math.round((L.speso - da) / (a - da) * 100)));
  const segmenti = [riemp(b, e), riemp(e, p), riemp(p, p * 1.5)];
  return `<div class="card livello-card ${L.classe}">
    <div class="livello-testa"><div><div class="livello-eti">Livello · ${esc(L.nomePeriodo)}</div>
      <div class="livello-nome">${L.nome || "Nessun livello"}</div></div>
      <div style="text-align:right"><div class="livello-eti">Vendite</div><div class="num" style="font:600 22px var(--serif)">${euro(L.speso)}</div></div></div>
    <div class="livello-scala">${segmenti.map(x => `<div><span style="width:${x}%"></span></div>`).join("")}</div>
    <div class="livello-tacche">${L.scala.map(([n, da], j) => `<span class="${j <= L.indice ? "on" : ""}">${n} · ${euro(da).replace(",00", "")}</span>`).join("")}</div>
    ${vicina
      ? `<div class="livello-avviso">${L.giorniFine === 0 ? "Oggi è l'ultimo giorno del trimestre" : `Mancano ${L.giorniFine} ${L.giorniFine === 1 ? "giorno" : "giorni"} alla fine del trimestre`}: con <b>${euro(L.mancano)}</b> di vendite arrivi a ${L.prossimo[0]}.</div>`
      : L.corrente && !compatto ? `<div class="hint" style="margin-top:8px">Il trimestre finisce il ${dataLunga(L.fine)} (tra ${L.giorniFine} giorni).</div>` : ""}
    ${compatto || vicina ? "" : `<div class="hint" style="margin-top:10px">${L.prossimo ? `Mancano <b>${euro(L.mancano)}</b> di vendite per arrivare al livello ${L.prossimo[0]}.` : "Hai raggiunto il livello più alto."}</div>`}
    ${compatto && L.prossimo && !vicina ? `<div class="hint" style="margin-top:8px">Mancano ${euro(L.mancano)} al livello ${L.prossimo[0]}</div>` : ""}
  </div>`;
}

// Richieste delle clienti non ancora ordinate, raggruppate per prodotto
function richiesteDaOrdinare() {
  const m = new Map();
  for (const v of vendite) for (const r of v.righe || []) if (rigaDaOrdinare(r)) {
    const k = chiave(r.nome);
    if (!m.has(k)) m.set(k, { nome: r.nome, qta: 0, chi: [] });
    const g = m.get(k); g.qta += qtaDi(r); g.chi.push(nomeVendita(v).split(" ")[0] + (qtaDi(r) > 1 ? ` (${qtaDi(r)})` : ""));
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}
function riquadroDaOrdinare() {
  const r = richiesteDaOrdinare(); if (!r.length) return "";
  return `<div class="card da-ordinare-box"><div class="row"><h3>Da ordinare</h3><span class="count c-blue">${somma(r, x => x.qta)}</span></div>
    <div class="sub" style="margin-bottom:8px">Le cose che ti hanno chiesto le clienti e che non hai ancora ordinato.</div>
    ${r.map(x => { const cod = codiceDi(x.nome, "singolo"); return `<div class="money-row"><span><b>${x.qta > 1 ? x.qta + "× " : ""}${esc(x.nome)}</b><br><span class="muted" style="font-size:14px">per ${esc(x.chi.join(", "))}</span></span>
      ${cod ? `<span class="cod-tag">${esc(cod)}</span>` : `<span class="cod-tag manca">senza codice</span>`}</div>`; }).join("")}
    <div class="actions"><button class="primary" data-ordina-ora>Ordinale a Yves Rocher</button></div></div>`;
}
const ricontatti = () => daRicontattare(clienti, venditeComeOrdini(vendite), oggi(), Number(impostazioni.giorniRicontatto) || 0);
const venditeCliente = (c) => {
  const k = chiave(c.nome);
  return vendite.filter(v => v.clienteId === c.id || (v.clienteId === STORICO && String(v.clientiStorico || "").split(",").map(chiave).includes(k)));
};

// =====================================================================
// ACQUISTI (ordini a Yves Rocher)
// =====================================================================
function renderAcquisti() {
  let h = `<div class="segmented seg4">${[["ordini", "", "Ordini"], ["magazzino", "", "Magazzino"], ["codici", "", "Codici"], ["omaggi", "", "Omaggi"]]
    .map(([k, i, t]) => `<button data-va="${k}" class="${vistaAcquisti === k ? "on" : ""}"><span>${i}</span>${t}</button>`).join("")}</div>`;
  if (vistaAcquisti === "ordini") h += bannerSoglia() + riquadroDaOrdinare() + htmlListaAcquisti();
  else if (vistaAcquisti === "magazzino") h += htmlMagazzino();
  else if (vistaAcquisti === "codici") h += htmlCodici();
  else h += htmlOmaggi();
  $("#view").innerHTML = h;
  $$("[data-va]").forEach(b => b.addEventListener("click", () => { vistaAcquisti = b.dataset.va; selezione = null; render(); }));
  if (vistaAcquisti === "ordini") collegaSelezione("acquisti", acquisti.map(a => a.id), (id) => apriAcquisto(acquistoDi(id)));
  $("[data-ordina-ora]")?.addEventListener("click", () => apriAcquisto(null, { richieste: true }));
  if (vistaAcquisti === "magazzino") $$("[data-vendi]").forEach(b => b.addEventListener("click", () => {
    const g = magazzino(acquisti, vendite)[+b.dataset.vendi]; apriVendita(null, { prodotto: g });
  }));
  if (vistaAcquisti === "omaggi") collegaVistaOmaggi();
  if (vistaAcquisti === "codici") collegaCodici();
}

function assegnatiAcquisto(a) {
  const tot = somma(a.prodotti || [], p => p.confezione ? 0 : qtaDi(p));
  let usati = 0;
  for (const v of vendite) for (const r of v.righe || []) if (r.fonte?.acquistoId === a.id && !a.prodotti.find(p => p.id === r.fonte.prodottoId)?.confezione) usati += qtaDi(r);
  return { tot, usati };
}

function htmlListaAcquisti() {
  if (!acquisti.length) return `<div class="empty"><div class="e-ico"></div><b>Nessun ordine a Yves Rocher</b><br>Tocca “Ordine a Yves Rocher” per segnare cosa hai comprato.</div>`;
  let h = intestazioneLista("acquisti", acquisti.length), meseCorr = "";
  for (const a of acquisti) {
    const m = String(a.data || "").slice(0, 7);
    if (m !== meseCorr) { meseCorr = m; h += `<div class="section"><h2 style="text-transform:capitalize">${new Date(m + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" })}</h2></div>`; }
    const { tot, usati } = assegnatiAcquisto(a);
    h += `<div class="card b-orange tap ${inSelezione("acquisti") && selezione.ids.has(a.id) ? "scelta" : ""}" data-acq="${a.id}">
      <div class="row"><h3>${casella("acquisti", a.id)}${dataLunga(a.data)}${a.numeroOrdine ? ` <span class="muted" style="font-weight:500;font-size:15px">· n° ${esc(a.numeroOrdine)}</span>` : ""}</h3>
        <span class="amount num">${euro(totaleAcquisto(a))}</span></div>
      <div class="sub">${esc((a.prodotti || []).map(p => `${qtaDi(p) > 1 ? qtaDi(p) + "× " : ""}${p.nome}`).join(", ")) || "Nessun prodotto"}</div>
      ${a.arrivato === false ? `<span class="badge c-blue">In arrivo da ${plurale(giorniDa(a.data), "giorno", "giorni")}</span>` : `<span class="badge c-green">✓ Arrivato</span>`}
      ${tot ? `<span class="badge ${usati >= tot ? "c-green" : "c-gold"}">${usati >= tot ? "✓ Tutto assegnato" : `${tot - usati} di ${tot} in magazzino`}</span>` : ""}
      ${(a.omaggiRicevuti || []).length ? `<span class="badge c-gold">Omaggi ${somma(a.omaggiRicevuti, x => x.qta)}</span>` : ""}
      ${(a.prodotti || []).some(p => p.codice) ? `<span class="badge c-blue">codici</span>` : ""}
    </div>`;
  }
  return h + barraSelezione("acquisti");
}

// =====================================================================
// CODICI PRODOTTO (catalogo)
// =====================================================================
let cercaCodici = "";
function htmlCodici() {
  const q = chiave(cercaCodici), qc = normCodice(cercaCodici);
  const trova = (v) => !q || chiave(v.nome).includes(q) || [v.codiceSingolo, v.codiceBundle, v.codiceSet].some(c => normCodice(c).includes(qc)) || (v.componenti || []).some(c => chiave(c.nome).includes(q));
  const tutti = [...catalogo].filter(v => v.nome).sort((a, b) => a.nome.localeCompare(b.nome, "it")).filter(trova);
  const lista = tutti.filter(v => v.tipo !== "set"), sets = tutti.filter(v => v.tipo === "set");
  const conCodice = catalogo.filter(v => v.codiceSingolo || v.codiceBundle || v.codiceSet).length;
  let h = `<p class="section-hint" style="margin-top:0">I codici per ordinare su Yves Rocher. Si salvano da soli quando li scrivi in un ordine; qui puoi aggiungerli o correggerli.</p>
    <input type="search" id="cerca-cod" class="search" placeholder="Cerca per nome o codice" value="${esc(cercaCodici)}">
    <div class="hint" style="margin:-6px 2px 12px">${plurale(conCodice, "prodotto ha", "prodotti hanno")} un codice salvato</div>`;
  if (sets.length) {
    h += `<div class="section"><h2>Set</h2></div>`;
    for (const v of sets) h += `<div class="card tap cod-card" data-cat="${esc(v.id)}"><div class="row"><h3><span class="tag-set">Set</span>${esc(v.nome)}</h3>
        ${v.costoSet ? `<span class="muted num" style="font-size:14px">costo ${euro(v.costoSet)}</span>` : ""}</div>
      <div class="sub">${esc((v.componenti || []).map(c => c.nome).join(" + "))}</div>
      <div class="cod-coppia uno"><button class="cod-pill ${v.codiceSet ? "" : "manca"}" data-copia="${esc(v.codiceSet || "")}"><small>Codice del set</small><b>${esc(v.codiceSet || "—")}</b></button></div></div>`;
    if (lista.length) h += `<div class="section"><h2>Prodotti</h2></div>`;
  }
  if (!lista.length && !sets.length) return h + `<div class="empty"><div class="e-ico"></div><b>${q ? "Nessun prodotto trovato" : "Nessun codice ancora"}</b><br>Tocca “Nuovo prodotto” o scrivi i codici quando fai un ordine.</div>`;
  for (const v of lista) {
    h += `<div class="card tap cod-card" data-cat="${esc(v.id)}"><div class="row"><h3>${esc(v.nome)}</h3>${v.prezzo ? `<span class="muted num" style="font-size:14px">vendi a ${euro(v.prezzo)}</span>` : ""}</div>
      <div class="cod-coppia">
        <button class="cod-pill ${v.codiceSingolo ? "" : "manca"}" data-copia="${esc(v.codiceSingolo || "")}"><small>Singolo</small><b>${esc(v.codiceSingolo || "—")}</b></button>
        <button class="cod-pill ${v.codiceBundle ? "" : "manca"}" data-copia="${esc(v.codiceBundle || "")}"><small>Bundle${v.pezziBundle ? ` · ${v.pezziBundle} pz` : ""}</small><b>${esc(v.codiceBundle || "—")}</b></button>
      </div></div>`;
  }
  return h;
}
function collegaCodici() {
  $("#cerca-cod")?.addEventListener("input", (e) => { cercaCodici = e.target.value; const pos = e.target.selectionStart; render(); const i = $("#cerca-cod"); i.focus(); i.setSelectionRange(pos, pos); });
  $$("[data-copia]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation(); const c = b.dataset.copia;
    if (!c) { const v = catalogo.find(x => x.id === b.closest("[data-cat]").dataset.cat); v?.tipo === "set" ? apriSetCatalogo(v) : apriProdottoCatalogo(v); return; }
    try { await navigator.clipboard.writeText(c); avviso(`Codice ${c} copiato`); } catch { alert(c); }
  }));
  $$("[data-cat]").forEach(el => el.addEventListener("click", () => { const v = catalogo.find(x => x.id === el.dataset.cat); v?.tipo === "set" ? apriSetCatalogo(v) : apriProdottoCatalogo(v); }));
}
function sceltaNuovoCodice() {
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Aggiungi", false) + `<div class="sh-main"><div class="question">Cosa vuoi aggiungere?</div>
    <div class="stack" style="margin-top:16px">
      <button class="big-choice" id="nc-prod"><span><b>Un prodotto</b><br><small>Con il codice singolo e quello del bundle</small></span></button>
      <button class="big-choice" id="nc-set"><span><b>Un set</b><br><small>Più prodotti diversi venduti insieme a un prezzo più basso</small></span></button></div></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#nc-prod").addEventListener("click", () => apriProdottoCatalogo());
  $("#nc-set").addEventListener("click", () => apriSetCatalogo());
  apriSheet();
}

function apriSetCatalogo(v) {
  const comps = (v?.componenti || []).map(c => ({ ...c }));
  while (comps.length < 2) comps.push({ nome: "", valore: "" });
  sheetChiudi = null;
  const disegna = () => {
    $("#sheet-body").innerHTML = testataSheet(v ? "Set" : "Nuovo set", false) + `
      <div class="sh-main"><div class="question">${v ? esc(v.nome) : "Nuovo set"}</div>
        <p class="q-hint">Più prodotti diversi comprati insieme a un prezzo più basso. Quando lo ordini, il costo lo divido tra i prodotti.</p>
        <div class="yesno">
          <label style="margin-top:0">Nome del set</label><input id="sc-nome" value="${esc(v?.nome)}" placeholder="Es. Crema viso + crema mani" autocomplete="off">
          <div class="grid2"><div><label>Codice del set</label><input id="sc-cod" class="cod-in" value="${esc(v?.codiceSet || "")}" autocapitalize="characters" spellcheck="false" autocomplete="off"></div>
            <div><label>Costo del set</label><input id="sc-costo" inputmode="decimal" value="${esc(inIt(v?.costoSet ?? ""))}" placeholder="€"></div></div>
          <label>Prodotti nel set e prezzo di catalogo</label>
          ${comps.map((c, j) => `<div class="two-col" style="margin-bottom:8px"><input data-scn="${j}" list="dl-prodotti" value="${esc(c.nome)}" placeholder="Prodotto" autocomplete="off">
            <input data-scv="${j}" inputmode="decimal" value="${esc(inIt(c.valore))}" placeholder="Prezzo €"></div>`).join("")}
          <button class="link" id="sc-riga">+ Altro prodotto</button></div>
        ${v ? `<button class="danger" id="sc-del" style="width:100%;margin-top:6px">Togli dall'elenco</button>` : ""}</div>
      <div class="sh-foot"><button class="big primary" id="sc-salva">Salva</button></div>`;
    const leggi = () => { $$("[data-scn]").forEach(i => { comps[+i.dataset.scn].nome = i.value; }); $$("[data-scv]").forEach(i => { comps[+i.dataset.scv].valore = i.value; }); };
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $("#sc-riga").addEventListener("click", () => { const n = $("#sc-nome").value, k = $("#sc-cod").value, c = $("#sc-costo").value; leggi(); comps.push({ nome: "", valore: "" }); disegna();
      $("#sc-nome").value = n; $("#sc-cod").value = k; $("#sc-costo").value = c; });
    $("#sc-salva").addEventListener("click", async () => {
      leggi(); const nome = $("#sc-nome").value.trim(); if (!nome) return $("#sc-nome").focus();
      const componenti = comps.filter(c => String(c.nome).trim()).map(c => ({ nome: c.nome.trim(), valore: numIt(c.valore) }));
      if (componenti.length < 2) return avviso("Un set ha almeno due prodotti");
      const dati = { nome, tipo: "set", codiceSet: normCodice($("#sc-cod").value) || null, costoSet: numIt($("#sc-costo").value) || null, componenti };
      const id = slug("set " + nome), mod = [{ ref: doc(col("catalogo"), id), prima: v && v.id === id ? senzaId(v) : null, dopo: dati }];
      if (v && v.id !== id) mod.push({ ref: doc(col("catalogo"), v.id), prima: senzaId(v), dopo: null });
      await scriviConAnnulla(mod, v ? "Set aggiornato" : "Set aggiunto"); chiudiSheet(true);
    });
    $("#sc-del")?.addEventListener("click", async () => {
      if (!confirm(`Togliere il set “${v.nome}” dall'elenco? Gli ordini già fatti non cambiano.`)) return;
      await scriviConAnnulla([{ ref: doc(col("catalogo"), v.id), prima: senzaId(v), dopo: null }], "Tolto dall'elenco"); chiudiSheet(true);
    });
  };
  disegna(); apriSheet();
}

function apriProdottoCatalogo(v) {
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet(v ? "Prodotto" : "Nuovo prodotto", false) + `
    <div class="sh-main"><div class="question">${v ? esc(v.nome) : "Nuovo prodotto"}</div>
      <div class="yesno">
        <label style="margin-top:0">Nome del prodotto</label><input id="pc-nome" value="${esc(v?.nome)}" placeholder="Es. Crema mani pelli secche" list="dl-prodotti" autocomplete="off">
        <div class="grid2"><div><label>Codice singolo</label><input id="pc-sing" class="cod-in" value="${esc(v?.codiceSingolo || "")}" placeholder="Es. 12345" autocapitalize="characters" spellcheck="false" autocomplete="off"></div>
          <div><label>Codice bundle</label><input id="pc-bund" class="cod-in" value="${esc(v?.codiceBundle || "")}" placeholder="Es. 67890" autocapitalize="characters" spellcheck="false" autocomplete="off"></div></div>
        <label>Quanti pezzi ci sono in un bundle? (facoltativo)</label><input id="pc-pz" inputmode="numeric" value="${esc(v?.pezziBundle || "")}" placeholder="Es. 3">
        <div class="grid2"><div><label>Costo singolo</label><input id="pc-costo" inputmode="decimal" value="${esc(inIt(v?.costo ?? ""))}" placeholder="€"></div>
          <div><label>Costo a pezzo nel bundle</label><input id="pc-costob" inputmode="decimal" value="${esc(inIt(v?.costoBundle ?? ""))}" placeholder="€"></div></div>
        <label>Prezzo di vendita</label><input id="pc-prezzo" inputmode="decimal" value="${esc(inIt(v?.prezzo ?? ""))}" placeholder="€">
        <div class="hint">Costo e prezzo li uso solo per proporteli quando fai un ordine: li puoi sempre cambiare.</div>
      </div>
      ${v ? `<button class="danger" id="pc-del" style="width:100%;margin-top:6px">Togli dall'elenco</button>` : ""}
    </div>
    <div class="sh-foot"><button class="big primary" id="pc-salva">✓ Salva</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#pc-salva").addEventListener("click", async () => {
    const nome = $("#pc-nome").value.trim(); if (!nome) return $("#pc-nome").focus();
    const cs = normCodice($("#pc-sing").value), cb = normCodice($("#pc-bund").value);
    for (const [c, tipo] of [[cs, "singolo"], [cb, "bundle"]]) {
      const altro = c && voceDaCodice(c);
      if (altro && chiave(altro.voce.nome) !== chiave(v?.nome || nome) && !confirm(`Il codice ${c} è già usato per “${altro.voce.nome}” (${altro.tipo}). Lo uso lo stesso?`)) return;
    }
    const dati = { nome, codiceSingolo: cs || null, codiceBundle: cb || null, pezziBundle: parseInt($("#pc-pz").value) || null,
      costo: numIt($("#pc-costo").value) || null, costoBundle: numIt($("#pc-costob").value) || null, prezzo: numIt($("#pc-prezzo").value) || null };
    const nuovoRef = doc(col("catalogo"), slug(nome));
    const mod = [{ ref: nuovoRef, prima: v && slug(nome) === v.id ? senzaId(v) : null, dopo: { ...(v && slug(nome) === v.id ? senzaId(v) : {}), ...dati } }];
    if (v && v.id !== slug(nome)) mod.push({ ref: doc(col("catalogo"), v.id), prima: senzaId(v), dopo: null });   // nome cambiato
    await scriviConAnnulla(mod, v ? "✓ Prodotto aggiornato" : "Prodotto aggiunto");
    chiudiSheet(true);
  });
  $("#pc-del")?.addEventListener("click", async () => {
    if (!confirm(`Togliere “${v.nome}” dall'elenco dei codici? Gli ordini già fatti non cambiano.`)) return;
    await scriviConAnnulla([{ ref: doc(col("catalogo"), v.id), prima: senzaId(v), dopo: null }], "Tolto dall'elenco");
    chiudiSheet(true);
  });
  apriSheet();
}

function htmlMagazzino() {
  const g = magazzino(acquisti, vendite);
  const valore = somma(g, x => x.costoTot);
  let h = `<div class="big-money c-orange" style="padding:18px"><div style="font-weight:700">Merce in casa</div>
    <div class="v num" style="font-size:36px">${euro(valore)}</div><div style="font-size:14px;opacity:.85">al prezzo che l'hai pagata · ancora da vendere o usare</div></div>`;
  if (!g.length) return h + `<div class="empty"><div class="e-ico"></div><b>Magazzino vuoto</b><br>Qui finiscono i prodotti comprati e non ancora dati a nessuno.</div>`;
  g.forEach((x, i) => {
    h += `<div class="card b-orange"><div class="row"><div><h3>${x.confezione ? "" : ""}${esc(x.nome)}</h3>
        <div class="sub">${x.confezione ? `ancora ${euro(x.disponibili)} di prodotti dentro` : `costo ${euro(x.costoTot / x.disponibili)} a pezzo`}${x.inArrivo ? " · in arrivo" : ""}</div></div>
        <div class="amount num" style="color:var(--orange)">${x.confezione ? "" : `${x.disponibili} pz`}</div></div>
      <div class="actions"><button class="c-blue" data-vendi="${i}">Vendi o usa</button></div></div>`;
  });
  return h;
}

// ---------- Scheda ordine a Yves Rocher ----------
function apriAcquisto(a, opz = {}) {
  const acq = a ? structuredClone(a) : { data: oggi(), numeroOrdine: "", note: "", arrivato: false, spedizione: 0, omaggiRicevuti: [], prodotti: [] };
  acq.prodotti ||= []; acq.omaggiRicevuti ||= [];
  acq.prodotti.forEach(p => { p.id ||= nuovoId(); if (p.daSet) { p.tipoAcquisto = "set"; return; }
    p.tipoAcquisto ||= "singolo"; if (p.codice === undefined) p.codice = codiceDi(p.nome, p.tipoAcquisto); p._cod = { [p.tipoAcquisto]: p.codice }; });
  let nuovoSet = null;                  // modulo "Aggiungi un set" aperto
  const setsIn = () => { const m = new Map(); acq.prodotti.forEach((p, i) => { if (!p.daSet) return;
    if (!m.has(p.daSet.id)) m.set(p.daSet.id, { info: p.daSet, comps: [] }); m.get(p.daSet.id).comps.push({ p, i }); }); return [...m.values()]; };
  const compsDi = (sid) => acq.prodotti.filter(p => p.daSet?.id === sid);
  // il costo del set si divide tra i prodotti in proporzione al prezzo di catalogo
  const ricalcolaSet = (sid) => { const comps = compsDi(sid), tot = somma(comps, p => p.valoreSet), cs = numIt(comps[0]?.daSet.costoSet);
    comps.forEach(p => { p.costo = Math.round((tot > 0 ? cs * (Number(p.valoreSet) || 0) / tot : cs / comps.length) * 10000) / 10000; }); };
  const nuovoIdAcq = a?.id || nuovoId();
  let tipoNuovo = "singolo";
  let modificato = false;
  const segna = () => { modificato = true; };
  sheetChiudi = () => !modificato || confirm("Uscire senza salvare? Le modifiche andranno perse.");
  eliminaCorrente = a ? () => elimina() : null;
  const collegamenti = [];              // richieste collegate in questa sessione: { venditaId, rigaId, prodottoId }
  const scollegati = new Set();         // prodotti rimossi che erano già assegnati
  const richiesteTutte = () => vendite.flatMap(v => (v.righe || []).filter(rigaDaOrdinare).map(r => ({ v, r, k: `${v.id}:${r.id}` })))
    .filter(x => !collegamenti.some(c => c.venditaId === x.v.id && c.rigaId === x.r.id));
  const scelte = new Set(opz.richieste ? richiesteTutte().map(x => x.k) : []);
  let nuovaConf = false;
  if (opz.richieste) aggiungiRichieste();

  const assegnatiA = (pid) => {
    const nomi = [];
    if (a) for (const v of vendite) for (const r of v.righe || []) if (r.fonte && r.fonte.acquistoId === a.id && r.fonte.prodottoId === pid && !scollegati.has(pid)) nomi.push({ v, qta: qtaDi(r) });
    for (const c of collegamenti) if (c.prodottoId === pid) { const v = vendite.find(x => x.id === c.venditaId); const r = v?.righe.find(x => x.id === c.rigaId); if (v && r) nomi.push({ v, qta: qtaDi(r) }); }
    return nomi;
  };

  function aggiungiRichieste() {
    for (const x of richiesteTutte().filter(x => scelte.has(x.k))) {
      let p = acq.prodotti.find(p => p._daRichieste && chiave(p.nome) === chiave(x.r.nome));
      if (p) p.qta = qtaDi(p) + qtaDi(x.r);
      else { p = { id: nuovoId(), nome: x.r.nome, qta: qtaDi(x.r), costo: costoDi(x.r.nome, "singolo"), tipoAcquisto: "singolo", codice: codiceDi(x.r.nome, "singolo"), _daRichieste: true }; acq.prodotti.push(p); }
      collegamenti.push({ venditaId: x.v.id, rigaId: x.r.id, prodottoId: p.id });
    }
    scelte.clear(); segna();
  }

  function htmlSets() {
    return setsIn().map(({ info: d, comps }) => { const q = qtaDi(comps[0].p); return `<div class="card prod-card set-card">
      <div class="row"><b><span class="tag-set">Set</span>${esc(d.nome)}</b><button class="x" data-xset="${d.id}" aria-label="Togli il set">×</button></div>
      <div class="prod-grid">
        <div><label>Quanti set</label><div class="stepper"><button data-sq="${d.id}" data-d="-1">−</button><b>${q}</b><button data-sq="${d.id}" data-d="1">＋</button></div></div>
        <div><label>Costo del set</label><input class="costo-in" data-scosto="${d.id}" inputmode="decimal" value="${esc(inIt(d.costoSet))}" placeholder="€"></div></div>
      <div class="cod-row"><input class="cod-in" data-scod="${d.id}" value="${esc(d.codice || "")}" placeholder="Codice del set" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
      <div class="set-comp">${comps.map(({ p }) => { const per = assegnatiA(p.id); return `<div class="set-riga"><span>${esc(p.nome)}
          ${per.length ? `<span class="per-chi"> → ${per.map(x => esc(nomeVendita(x.v))).join(", ")}</span>` : ""}</span>
        <span class="muted num" data-scosto-di="${p.id}">${euro(numIt(p.costo))} cad.</span></div>`; }).join("")}</div>
      <div class="hint">Il costo del set lo divido tra i prodotti in proporzione al prezzo di catalogo.</div></div>`; }).join("");
  }
  function htmlNuovoSet() {
    const n = nuovoSet;
    return `<div class="add-box set-form">
      <div class="gift-sub" style="margin:0">Nuovo set</div>
      <input id="ns-nome" list="dl-set" placeholder="Nome del set (es. Crema viso + crema mani)" value="${esc(n.nome)}" autocomplete="off">
      <div class="grid2"><input id="ns-cod" class="cod-in" placeholder="Codice del set" value="${esc(n.codice)}" autocapitalize="characters" spellcheck="false" autocomplete="off">
        <input id="ns-costo" inputmode="decimal" placeholder="Costo del set €" value="${esc(inIt(n.costo))}"></div>
      <div class="two-col"><span class="hint" style="margin:0;align-self:center">Quanti set compri?</span><input id="ns-qta" inputmode="numeric" value="${esc(n.qta)}"></div>
      <div class="gift-sub" style="margin:6px 0 0">Prodotti nel set e prezzo di catalogo</div>
      ${n.comps.map((c, j) => `<div class="two-col"><input data-ncn="${j}" list="dl-prodotti" placeholder="Prodotto" value="${esc(c.nome)}" autocomplete="off">
        <input data-ncv="${j}" inputmode="decimal" placeholder="Prezzo €" value="${esc(inIt(c.valore))}"></div>`).join("")}
      <button class="link" id="ns-riga" style="justify-self:start">+ Altro prodotto</button>
      <div class="yn-b"><button id="ns-annulla">Annulla</button><button class="primary" id="ns-ok">Aggiungi il set</button></div></div>`;
  }
  const leggiNuovoSet = () => {
    if (!nuovoSet || !$("#ns-nome")) return;
    nuovoSet.nome = $("#ns-nome").value; nuovoSet.codice = $("#ns-cod").value; nuovoSet.costo = $("#ns-costo").value; nuovoSet.qta = $("#ns-qta").value;
    $$("[data-ncn]").forEach(i => { nuovoSet.comps[+i.dataset.ncn].nome = i.value; });
    $$("[data-ncv]").forEach(i => { nuovoSet.comps[+i.dataset.ncv].valore = i.value; });
  };
  const setDaCatalogo = (v, qta = 1) => ({ nome: v.nome, codice: v.codiceSet || "", costo: v.costoSet ?? "", qta,
    comps: (v.componenti || []).map(c => ({ nome: c.nome, valore: c.valore ?? "" })).concat([{ nome: "", valore: "" }]).slice(0, Math.max(2, (v.componenti || []).length)) });
  function aggiungiSet(n) {
    const comps = n.comps.filter(c => String(c.nome).trim());
    if (!String(n.nome).trim()) { avviso("Scrivi il nome del set"); return false; }
    if (comps.length < 2) { avviso("Un set ha almeno due prodotti"); return false; }
    const info = { id: nuovoId(), nome: n.nome.trim(), codice: normCodice(n.codice), costoSet: numIt(n.costo) };
    const qta = Math.max(1, parseInt(n.qta) || 1);
    for (const c of comps) acq.prodotti.push({ id: nuovoId(), nome: c.nome.trim(), qta, costo: 0, tipoAcquisto: "set", codice: "",
      valoreSet: numIt(c.valore) || numIt(voceCatalogo(c.nome)?.prezzo) || 0, daSet: { ...info } });
    ricalcolaSet(info.id); segna();
    if (!info.costoSet) setTimeout(() => avviso("Ricordati di scrivere il costo del set"), 200);
    return true;
  }

  const disegna = () => mantieniScroll(() => {
    leggiNuovoSet();
    const richieste = richiesteTutte();
    const totale = totaleAcquisto({ ...acq, prodotti: acq.prodotti.map(p => ({ ...p, costo: numIt(p.costo) })), spedizione: numIt(acq.spedizione) });
    $("#sheet-body").innerHTML = testataSheet(a ? `Ordine del ${dataLunga(a.data)}` : "Ordine a Yves Rocher", false, 0, true) + `
      <div class="sh-main">
        <div class="question">${a ? "Ordine a Yves Rocher" : "Nuovo ordine a Yves Rocher"}</div>
        <div class="yesno"><div class="grid2">
          <div><label style="margin-top:0">Data</label><input type="date" id="a-data" value="${esc(acq.data)}"></div>
          <div><label style="margin-top:0">N° ordine</label><input id="a-num" value="${esc(acq.numeroOrdine)}" placeholder="Es. 1234567" autocomplete="off"></div></div></div>

        ${richieste.length ? `<div class="yesno richieste"><div class="yn-q">Richieste delle clienti da ordinare</div>
          <div class="hint" style="margin:-4px 0 10px">Tocca quelle che stai ordinando adesso.</div>
          ${richieste.map(x => `<button class="spunta ${scelte.has(x.k) ? "on" : ""}" data-ric-k="${x.k}"><span class="box">${scelte.has(x.k) ? "✓" : ""}</span>
            <span><b>${esc(nomeVendita(x.v))}</b> · ${esc(nomeArt(x.r))}</span></button>`).join("")}
          <div class="yn-b" style="margin-top:10px"><button id="ric-tutte">Seleziona tutte</button>
            <button class="primary" id="ric-agg" ${scelte.size ? "" : "disabled style='opacity:.4'"}>＋ Aggiungi ${scelte.size || ""}</button></div></div>` : ""}

        <div class="row" style="margin-top:20px"><div class="gift-sub" style="margin:0">Prodotti comprati</div>
          ${acq.prodotti.length ? `<button class="pill c-blue" id="copia-codici">Copia codici</button>` : ""}</div>
        ${htmlSets()}
        ${acq.prodotti.map((p, i) => { if (p.daSet) return ""; const per = assegnatiA(p.id); return `<div class="card prod-card">
          <div class="row"><b>${p.confezione ? "" : ""}${esc(p.nome)}</b><button class="x" data-xp="${i}" aria-label="Togli">×</button></div>
          ${per.length ? `<div class="per-chi">→ ${per.map(x => `${esc(nomeVendita(x.v))}${x.qta > 1 ? ` (${x.qta})` : ""}`).join(", ")}</div>` : ""}
          <div class="prod-grid">
            <div><label>Quanti</label><div class="stepper"><button data-pq="${i}" data-d="-1">−</button><b>${qtaDi(p)}</b><button data-pq="${i}" data-d="1">＋</button></div></div>
            <div><label>Costo ${p.confezione ? "confezione" : "a pezzo"}</label><input class="costo-in" data-pc="${i}" inputmode="decimal" value="${esc(inIt(p.costo))}" placeholder="€"></div>
          </div>
          ${p.confezione ? `<label>Valore a catalogo dei prodotti dentro (una confezione)</label><input data-pv="${i}" inputmode="decimal" value="${esc(inIt(p.confezione.valore))}" placeholder="€">` : ""}
          <div class="cod-row">
            ${p.confezione ? "" : `<div class="mini-seg"><button data-ptipo="${i}" data-t="singolo" class="${p.tipoAcquisto !== "bundle" ? "on" : ""}">Singolo</button><button data-ptipo="${i}" data-t="bundle" class="${p.tipoAcquisto === "bundle" ? "on" : ""}">Bundle</button></div>`}
            <input class="cod-in" data-pcod="${i}" value="${esc(p.codice || "")}" placeholder="Codice" autocomplete="off" autocapitalize="characters" spellcheck="false">
          </div>
          ${p.tipoAcquisto === "bundle" && pezziBundleDi(p.nome) ? `<div class="hint" style="margin:4px 0 0">1 bundle = ${pezziBundleDi(p.nome)} pezzi${qtaDi(p) % pezziBundleDi(p.nome) ? "" : ` · stai ordinando ${qtaDi(p) / pezziBundleDi(p.nome)} bundle`}</div>` : ""}
        </div>`; }).join("")}${acq.prodotti.length ? "" : `<div class="hint" style="margin:0 0 10px">Nessun prodotto: aggiungili qui sotto.</div>`}

        <div class="add-box">
          <input id="np-nome" list="dl-prodotti" placeholder="Nome del prodotto o codice" autocomplete="off">
          <div class="cod-row" style="margin:0">
            <div class="mini-seg"><button data-ntipo-acq="singolo" class="${tipoNuovo === "singolo" ? "on" : ""}">Singolo</button><button data-ntipo-acq="bundle" class="${tipoNuovo === "bundle" ? "on" : ""}">Bundle</button></div>
            <input class="cod-in" id="np-cod" placeholder="Codice" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
          <div class="three"><input id="np-costo" inputmode="decimal" placeholder="Costo €"><input id="np-qta" inputmode="numeric" value="1" aria-label="Quanti">
            <button class="c-orange" id="np-add">＋</button></div>
          <div class="chips small-chips"><button class="chip ${nuovaConf ? "sel" : ""}" id="np-conf">È un calendario o cofanetto</button>
            <button class="chip" id="np-set">Aggiungi un set</button></div>
          ${nuovaConf ? `<input id="np-valore" inputmode="decimal" placeholder="Valore a catalogo dei prodotti dentro €"><div class="hint" style="margin:0">Poi venderai i prodotti uno per uno: il costo lo calcolo io.</div>` : ""}
        </div>
        ${nuovoSet ? htmlNuovoSet() : ""}

        <div class="yesno" style="margin-top:16px"><label style="margin-top:0">Spese di spedizione o altro (facoltativo)</label>
          <input id="a-sped" inputmode="decimal" value="${esc(inIt(acq.spedizione || ""))}" placeholder="0,00 €">
          <div class="hint">Le divido sui prodotti, così il guadagno è giusto.</div></div>

        <div class="result c-orange"><div class="r-lbl">Totale pagato a Yves Rocher</div><div class="r-val num" id="a-tot">${euro(totale)}</div></div>

        <div class="yesno"><div class="yn-q">È arrivato?</div><div class="yn-b">
          <button data-arr="1" class="${acq.arrivato !== false ? "on-yes" : ""}">Sì</button>
          <button data-arr="0" class="${acq.arrivato === false ? "on-no" : ""}">Non ancora</button></div></div>

        <div class="yesno gift-box"><div class="yn-q">Omaggi arrivati con l'ordine</div>
          ${acq.omaggiNote ? `<div class="hint" style="margin:0 0 8px">Dal vecchio file: ${esc(acq.omaggiNote)}</div>` : ""}
          ${editorOmaggi(acq.omaggiRicevuti, "oa", giacenzaOmaggi(ordiniPerOmaggi(), movimenti).map(v => ({ nome: v.nome })), "Es. campioncini")}</div>

        <label>Note</label><textarea id="a-note" placeholder="Es. promozione, codice sconto…">${esc(acq.note)}</textarea>
        ${a ? `<button class="danger" id="a-del" style="width:100%;margin-top:12px">Elimina questo ordine</button>` : ""}
      </div>
      <div class="sh-foot"><button class="big primary" id="a-salva">✓ Salva</button></div>`;
    collega();
  });

  const aggiornaTotale = () => {
    const t = totaleAcquisto({ ...acq, prodotti: acq.prodotti.map(p => ({ ...p, costo: numIt(p.costo) })), spedizione: numIt(acq.spedizione) });
    $("#a-tot").textContent = euro(t);
  };

  function collega() {
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $("#a-data").addEventListener("change", e => { acq.data = e.target.value; segna(); });
    $("#a-num").addEventListener("input", e => { acq.numeroOrdine = e.target.value; segna(); });
    $("#a-note").addEventListener("input", e => { acq.note = e.target.value; segna(); });
    $("#a-sped").addEventListener("input", e => { acq.spedizione = e.target.value; segna(); aggiornaTotale(); });
    $$("[data-ric-k]").forEach(b => b.addEventListener("click", () => { scelte.has(b.dataset.ricK) ? scelte.delete(b.dataset.ricK) : scelte.add(b.dataset.ricK); disegna(); }));
    $("#ric-tutte")?.addEventListener("click", () => { richiesteTutte().forEach(x => scelte.add(x.k)); disegna(); });
    $("#ric-agg")?.addEventListener("click", () => { if (!scelte.size) return; aggiungiRichieste(); disegna(); avviso("Aggiunte: scrivi quanto le hai pagate"); });
    $$("[data-pc]").forEach(i => i.addEventListener("input", () => { acq.prodotti[+i.dataset.pc].costo = i.value; segna(); aggiornaTotale(); }));
    $$("[data-pv]").forEach(i => i.addEventListener("input", () => { acq.prodotti[+i.dataset.pv].confezione.valore = numIt(i.value); segna(); }));
    $$("[data-pcod]").forEach(i => i.addEventListener("input", () => { const p = acq.prodotti[+i.dataset.pcod]; p.codice = normCodice(i.value); (p._cod ||= {})[p.tipoAcquisto] = p.codice; segna(); }));
    $$("[data-ptipo]").forEach(b => b.addEventListener("click", () => {
      const p = acq.prodotti[+b.dataset.ptipo]; if (p.tipoAcquisto === b.dataset.t) return;
      p._cod ||= {}; p._cod[p.tipoAcquisto] = p.codice;          // tengo da parte il codice dell'altro tipo
      const costoAuto = !numIt(p.costo) || numIt(p.costo) === numIt(costoDi(p.nome, p.tipoAcquisto));
      p.tipoAcquisto = b.dataset.t;
      p.codice = p._cod[p.tipoAcquisto] || codiceDi(p.nome, p.tipoAcquisto) || "";
      if (costoAuto && costoDi(p.nome, p.tipoAcquisto) !== "") p.costo = costoDi(p.nome, p.tipoAcquisto);
      const pb = pezziBundleDi(p.nome);
      if (p.tipoAcquisto === "bundle" && pb && qtaDi(p) < pb) p.qta = pb;
      segna(); disegna();
      if (!p.codice) avviso(`Scrivi il codice ${p.tipoAcquisto === "bundle" ? "bundle" : "singolo"}: la prossima volta lo ricordo io`);
    }));
    $("#copia-codici")?.addEventListener("click", copiaCodici);
    // set già nell'ordine
    $$("[data-sq]").forEach(b => b.addEventListener("click", () => {
      const comps = compsDi(b.dataset.sq), nuova = qtaDi(comps[0]) + Number(b.dataset.d);
      const minimo = Math.max(1, ...comps.map(p => somma(assegnatiA(p.id), x => x.qta)));
      if (nuova < minimo) return avviso(`Hai già assegnato ${minimo} pezzi di un prodotto del set`);
      comps.forEach(p => { p.qta = nuova; }); segna(); disegna();
    }));
    $$("[data-scosto]").forEach(i => i.addEventListener("input", () => {
      const sid = i.dataset.scosto; compsDi(sid).forEach(p => { p.daSet.costoSet = i.value; }); ricalcolaSet(sid); segna(); aggiornaTotale();
      compsDi(sid).forEach(p => { const el = $(`[data-scosto-di="${p.id}"]`); if (el) el.textContent = `${euro(numIt(p.costo))} cad.`; });
    }));
    $$("[data-scod]").forEach(i => i.addEventListener("input", () => { compsDi(i.dataset.scod).forEach(p => { p.daSet.codice = normCodice(i.value); }); segna(); }));
    $$("[data-xset]").forEach(b => b.addEventListener("click", () => {
      const comps = compsDi(b.dataset.xset), per = comps.flatMap(p => assegnatiA(p.id));
      if (per.length && !confirm(`Alcuni prodotti del set sono già di ${[...new Set(per.map(x => nomeVendita(x.v)))].join(", ")}: torneranno tra le cose da ordinare. Continuo?`)) return;
      for (const p of comps) {
        acq.prodotti.splice(acq.prodotti.indexOf(p), 1);
        for (let k = collegamenti.length - 1; k >= 0; k--) if (collegamenti[k].prodottoId === p.id) collegamenti.splice(k, 1);
        if (a?.prodotti?.some(x => x.id === p.id)) scollegati.add(p.id);
      }
      segna(); disegna();
    }));
    // modulo nuovo set
    $("#np-set")?.addEventListener("click", () => { nuovoSet ||= { nome: "", codice: "", costo: "", qta: 1, comps: [{ nome: "", valore: "" }, { nome: "", valore: "" }] }; disegna(); $("#ns-nome")?.focus(); });
    $("#ns-nome")?.addEventListener("change", () => { leggiNuovoSet(); const v = voceSet(nuovoSet.nome); if (v) { nuovoSet = setDaCatalogo(v, nuovoSet.qta); $(".set-form")?.remove(); disegna(); } });
    $$("[data-ncn]").forEach(i => i.addEventListener("change", () => {
      const v = $(`[data-ncv="${i.dataset.ncn}"]`); const pr = voceCatalogo(i.value)?.prezzo; if (pr && !v.value) v.value = inIt(pr); }));
    $("#ns-riga")?.addEventListener("click", () => { leggiNuovoSet(); nuovoSet.comps.push({ nome: "", valore: "" }); disegna(); $$("[data-ncn]").at(-1)?.focus(); });
    $("#ns-annulla")?.addEventListener("click", () => { nuovoSet = null; disegna(); });
    $("#ns-ok")?.addEventListener("click", () => { leggiNuovoSet(); if (aggiungiSet(nuovoSet)) { nuovoSet = null; disegna(); } });
    $$("[data-pq]").forEach(b => b.addEventListener("click", () => {
      const p = acq.prodotti[+b.dataset.pq], minimo = Math.max(1, somma(assegnatiA(p.id), x => x.qta));
      const nuova = qtaDi(p) + Number(b.dataset.d);
      if (nuova < minimo) return avviso(`Ne hai già assegnati ${minimo}: non posso scendere sotto`);
      p.qta = nuova; segna(); disegna();
    }));
    $$("[data-xp]").forEach(b => b.addEventListener("click", () => {
      const p = acq.prodotti[+b.dataset.xp], per = assegnatiA(p.id);
      if (per.length && !confirm(`Questo prodotto è di ${per.map(x => nomeVendita(x.v)).join(", ")}. Se lo togli, torna tra le cose da ordinare. Continuo?`)) return;
      acq.prodotti.splice(+b.dataset.xp, 1);
      for (let i = collegamenti.length - 1; i >= 0; i--) if (collegamenti[i].prodottoId === p.id) collegamenti.splice(i, 1);
      if (a?.prodotti?.some(x => x.id === p.id)) scollegati.add(p.id);
      segna(); disegna();
    }));
    const nomeIn = $("#np-nome"), costoIn = $("#np-costo"), codIn = $("#np-cod");
    const riempiDaCatalogo = () => {
      const daCod = voceDaCodice(nomeIn.value);          // scritto un codice al posto del nome
      if (daCod?.tipo === "set") { nuovoSet = setDaCatalogo(daCod.voce, parseInt($("#np-qta").value) || 1); nomeIn.value = ""; $(".set-form")?.remove(); disegna(); avviso("Set trovato: controlla e tocca “Aggiungi il set”"); return; }
      if (!daCod && voceSet(nomeIn.value)) { nuovoSet = setDaCatalogo(voceSet(nomeIn.value), parseInt($("#np-qta").value) || 1); nomeIn.value = ""; $(".set-form")?.remove(); disegna(); return; }
      if (daCod) { nomeIn.value = daCod.voce.nome; tipoNuovo = daCod.tipo; $$("[data-ntipo-acq]").forEach(x => x.classList.toggle("on", x.dataset.ntipoAcq === tipoNuovo)); }
      const c = costoDi(nomeIn.value, tipoNuovo);
      if (c !== "" && !costoIn.value) costoIn.value = inIt(c);
      codIn.value = codiceDi(nomeIn.value, tipoNuovo) || codIn.value;
      if (tipoNuovo === "bundle" && pezziBundleDi(nomeIn.value)) $("#np-qta").value = pezziBundleDi(nomeIn.value);
    };
    nomeIn.addEventListener("change", riempiDaCatalogo);
    nomeIn.addEventListener("keydown", e => { if (e.key === "Enter") { riempiDaCatalogo(); costoIn.focus(); } });
    $$("[data-ntipo-acq]").forEach(b => b.addEventListener("click", () => {
      tipoNuovo = b.dataset.ntipoAcq; $$("[data-ntipo-acq]").forEach(x => x.classList.toggle("on", x === b));
      if (nomeIn.value.trim()) { codIn.value = codiceDi(nomeIn.value, tipoNuovo); const c = costoDi(nomeIn.value, tipoNuovo); if (c !== "") costoIn.value = inIt(c);
        if (tipoNuovo === "bundle" && pezziBundleDi(nomeIn.value)) $("#np-qta").value = pezziBundleDi(nomeIn.value); }
    }));
    $("#np-conf").addEventListener("click", () => {
      const salva = { n: nomeIn.value, c: costoIn.value, q: $("#np-qta").value, k: codIn.value };
      nuovaConf = !nuovaConf; disegna(); $("#np-nome").value = salva.n; $("#np-costo").value = salva.c; $("#np-qta").value = salva.q; $("#np-cod").value = salva.k;
    });
    const aggiungi = () => {
      const nome = nomeIn.value.trim(); if (!nome) { nomeIn.focus(); return; }
      const p = { id: nuovoId(), nome, qta: Math.max(1, parseInt($("#np-qta").value) || 1), costo: costoIn.value, tipoAcquisto: nuovaConf ? "singolo" : tipoNuovo, codice: normCodice(codIn.value) };
      if (nuovaConf) {
        const val = numIt($("#np-valore").value);
        if (!val) { $("#np-valore").focus(); return avviso("Scrivi quanto valgono a catalogo i prodotti dentro"); }
        p.confezione = { valore: val };
      }
      acq.prodotti.push(p); nuovaConf = false; tipoNuovo = "singolo"; segna(); disegna(); $("#np-nome").focus();
    };
    $("#np-add").addEventListener("click", aggiungi);
    costoIn.addEventListener("keydown", e => { if (e.key === "Enter") aggiungi(); });
    $$("[data-arr]").forEach(b => b.addEventListener("click", () => { acq.arrivato = b.dataset.arr === "1"; segna(); disegna(); }));
    collegaOmaggi(acq.omaggiRicevuti, "oa", disegna, segna);
    $("#a-del")?.addEventListener("click", elimina);
    $("#a-salva").addEventListener("click", salva);
  }

  // Lista da copiare per fare l'ordine sul sito Yves Rocher
  async function copiaCodici() {
    const righe = setsIn().map(({ info: d, comps }) => `${d.codice || "(manca il codice)"}  x${qtaDi(comps[0].p)}  Set ${d.nome}`).concat(acq.prodotti.filter(p => !p.daSet).map(p => {
      const pb = p.tipoAcquisto === "bundle" ? pezziBundleDi(p.nome) : 0;
      const quanti = pb && qtaDi(p) % pb === 0 ? qtaDi(p) / pb : qtaDi(p);
      return `${p.codice || "(manca il codice)"}  x${quanti}  ${p.nome}${p.tipoAcquisto === "bundle" ? " (bundle)" : ""}`;
    }));
    const testo = `Ordine Yves Rocher ${dataIt(acq.data)}\n` + righe.join("\n");
    try { await navigator.clipboard.writeText(testo); avviso(`Copiati ${plurale(righe.length, "codice", "codici")}`); }
    catch { alert(testo); }
    const mancano = acq.prodotti.filter(p => !p.daSet && !p.codice).length + setsIn().filter(s => !s.info.codice).length;
    if (mancano) setTimeout(() => avviso(`Attenzione: ${plurale(mancano, "prodotto è", "prodotti sono")} senza codice`), 2600);
  }

  // vendite da aggiornare: collegare le richieste, scollegare i prodotti tolti
  function modificheVendite(idAcq, prodottiFinali) {
    const costi = new Map(prodottiFinali.map(p => [p.id, p]));
    const toccate = new Map();
    for (const v of vendite) {
      let cambiata = false;
      const righe = (v.righe || []).map(r => {
        const link = collegamenti.find(c => c.venditaId === v.id && c.rigaId === r.id);
        if (link) { cambiata = true; const p = costi.get(link.prodottoId);
          return { ...r, fonte: { acquistoId: idAcq, prodottoId: link.prodottoId }, ...(isMia(v) && p ? { prezzo: numIt(p.costo) } : {}) }; }
        if (r.fonte?.acquistoId === idAcq && !costi.has(r.fonte.prodottoId)) { cambiata = true; const { fonte, ...resto } = r; return resto; }
        return r;
      });
      if (cambiata) toccate.set(v.id, { prima: v, dopo: { ...v, righe } });
    }
    return [...toccate.values()].map(t => ({ ref: refVendita(t.prima.id), prima: senzaId(t.prima), dopo: senzaId(t.dopo) }));
  }

  async function salva() {
    if (!acq.prodotti.length) return avviso("Aggiungi almeno un prodotto");
    if (acq.prodotti.some(p => p.daSet ? !numIt(p.daSet.costoSet) : !numIt(p.costo)) && !confirm("Alcuni prodotti non hanno il costo: il guadagno non sarà giusto finché non lo scrivi. Salvo lo stesso?")) return;
    const codiciExtra = new Map(acq.prodotti.map(p => [p.id, { ...(p._cod || {}), [p.tipoAcquisto]: p.codice }]));
    if (nuovoSet && $("#ns-nome")) { leggiNuovoSet(); if (nuovoSet.nome.trim() && !confirm("Hai un set non ancora aggiunto: lo lascio fuori?")) return; }
    const prodotti = acq.prodotti.map(p => ({ id: p.id, nome: p.nome.trim(), qta: qtaDi(p), costo: numIt(p.costo), tipoAcquisto: p.tipoAcquisto || "singolo", codice: normCodice(p.codice),
      ...(p.daSet ? { daSet: { id: p.daSet.id, nome: p.daSet.nome, codice: normCodice(p.daSet.codice), costoSet: numIt(p.daSet.costoSet) }, valoreSet: Number(p.valoreSet) || 0 } : {}),
      ...(p.confezione ? { confezione: { valore: numIt(p.confezione.valore) } } : {}) }));
    const dati = { ...senzaId(acq), prodotti, spedizione: numIt(acq.spedizione), arrivato: acq.arrivato !== false,
      arrivatoIl: acq.arrivato !== false ? (acq.arrivatoIl || oggi()) : null, aggiornato: new Date().toISOString() };
    const soglia = sogliaAcquisti(), mese = String(dati.data || "").slice(0, 7);
    if (soglia && mese) {
      const prima = spesoMese(mese, nuovoIdAcq), dopo = spesoMese(mese, nuovoIdAcq, totaleAcquisto(dati));
      const nomeMese = new Date(mese + "-01T00:00").toLocaleDateString("it-IT", { month: "long" });
      if (dopo >= soglia && prima < soglia && !confirm(`Attenzione: con quest'ordine a ${nomeMese} arrivi a ${euro(dopo)} di acquisti, sopra la tua soglia di ${euro(soglia)}.\n\nSalvo lo stesso?`)) return;
    }
    const mod = [{ ref: refAcquisto(nuovoIdAcq), prima: a ? senzaId(a) : null, dopo: dati }, ...modificheVendite(nuovoIdAcq, prodotti)];
    $("#a-salva").disabled = true;
    await scriviConAnnulla(mod, null);
    // ricordo costo e codici per la prossima volta
    for (const { info: d, comps } of setsIn()) setDoc(doc(col("catalogo"), slug("set " + d.nome)), { nome: d.nome, tipo: "set",
      codiceSet: normCodice(d.codice) || null, costoSet: numIt(d.costoSet) || null, componenti: comps.map(({ p }) => ({ nome: p.nome, valore: Number(p.valoreSet) || 0 })) }, { merge: true });
    for (const p of prodotti) {
      if (p.daSet) continue;
      const agg = { nome: p.nome };
      if (p.costo && !p.confezione) agg[p.tipoAcquisto === "bundle" ? "costoBundle" : "costo"] = p.costo;
      const cod = codiciExtra.get(p.id) || {};
      if (normCodice(cod.singolo)) agg.codiceSingolo = normCodice(cod.singolo);
      if (normCodice(cod.bundle)) agg.codiceBundle = normCodice(cod.bundle);
      if (Object.keys(agg).length > 1) setDoc(doc(col("catalogo"), slug(p.nome)), agg, { merge: true });
    }
    chiudiSheet(true);
    avviso(a ? "✓ Ordine aggiornato" : collegamenti.length ? `✓ Salvato: ${plurale(collegamenti.length, "richiesta collegata", "richieste collegate")}` : "✓ Ordine salvato");
  }

  async function elimina() {
    const usati = acq.prodotti.filter(p => assegnatiA(p.id).length).length;
    if (!confirm(usati ? `Eliminare l'ordine? ${plurale(usati, "prodotto è già assegnato", "prodotti sono già assegnati")} a delle clienti: torneranno “da ordinare”.` : "Eliminare questo ordine?")) return;
    const mod = [{ ref: refAcquisto(a.id), prima: senzaId(a), dopo: null }, ...modificheVendite(a.id, [])];
    await scriviConAnnulla(mod, "Ordine eliminato");
    chiudiSheet(true);
  }

  disegna();
  apriSheet();
}

// =====================================================================
// VENDITE (ordini delle clienti)
// =====================================================================
function renderVendite() {
  const indice = indiceProdotti(acquisti);
  const filtri = { tutte: () => true, pagare: v => !isMia(v) && !v.pagato, consegnare: v => (v.righe || []).some(r => !r.consegnato), ordinare: v => (v.righe || []).some(rigaDaOrdinare) };
  const lista = vendite.filter(filtri[filtroVendite]);
  const gruppi = vendite.filter(v => v.clienteId === STORICO);
  let h = gruppi.length ? `<div class="card b-gold" style="background:var(--gold-soft)"><h3>${plurale(gruppi.length, "ordine di gruppo", "ordini di gruppo")} dal vecchio file</h3>
    <div class="sub" style="color:var(--text)">Più clienti insieme nella stessa riga. Li divido io usando le sigle che avevi scritto (es. MTA, NR).</div>
    <div class="actions"><button class="primary" id="dividi-tutti">Dividili tu</button></div></div>` : "";
  h += `<div class="chips small-chips" style="margin-bottom:12px">${[["tutte", "Tutte"], ["pagare", "Da pagare"], ["consegnare", "Da consegnare"], ["ordinare", "Da ordinare"]]
    .map(([k, t]) => `<button class="chip ${filtroVendite === k ? "sel" : ""}" data-fv="${k}">${t}</button>`).join("")}</div>`;
  h += intestazioneLista("vendite", lista.length);
  if (!vendite.length) h += `<div class="empty"><div class="e-ico"></div><b>Nessuna vendita</b><br>Tocca “Ordine di una cliente” quando una cliente prende o ti chiede qualcosa.</div>`;
  else if (!lista.length) h += `<div class="empty">Niente in questo elenco</div>`;
  let meseCorr = "";
  for (const v of lista) {
    const m = String(v.data || "").slice(0, 7);
    if (m !== meseCorr) { meseCorr = m; h += `<div class="section"><h2 style="text-transform:capitalize">${new Date(m + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" })}</h2></div>`; }
    const c = calcolaVendita(v, indice);
    const dc = (v.righe || []).filter(r => !r.consegnato).length;
    h += `<div class="card ${isMia(v) ? "b-pink" : "b-blue"} tap ${inSelezione("vendite") && selezione.ids.has(v.id) ? "scelta" : ""}" data-ven="${v.id}">
      <div class="row"><div class="who">${casella("vendite", v.id)}${avatarVendita(v)}<div><h3>${esc(nomeVendita(v))}</h3><div class="sub">${dataLunga(v.data)} · ${esc(elencoRighe(v.righe || []))}</div></div></div>
        <div style="text-align:right"><div class="amount num">${euro(isMia(v) ? c.costo : c.totale)}</div>
        ${!isMia(v) && c.guadagno ? `<div class="num" style="color:${c.guadagno > 0 ? "var(--green)" : "var(--red)"};font-size:14px;font-weight:700">${c.guadagno > 0 ? "+" : ""}${euro(c.guadagno)}</div>` : ""}</div></div>
      ${isMia(v) ? `<span class="badge c-pink">Per me</span>` : v.pagato ? `<span class="badge c-green">✓ Pagato</span>` : `<span class="badge c-pink">Da pagare</span>`}
      ${dc ? `<span class="badge c-orange">${dc} da consegnare</span>` : `<span class="badge c-green">✓ Consegnato</span>`}
      ${c.nDaOrdinare ? `<span class="badge c-blue">${c.nDaOrdinare} da ordinare</span>` : ""}
    </div>`;
  }
  $("#view").innerHTML = h + barraSelezione("vendite");
  $$("[data-fv]").forEach(b => b.addEventListener("click", () => { filtroVendite = b.dataset.fv; renderVendite(); }));
  collegaSelezione("vendite", lista.map(v => v.id), (id) => apriVendita(vendite.find(v => v.id === id)));
  $("#dividi-tutti")?.addEventListener("click", async () => {
    const r = dividiAutomaticamente(vendite, acquisti);
    if (!r.fatte) return alert("Non riesco a dividerli da sola: aprili uno per uno e tocca “Dividi tra le clienti”.");
    await scriviConAnnulla(r.mod, `${plurale(r.fatte, "ordine diviso", "ordini divisi")}${r.restano.length ? ` · ${r.restano.length} da fare a mano` : ""}`);
    if (r.restano.length || r.dedotte) setTimeout(() => alert(`Fatto! ${plurale(r.fatte, "ordine diviso", "ordini divisi")}.` +
      (r.dedotte ? `\n\nIn ${plurale(r.dedotte, "ordine", "ordini")} c'erano prodotti senza sigla: li ho dati all'unica cliente rimasta. Controlla aprendo la vendita.` : "") +
      (r.restano.length ? `\n\n${plurale(r.restano.length, "ordine resta", "ordini restano")} da dividere a mano: aprilo e tocca “Dividi tra le clienti”.` : "") +
      `\n\nI prezzi dei singoli prodotti li ho divisi io in proporzione: se li ricordi puoi correggerli.`), 300);
  });
}

// ---------- Scheda ordine di una cliente (a passaggi) ----------
function apriVendita(v, opz = {}) {
  const ven = v ? structuredClone(v) : { data: oggi(), clienteId: opz.clienteId || "", pagato: false, pagatoIl: null, note: "", sconto: 0, omaggiDati: [], riacquistoGiorni: null, righe: [] };
  ven.righe ||= []; ven.omaggiDati ||= [];
  ven.righe.forEach(r => { r.id ||= nuovoId(); });
  const idVen = v?.id || nuovoId();
  let modificato = false;
  const segna = () => { modificato = true; };
  sheetChiudi = () => !modificato || confirm("Uscire senza salvare? Le modifiche andranno perse.");
  let passo = v || opz.clienteId ? "cosa" : "chi";
  let cercaChi = "", mostraNuovaCliente = false, inAttesaConf = null, prodottoIniziale = opz.prodotto || null;
  const mia = () => ven.clienteId === IO;
  const eliminaVendita = async () => {
    if (!confirm("Eliminare questa vendita? I prodotti presi dal magazzino tornano disponibili.")) return;
    await scriviConAnnulla([{ ref: refVendita(v.id), prima: senzaId(v), dopo: null }], "Vendita eliminata");
    chiudiSheet(true);
  };
  eliminaCorrente = v ? eliminaVendita : null;

  const usoCorrente = () => {
    const m = new Map();
    for (const r of ven.righe) if (r.fonte) { const k = `${r.fonte.acquistoId}:${r.fonte.prodottoId}`; const u = m.get(k) || { qta: 0, valore: 0 };
      u.qta += qtaDi(r); u.valore += (Number(r.prezzo) || 0) * qtaDi(r); m.set(k, u); }
    return m;
  };
  const disponibili = () => magazzino(acquisti, vendite, { escludiVenditaId: v?.id, usoExtra: usoCorrente() });
  const indice = () => indiceProdotti(acquisti);

  function prendiDalMagazzino(g, prezzo) {
    const f = g.fonti.find(x => x.disponibili > 0.004); if (!f) return avviso("Non ce n'è più in magazzino");
    const fonte = { acquistoId: f.acquistoId, prodottoId: f.prodottoId };
    if (g.confezione) {
      ven.righe.push({ id: nuovoId(), nome: inAttesaConf.nome, qta: 1, prezzo, fonte, consegnato: mia() && f.arrivato });
    } else {
      const uguale = ven.righe.find(r => r.fonte && r.fonte.acquistoId === fonte.acquistoId && r.fonte.prodottoId === fonte.prodottoId);
      if (uguale) uguale.qta = qtaDi(uguale) + 1;
      else ven.righe.push({ id: nuovoId(), nome: g.nome, qta: 1, fonte, consegnato: mia() && f.arrivato,
        prezzo: mia() ? Math.round(f.costoPezzo * 100) / 100 : (voceCatalogo(g.nome)?.prezzo ?? "") });
    }
    segna();
  }

  const disegna = () => { ({ chi: passoChi, cosa: passoCosa, stato: passoStato })[passo](); };
  function indietro() {
    if (passo === "stato") passo = "cosa";
    else if (passo === "cosa" && !v && !opz.clienteId) passo = "chi";
    else if (passo === "chi" && ven.righe.length) passo = "cosa";
    else return chiudiSheet();
    disegna();
  }

  // Passo 1 — Per chi?
  function passoChi() {
    const recenti = new Set(vendite.map(x => x.clienteId));
    const ordinate = [...clienti].sort((a, b) => (recenti.has(b.id) - recenti.has(a.id)) || a.nome.localeCompare(b.nome, "it"));
    const filtrate = ordinate.filter(c => !cercaChi || chiave(c.nome).includes(chiave(cercaChi))).slice(0, 40);
    $("#sheet-body").innerHTML = testataSheet(v ? "Vendita" : "Ordine di una cliente", !!ven.righe.length, 1, true) + `
      <div class="sh-main">
        <div class="question">Per chi è?</div>
        <p class="q-hint">Tocca il nome della cliente, oppure “Per me” se è per te.</p>
        ${clienti.length > 8 ? `<input id="chi-cerca" class="search" placeholder="Cerca per nome" value="${esc(cercaChi)}">` : ""}
        <div class="chips">
          ${ven.clienteId === STORICO ? `<button class="chip sel" data-chi="${STORICO}">${esc(ven.clientiStorico)}</button>` : ""}
          <button class="chip me ${ven.clienteId === IO ? "sel" : ""}" data-chi="${IO}">Per me</button>
          ${filtrate.map(c => `<button class="chip ${ven.clienteId === c.id ? "sel" : ""}" data-chi="${c.id}">${esc(c.nome)}</button>`).join("")}
          <button class="chip new" id="chi-nuova">Nuova cliente</button>
        </div>
        <div id="box-nuova" class="${mostraNuovaCliente ? "" : "hidden"}" style="margin-top:16px">
          <label>Nome della nuova cliente</label><input id="nuova-nome" placeholder="Es. Giulia Rossi" autocomplete="off">
          <label>Cellulare (per WhatsApp, facoltativo)</label><input id="nuova-tel" type="tel" placeholder="333 1234567">
          <button class="big primary" id="nuova-ok" style="margin-top:12px">Aggiungi e continua</button>
        </div>
      </div>`;
    $("#sh-back").addEventListener("click", indietro);
    $("#chi-cerca")?.addEventListener("input", (e) => { cercaChi = e.target.value; const pos = e.target.selectionStart; passoChi(); const i = $("#chi-cerca"); i.focus(); i.setSelectionRange(pos, pos); });
    const scegli = (id) => {
      const eraMia = mia(); ven.clienteId = id; segna();
      if (mia() !== eraMia) { // prezzi: per me = costo
        const idx = indice();
        ven.righe.forEach(r => { if (mia()) { const c = costoRiga(r, idx); r.prezzo = c === null ? 0 : Math.round(c / qtaDi(r) * 100) / 100; } else r.prezzo = voceCatalogo(r.nome)?.prezzo ?? ""; });
      }
      if (prodottoIniziale) { if (!prodottoIniziale.confezione) prendiDalMagazzino(prodottoIniziale); else inAttesaConf = { gruppo: prodottoIniziale, nome: "" }; prodottoIniziale = null; }
      passo = "cosa"; disegna();
    };
    $$("[data-chi]").forEach(b => b.addEventListener("click", () => scegli(b.dataset.chi)));
    $("#chi-nuova").addEventListener("click", () => { mostraNuovaCliente = true; $("#box-nuova").classList.remove("hidden"); $("#nuova-nome").focus(); });
    $("#nuova-ok").addEventListener("click", async () => {
      const nome = $("#nuova-nome").value.trim(); if (!nome) return $("#nuova-nome").focus();
      const tel = $("#nuova-tel").value.trim();
      const ref = await addDoc(col("clienti"), { nome, telefono: tel, note: "" });
      if (!clienti.some(c => c.id === ref.id)) clienti.push({ id: ref.id, nome, telefono: tel });
      mostraNuovaCliente = false; scegli(ref.id);
    });
    apriSheet();
  }

  // Passo 2 — Cosa?
  function passoCosa() {
    const disp = disponibili();
    const idx = indice();
    const tot = Math.max(0, somma(ven.righe, r => numIt(r.prezzo) * qtaDi(r)) - numIt(ven.sconto));
    mantieniScroll(() => {
    $("#sheet-body").innerHTML = testataSheet(nomeVendita(ven), !v && !opz.clienteId, 2, true) + `
      <div class="sh-main">
        <div class="question">${mia() ? "Cosa prendi per te?" : `Cosa ha preso ${esc(primoNome({ nome: nomeVendita(ven) }))}?`}</div>
        ${v || opz.clienteId ? `<button class="pill c-blue" id="cambia-chi" style="margin:0 0 10px">${esc(nomeVendita(ven))} · Cambia</button>` : ""}
        ${ven.clienteId === STORICO ? `<div class="banner" style="display:block">Ordine di gruppo dal vecchio file.<div class="actions" style="margin-top:8px"><button class="c-gold" id="dividi">Dividi tra le clienti</button></div></div>` : ""}
        <div class="items">${ven.righe.map((r, i) => { const daOrd = rigaDaOrdinare(r), c = costoRiga(r, idx); return `<div class="item riga-ven">
            <div class="i-name"><b>${esc(nomeArt(r))}</b><br><span class="tag-${daOrd ? "ordinare" : "scorta"}">${daOrd ? "da ordinare" : r.fonte && acquistoDi(r.fonte.acquistoId)?.prodotti.find(p => p.id === r.fonte.prodottoId)?.confezione ? "dalla confezione" : "dal magazzino"}</span>
              ${mia() && c !== null ? `<span class="muted" style="font-size:13px"> · costo ${euro(c)}</span>` : ""}</div>
            ${mia() ? "" : `<input class="prezzo-in" data-pr="${i}" inputmode="decimal" value="${esc(inIt(r.prezzo))}" placeholder="€" aria-label="Prezzo a pezzo">`}
            <div class="stepper mini"><button data-rq="${i}" data-d="-1">−</button><b>${qtaDi(r)}</b><button data-rq="${i}" data-d="1">＋</button></div>
          </div>`; }).join("")}</div>

        ${disp.length ? `<div class="scorta-box"><div class="gift-sub" style="margin-top:0">Nel tuo magazzino</div>
          <div class="chips small-chips">${disp.map((g, i) => g.confezione
            ? `<button class="chip scorta ${inAttesaConf?.gruppo && chiave(inAttesaConf.gruppo.nome) === chiave(g.nome) ? "sel" : ""}" data-mag="${i}">${esc(g.nome)} <span class="muted">· ancora ${euro(g.disponibili)}</span></button>`
            : `<button class="chip scorta" data-mag="${i}">${esc(g.nome)} <span class="muted">· ${g.disponibili}${g.inArrivo ? "" : ""}</span></button>`).join("")}</div>
          ${inAttesaConf ? `<div class="add-box" style="margin-top:10px;box-shadow:none"><div class="tag-scorta big-tag">Dal ${esc(inAttesaConf.gruppo.nome)} <button class="x-mini" id="annulla-conf">×</button></div>
            <input id="conf-nome" placeholder="Quale prodotto? Es. siero" autocomplete="off" list="dl-prodotti">
            <div class="two-col"><input id="conf-prezzo" inputmode="decimal" placeholder="${mia() ? "Valore a catalogo €" : "Prezzo di vendita €"}"><button class="c-orange" id="conf-add">＋ Aggiungi</button></div></div>` : ""}
        </div>` : ""}

        <div class="add-box">
          <div class="gift-sub" style="margin:0">${disp.length ? "Non è in magazzino? Da ordinare" : "Prodotto da ordinare"}</div>
          <input id="ord-nome" list="dl-prodotti" placeholder="Nome del prodotto" autocomplete="off">
          <div class="two-col"><input id="ord-prezzo" inputmode="decimal" placeholder="${mia() ? "(per te: conta il costo)" : "Prezzo di vendita €"}" ${mia() ? "disabled" : ""}>
            <button class="c-blue" id="ord-add">＋ Aggiungi</button></div>
          <div class="hint" style="margin:0">Lo ritrovi nell'ordine a Yves Rocher, tra le richieste da ordinare.</div>
        </div>

        ${mia() ? "" : `<div class="total-line"><span>Totale</span><b class="num">${euro(tot)}</b></div>
        <details class="more" ${numIt(ven.sconto) ? "open" : ""}><summary>Hai fatto uno sconto?</summary>
          <label>Sconto in euro sul totale</label><input id="v-sconto" inputmode="decimal" placeholder="0" value="${esc(inIt(ven.sconto || ""))}"></details>`}
      </div>
      <div class="sh-foot"><button class="big primary" id="avanti">Avanti →</button></div>`;
    });
    $("#sh-back").addEventListener("click", indietro);
    $("#cambia-chi")?.addEventListener("click", () => { cercaChi = ""; passo = "chi"; disegna(); });
    $("#dividi")?.addEventListener("click", () => { if (modificato && !confirm("Le modifiche non salvate andranno perse. Continuo?")) return; sheetChiudi = null; apriDividi(v); });
    $$("[data-pr]").forEach(i => i.addEventListener("input", () => { ven.righe[+i.dataset.pr].prezzo = i.value; segna();
      const t = Math.max(0, somma(ven.righe, r => numIt(r.prezzo) * qtaDi(r)) - numIt(ven.sconto)); if ($(".total-line b")) $(".total-line b").textContent = euro(t); }));
    $$("[data-rq]").forEach(b => b.addEventListener("click", () => {
      const r = ven.righe[+b.dataset.rq], d = Number(b.dataset.d);
      if (d > 0 && r.fonte) {
        const g = disp.find(x => !x.confezione && chiave(x.nome) === chiave(r.nome));
        const prodotto = acquistoDi(r.fonte.acquistoId)?.prodotti.find(p => p.id === r.fonte.prodottoId);
        if (prodotto?.confezione) return avviso("Per un altro prodotto della confezione usa il pulsante");
        if (!g) return avviso("Non ce n'è altro in magazzino");
        const f = g.fonti.find(x => x.acquistoId === r.fonte.acquistoId && x.prodottoId === r.fonte.prodottoId && x.disponibili > 0);
        if (f) r.qta = qtaDi(r) + 1; else prendiDalMagazzino(g);
      } else {
        r.qta = qtaDi(r) + d;
        if (r.qta <= 0) ven.righe.splice(+b.dataset.rq, 1);
      }
      segna(); passoCosa();
    }));
    $$("[data-mag]").forEach(b => b.addEventListener("click", () => {
      const g = disp[+b.dataset.mag];
      if (g.confezione) { inAttesaConf = { gruppo: g }; passoCosa(); $("#conf-nome")?.focus(); }
      else { prendiDalMagazzino(g); passoCosa(); }
    }));
    $("#annulla-conf")?.addEventListener("click", () => { inAttesaConf = null; passoCosa(); });
    $("#conf-add")?.addEventListener("click", () => {
      const nome = $("#conf-nome").value.trim(); if (!nome) return $("#conf-nome").focus();
      const prezzo = numIt($("#conf-prezzo").value); if (!prezzo) return $("#conf-prezzo").focus();
      inAttesaConf.nome = nome;
      prendiDalMagazzino(inAttesaConf.gruppo, prezzo);
      if (mia()) { const r = ven.righe.at(-1); const c = costoRiga(r, indice()); r.valoreCatalogo = prezzo; r.prezzo = c === null ? 0 : Math.round(c * 100) / 100; }
      inAttesaConf = null; passoCosa();
    });
    const ordNome = $("#ord-nome"), ordPrezzo = $("#ord-prezzo");
    ordNome.addEventListener("change", () => { const p = voceCatalogo(ordNome.value)?.prezzo; if (p && !ordPrezzo.value && !mia()) ordPrezzo.value = inIt(p); });
    const aggOrd = () => {
      const nome = ordNome.value.trim(); if (!nome) { ordNome.focus(); return false; }
      ven.righe.push({ id: nuovoId(), nome, qta: 1, prezzo: mia() ? 0 : numIt(ordPrezzo.value), consegnato: false });
      segna(); return true;
    };
    $("#ord-add").addEventListener("click", () => { if (aggOrd()) { passoCosa(); $("#ord-nome").focus(); } });
    ordPrezzo.addEventListener("keydown", e => { if (e.key === "Enter") $("#ord-add").click(); });
    $("#v-sconto")?.addEventListener("input", e => { ven.sconto = numIt(e.target.value); segna();
      $(".total-line b").textContent = euro(Math.max(0, somma(ven.righe, r => numIt(r.prezzo) * qtaDi(r)) - numIt(ven.sconto))); });
    $("#avanti").addEventListener("click", () => {
      if (ordNome.value.trim()) aggOrd();
      if (!ven.righe.length) return avviso("Aggiungi almeno un prodotto");
      if (!mia() && ven.righe.some(r => !numIt(r.prezzo)) && !confirm("Alcuni prodotti non hanno il prezzo di vendita. Vado avanti lo stesso?")) return;
      passo = "stato"; disegna();
    });
    apriSheet();
  }

  // Passo 3 — Pagato, consegnato, omaggi
  function passoStato() {
    const pronta = { ...ven, righe: ven.righe.map(r => ({ ...r, prezzo: numIt(r.prezzo) })), sconto: numIt(ven.sconto) };
    const c = calcolaVendita(pronta, indice());
    const giac = giacenzaOmaggi([...acquistiComeOrdini(acquisti), ...venditeComeOrdini([...vendite.filter(x => x.id !== v?.id), { ...ven, id: idVen }])], movimenti);
    mantieniScroll(() => {
    $("#sheet-body").innerHTML = testataSheet(nomeVendita(ven), true, 3, true) + `
      <div class="sh-main">
        <div class="question">Ultime cose</div>
        <p class="q-hint">${mia() ? `Costo per te ${euro(c.costo)}` : `Totale ${euro(c.totale)}`}</p>
        ${mia() ? "" : `<div class="yesno"><div class="yn-q">Ha già pagato?</div><div class="yn-b">
          <button data-pag="1" class="${ven.pagato ? "on-yes" : ""}">Sì</button><button data-pag="0" class="${!ven.pagato ? "on-no" : ""}">Non ancora</button></div></div>`}
        <div class="yesno"><div class="yn-q">${mia() ? "Cosa hai già preso?" : "Cosa le hai già consegnato?"}</div>
          ${ven.righe.map((r, i) => rigaDaOrdinare(r)
            ? `<div class="spunta disab"><span class="box"></span>${esc(nomeArt(r))} <span class="muted" style="margin-left:auto;font-size:13px">da ordinare</span></div>`
            : `<button class="spunta ${r.consegnato ? "on" : ""}" data-cons="${i}"><span class="box">${r.consegnato ? "✓" : ""}</span>${esc(nomeArt(r))}${!rigaArrivata(r) ? ` <span class="muted" style="margin-left:auto;font-size:13px">in arrivo</span>` : ""}</button>`).join("")}
          ${ven.righe.filter(r => !rigaDaOrdinare(r)).length > 1 ? `<div class="yn-b" style="margin-top:10px"><button data-tutti="1">✓ Tutto</button><button data-tutti="0">Niente</button></div>` : ""}</div>
        ${mia() ? "" : `<div class="yesno"><div class="yn-q">Le hai regalato qualcosa?</div>
          ${editorOmaggi(ven.omaggiDati, "ov", giac.filter(x => x.giacenza > 0).map(x => ({ nome: x.nome, giacenza: x.giacenza })), "Altro omaggio")}</div>
        <div class="yesno"><div class="yn-q">Ricordami di risentirla</div><div class="chips">
          ${[["", "No"], ["30", "Tra 1 mese"], ["60", "Tra 2 mesi"], ["90", "Tra 3 mesi"]].map(([k, t]) =>
            `<button class="chip ${String(ven.riacquistoGiorni || "") === k ? "sel" : ""}" data-ric="${k}">${t}</button>`).join("")}</div></div>
        <div class="result ${c.guadagno >= 0 ? "c-green" : "c-pink"}"><div class="r-lbl">Ci guadagni</div><div class="r-val num">${euro(c.guadagno)}</div>
          <div class="r-sub">Venduto ${euro(c.totale)} · costo ${euro(c.costo)}</div>
          ${c.nDaOrdinare ? `<div class="r-sub">${plurale(c.nDaOrdinare, "prodotto da ordinare non è", "prodotti da ordinare non sono")} ancora conteggiati</div>` : ""}</div>`}
        <label>Data</label><input type="date" id="v-data" value="${esc(ven.data)}">
        <label>Note</label><textarea id="v-note">${esc(ven.note)}</textarea>
        ${v ? `<button class="danger" id="v-del" style="width:100%;margin-top:12px">Elimina questa vendita</button>` : ""}
      </div>
      <div class="sh-foot"><button class="big primary" id="v-salva">✓ Salva</button></div>`;
    });
    const rid = () => passoStato();
    $("#sh-back").addEventListener("click", indietro);
    $$("[data-pag]").forEach(b => b.addEventListener("click", () => { ven.pagato = b.dataset.pag === "1"; segna(); rid(); }));
    $$("[data-cons]").forEach(b => b.addEventListener("click", () => { const r = ven.righe[+b.dataset.cons]; r.consegnato = !r.consegnato; segna(); rid(); }));
    $$("[data-tutti]").forEach(b => b.addEventListener("click", () => { ven.righe.forEach(r => { if (!rigaDaOrdinare(r)) r.consegnato = b.dataset.tutti === "1"; }); segna(); rid(); }));
    $$("[data-ric]").forEach(b => b.addEventListener("click", () => { ven.riacquistoGiorni = b.dataset.ric ? Number(b.dataset.ric) : null; segna(); rid(); }));
    if (!mia()) collegaOmaggi(ven.omaggiDati, "ov", rid, segna);
    $("#v-data").addEventListener("change", e => { ven.data = e.target.value; segna(); });
    $("#v-note").addEventListener("input", e => { ven.note = e.target.value; segna(); });
    $("#v-del")?.addEventListener("click", eliminaVendita);
    $("#v-salva").addEventListener("click", async () => {
      const dati = { ...senzaId(ven), righe: ven.righe.map(r => ({ ...r, prezzo: numIt(r.prezzo), qta: qtaDi(r), consegnato: !!r.consegnato })),
        sconto: numIt(ven.sconto), pagato: mia() ? true : !!ven.pagato, aggiornato: new Date().toISOString() };
      dati.pagatoIl = dati.pagato ? (v?.pagato ? (v.pagatoIl || ven.data) : oggi()) : null;
      if (mia()) dati.pagatoIl = ven.data;
      $("#v-salva").disabled = true;
      await scriviConAnnulla([{ ref: refVendita(idVen), prima: v ? senzaId(v) : null, dopo: dati }], null);
      if (!mia()) for (const r of dati.righe) if (r.prezzo) setDoc(doc(col("catalogo"), slug(r.nome)), { nome: r.nome, prezzo: r.prezzo }, { merge: true });
      chiudiSheet(true);
      const nuoveRich = dati.righe.filter(rigaDaOrdinare).length - (v?.righe || []).filter(rigaDaOrdinare).length;
      avviso(nuoveRich > 0 ? `Salvato: ${plurale(nuoveRich, "prodotto aggiunto", "prodotti aggiunti")} a “Da ordinare” in Acquisti` : v ? "✓ Vendita aggiornata" : "✓ Vendita salvata");
    });
  }

  disegna();
}

// ---------- Dividere un ordine di gruppo (dal vecchio Excel) ----------
// 1) prepara: prodotti del gruppo, persona proposta dalle sigle (MTA, NR, io…), budget del vecchio file
function preparaDivisione(G, venArr, acqArr) {
  const indice = indiceProdotti(acqArr);
  const fonteG = (G.righe || []).find(r => r.fonte)?.fonte;
  const A = fonteG && acqArr.find(a => a.id === fonteG.acquistoId);
  if (!A) return null;
  const nomi = String(G.clientiStorico || "").split(",").map(x => x.trim()).filter(Boolean);
  const I = venArr.find(x => isMia(x) && x.migrataDa && x.migrataDa === G.migrataDa && (x.righe || []).some(r => r.nome === "Acquisti personali"));
  const voci = dividiProdotti((G.righe || []).map(r => r.nome).join(", ")).map(x => {
    const ab = abbinaSigla(x.sigla, nomi);
    return { nome: x.nome, qta: x.qta, sigla: x.siglaPropria ? x.sigla : null, chi: ab === null ? null : ab === "io" ? IO : "n" + ab, prezzo: "" };
  });
  return { G, A, I, nomi, voci,
    budgetC: calcolaVendita(G, indice).totale,
    budgetM: I ? somma(I.righe, r => (r.valoreCatalogo ?? r.prezzo) * qtaDi(r)) : 0,
    costoC: somma(G.righe, r => costoRiga(r, indice) || 0),
    costoM: I ? somma(I.righe, r => costoRiga(r, indice) || 0) : 0 };
}
// 2) completa da sola quando c'è un solo modo sensato: resta una sola cliente senza prodotti → i prodotti senza sigla vanno a lei
function completaAssegnazioni(d) {
  const senza = d.voci.filter(x => !x.chi);
  if (!senza.length) return true;
  const usate = new Set(d.voci.map(x => x.chi).filter(Boolean));
  const libere = d.nomi.map((n, j) => "n" + j).filter(k => !usate.has(k));
  if (libere.length === 1) { senza.forEach(x => { x.chi = libere[0]; x.dedotto = true; }); return true; }
  return false;
}
// divide un budget tra i prodotti: prezzi scritti + il resto in proporzione (prezzi di catalogo se li conosco, altrimenti quantità)
function ripartisci(lista, budget) {
  const scritti = somma(lista.filter(x => x.prezzo !== ""), x => numIt(x.prezzo));
  const vuoti = lista.filter(x => x.prezzo === "");
  const resto = Math.round((budget - scritti) * 100) / 100;
  if (vuoti.length && resto < 0) return `I prezzi scritti superano il totale di ${euro(budget)}`;
  if (!vuoti.length && Math.abs(resto) > 0.01) return `I prezzi devono fare in tutto ${euro(budget)} (ora ${euro(scritti)})`;
  const conCatalogo = vuoti.length && vuoti.every(x => voceCatalogo(x.nome)?.prezzo);
  const peso = (x) => (conCatalogo ? voceCatalogo(x.nome).prezzo : 1) * x.qta;
  const totPeso = somma(vuoti, peso) || 1;
  let dato = 0;
  vuoti.forEach((x, k) => { x._tot = k === vuoti.length - 1 ? Math.round((resto - dato) * 100) / 100 : Math.round(resto * peso(x) / totPeso * 100) / 100; dato += x._tot; });
  lista.filter(x => x.prezzo !== "").forEach(x => { x._tot = numIt(x.prezzo); });
  return null;
}
// 3) calcola le scritture: nuove vendite per cliente, "per me", prodotti in magazzino, acquisto aggiornato
function calcolaDivisione(d, idPerNome, nuoviClienti) {
  const { G, A, I, nomi, voci, budgetC, budgetM, costoC, costoM } = d;
  if (!voci.length) return { err: "Non riesco a leggere i prodotti di quest'ordine" };
  if (voci.some(x => !x.chi)) return { err: "Scegli a chi va ogni prodotto" };
  const clientiL = voci.filter(x => x.chi.startsWith("n")), mieiL = voci.filter(x => x.chi === IO || x.chi === "magazzino");
  const err = ripartisci(clientiL, budgetC) || (mieiL.length ? ripartisci(mieiL, budgetM) : null);
  if (err) return { err };
  if (budgetM > 0.004 && !mieiL.length) return { err: "Nel vecchio file c'erano tuoi acquisti: assegna a te o al magazzino almeno un prodotto" };
  const vecchiProd = new Set([...G.righe, ...(I?.righe || [])].map(r => r.fonte?.prodottoId).filter(Boolean));
  const nuovi = [];
  const prodottoPer = (x, costoPool, budgetPool) => {
    const p = { id: nuovoId(), nome: x.nome, qta: x.qta, costo: budgetPool > 0 ? Math.round(costoPool * x._tot / budgetPool / x.qta * 10000) / 10000 : 0 };
    nuovi.push(p); return p;
  };
  const idCliente = (nome) => {
    const k = chiave(nome);
    if (!idPerNome.has(k)) { const id = nuovoId(); idPerNome.set(k, id); nuoviClienti.push({ id, nome }); }
    return idPerNome.get(k);
  };
  const base = { data: G.data, note: "", sconto: 0, omaggiDati: [], riacquistoGiorni: null };
  const venditeNuove = [];
  for (let j = 0; j < nomi.length; j++) {
    const sue = clientiL.filter(x => x.chi === "n" + j); if (!sue.length) continue;
    venditeNuove.push({ ...base, id: nuovoId(), clienteId: idCliente(nomi[j]), pagato: !!G.pagato, pagatoIl: G.pagatoIl || null,
      righe: sue.map(x => { const p = prodottoPer(x, costoC, budgetC);
        return { id: nuovoId(), nome: x.nome, qta: x.qta, prezzo: Math.round(x._tot / x.qta * 10000) / 10000, consegnato: G.righe[0]?.consegnato !== false, fonte: { acquistoId: A.id, prodottoId: p.id } }; }) });
  }
  const perMe = mieiL.filter(x => x.chi === IO);
  if (perMe.length) venditeNuove.push({ ...base, id: nuovoId(), clienteId: IO, pagato: true, pagatoIl: G.data,
    righe: perMe.map(x => { const p = prodottoPer(x, costoM, budgetM);
      return { id: nuovoId(), nome: x.nome, qta: x.qta, prezzo: p.costo, valoreCatalogo: Math.round(x._tot / x.qta * 100) / 100, consegnato: true, fonte: { acquistoId: A.id, prodottoId: p.id } }; }) });
  mieiL.filter(x => x.chi === "magazzino").forEach(x => prodottoPer(x, costoM, budgetM));
  const nuovoA = { ...A, prodotti: [...A.prodotti.filter(p => !vecchiProd.has(p.id)), ...nuovi] };
  return { nVendite: venditeNuove.length, mod: [
    { ref: refAcquisto(A.id), prima: senzaId(A), dopo: senzaId(nuovoA) },
    { ref: refVendita(G.id), prima: senzaId(G), dopo: null },
    ...(I ? [{ ref: refVendita(I.id), prima: senzaId(I), dopo: null }] : []),
    ...venditeNuove.map(x => ({ ref: refVendita(x.id), prima: null, dopo: senzaId(x) }))] };
}
const modClienti = (lista) => lista.map(c => ({ ref: doc(col("clienti"), c.id), prima: null, dopo: { nome: c.nome, telefono: "", note: "" } }));

// Divide da sola tutti gli ordini di gruppo che riesce a capire
function dividiAutomaticamente(venArr, acqArr, clientiExtra = []) {
  const idPerNome = new Map([...clienti, ...clientiExtra].map(c => [chiave(c.nome), c.id]));
  const nuoviClienti = [], mod = [], restano = [];
  let fatte = 0, dedotte = 0;
  for (const G of venArr.filter(v => v.clienteId === STORICO)) {
    const d = preparaDivisione(G, venArr, acqArr);
    if (!d || !completaAssegnazioni(d)) { restano.push(G); continue; }
    const r = calcolaDivisione(d, idPerNome, nuoviClienti);
    if (r.err) { restano.push(G); continue; }
    mod.push(...r.mod); fatte++; if (d.voci.some(x => x.dedotto)) dedotte++;
  }
  return { mod: [...modClienti(nuoviClienti), ...mod], fatte, dedotte, restano };
}
async function applicaModifiche(mod) {
  for (let i = 0; i < mod.length; i += 400) {
    const b = writeBatch(db);
    mod.slice(i, i + 400).forEach(m => m.dopo ? b.set(m.ref, pulisci(m.dopo)) : b.delete(m.ref));
    await b.commit();
  }
}

// Schermata per dividere a mano (controllare o correggere la proposta)
function apriDividi(G) {
  const d = preparaDivisione(G, vendite, acquisti);
  if (!d) { avviso("Questo ordine non ha i costi collegati: non posso dividerlo"); return; }
  completaAssegnazioni(d);
  const { nomi, voci, budgetC, budgetM } = d;
  sheetChiudi = null;
  const disegna = () => mantieniScroll(() => {
    const assC = somma(voci.filter(x => x.chi?.startsWith("n")), x => numIt(x.prezzo)), assM = somma(voci.filter(x => x.chi === IO || x.chi === "magazzino"), x => numIt(x.prezzo));
    const chip = (x, i, val, testo, cls = "") => `<button class="chip ${cls} ${x.chi === val ? "sel" : ""}" data-chi-div="${i}" data-val="${val}">${testo}</button>`;
    $("#sheet-body").innerHTML = testataSheet("Chi ha preso cosa?", false) + `
      <div class="sh-main">
        <div class="question">Chi ha preso cosa?</div>
        <p class="q-hint">Ho già proposto la persona usando le sigle che avevi scritto (es. MTA, NR): controlla e tocca per cambiare.</p>
        <div class="card" style="font-size:15px">
          <div class="money-row"><span>Pagato dalle clienti</span><b class="num">${euro(assC)} di ${euro(budgetC)}</b></div>
          ${budgetM ? `<div class="money-row"><span>Tuoi / magazzino</span><b class="num">${euro(assM)} di ${euro(budgetM)}</b></div>` : ""}
          <div class="hint">Se non sai un prezzo lascialo vuoto: divido il resto io.</div></div>
        ${voci.map((x, i) => `<div class="card div-item ${x.chi ? "" : "da-fare"}">
          <div class="row"><b>${x.qta > 1 ? x.qta + "× " : ""}${esc(x.nome)}</b>${x.sigla ? `<span class="badge c-gold" style="margin:0">(${esc(x.sigla)})</span>` : x.dedotto ? `<span class="badge c-blue" style="margin:0">dedotto</span>` : ""}</div>
          <div class="chips small-chips" style="margin:10px 0">${nomi.map((n, j) => chip(x, i, "n" + j, esc(n.split(" ")[0]))).join("")}
            ${budgetM ? chip(x, i, IO, "Me", "me") + chip(x, i, "magazzino", "Magazzino", "scorta") : ""}</div>
          <input data-prezzo-div="${i}" inputmode="decimal" placeholder="Prezzo € (facoltativo)" value="${esc(x.prezzo)}"></div>`).join("")}
      </div>
      <div class="sh-foot"><button class="big primary" id="div-ok">Dividi</button></div>`;
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $$("[data-chi-div]").forEach(b => b.addEventListener("click", () => { const x = voci[+b.dataset.chiDiv]; x.chi = b.dataset.val; x.dedotto = false; disegna(); }));
    $$("[data-prezzo-div]").forEach(inp => inp.addEventListener("change", () => { voci[+inp.dataset.prezzoDiv].prezzo = inp.value; disegna(); }));
    $("#div-ok").addEventListener("click", conferma);
  });
  async function conferma() {
    $$("[data-prezzo-div]").forEach(inp => { voci[+inp.dataset.prezzoDiv].prezzo = inp.value; });
    const nuoviClienti = [];
    const r = calcolaDivisione(d, new Map(clienti.map(c => [chiave(c.nome), c.id])), nuoviClienti);
    if (r.err) { avviso(r.err); $(".div-item.da-fare")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    await scriviConAnnulla([...modClienti(nuoviClienti), ...r.mod], `Diviso tra ${plurale(r.nVendite, "vendita", "vendite")}`);
    chiudiSheet(true);
  }
  disegna();
  apriSheet();
}

// =====================================================================
// OGGI
// =====================================================================
function perCliente(lista, chiaveDi) {
  const m = new Map();
  for (const x of lista) { const k = chiaveDi(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return [...m.entries()];
}

function renderHome() {
  if (!acquisti.length && !vendite.length && !clienti.length) {
    $("#view").innerHTML = `<div class="welcome">
      <h2>Benvenuta!</h2>
      <div>Qui segni cosa compri da Yves Rocher, cosa vendi alle clienti e quanto guadagni.</div>
      <ol><li>Se hai il vecchio file Excel, importalo.</li><li>Poi usa il pulsante verde ＋ per i nuovi ordini.</li></ol>
      <div class="stack"><button id="w-import">Importa il vecchio Excel</button><button id="w-new" class="primary">＋ Inizia</button></div></div>`;
    $("#w-import").addEventListener("click", sceltaFileExcel);
    $("#w-new").addEventListener("click", sceltaNuovo);
    return;
  }
  const indice = indiceProdotti(acquisti);
  const clienteDi = (v) => v.clienteId === STORICO ? STORICO + ":" + v.clientiStorico : v.clienteId;
  // richieste da ordinare
  const richieste = vendite.flatMap(v => (v.righe || []).filter(rigaDaOrdinare).map(r => ({ v, r })));
  // da consegnare: prodotti arrivati e non ancora dati
  const consegne = perCliente(vendite.flatMap(v => (v.righe || []).filter(r => !r.consegnato && !rigaDaOrdinare(r) && rigaArrivata(r)).map(r => ({ v, r }))), x => clienteDi(x.v));
  // da incassare
  const incassi = perCliente(vendite.filter(v => !isMia(v) && !v.pagato).map(v => ({ v, c: calcolaVendita(v, indice) })), x => clienteDi(x.v));
  const totIncassi = somma(incassi.flatMap(([, l]) => l), x => x.c.totale);
  const inArrivo = acquisti.filter(a => a.arrivato === false).sort((a, b) => String(a.data).localeCompare(String(b.data)));
  const ric = ricontatti();
  const compleanni = clienti.map(c => ({ c, p: prossimoCompleanno(c.compleanno) })).filter(x => x.p && x.p.giorni <= 7 && x.c.auguriFatti !== x.p.data).sort((a, b) => a.p.giorni - b.p.giorni);
  const mese = riepilogo(acquisti, vendite, oggi().slice(0, 7));

  let h = bannerBackup() + bannerSoglia();
  h += `<div class="tiles">
    <button class="tile c-orange" data-go="sec-consegne"><div class="t-ico"></div><div class="t-val">${consegne.length}</div><div class="t-lbl">da consegnare</div></button>
    <button class="tile c-pink" data-go="sec-incassi"><div class="t-ico"></div><div class="t-val num">${euro(totIncassi)}</div><div class="t-lbl">da incassare</div></button>
    <button class="tile c-blue" data-go="sec-ordinare"><div class="t-ico"></div><div class="t-val">${richieste.length}</div><div class="t-lbl">da ordinare</div></button>
    <button class="tile c-purple" data-go="sec-arrivo"><div class="t-ico"></div><div class="t-val">${inArrivo.length}</div><div class="t-lbl">in arrivo</div></button>
  </div>
  ${htmlLivello(oggi(), true)}
  <button class="tile c-green wide-tile" data-view-go="soldi"><span>Guadagno di ${new Date().toLocaleDateString("it-IT", { month: "long" })}</span><b class="num">${euro(mese.guadagno)}</b></button>`;

  if (compleanni.length) {
    h += `<div class="section"><h2>Compleanni</h2><span class="count c-pink">${compleanni.length}</span></div>`;
    for (const { c, p } of compleanni) {
      const quando = p.giorni === 0 ? "<b>Oggi!</b>" : p.giorni === 1 ? "Domani" : `Tra ${p.giorni} giorni · ${new Date(p.data + "T00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}`;
      h += `<div class="card b-pink compleanno"><div class="who">${avatar(c.nome)}<div><h3>${esc(c.nome)}</h3><div class="sub">${quando}</div></div></div>
        <div class="actions"><button class="wa" data-auguri="${c.id}">Fai gli auguri</button><button class="c-pink" data-auguri-fatti="${c.id}">✓ Fatti</button></div></div>`;
    }
  }
  if (richieste.length) {
    h += `<div class="section" id="sec-ordinare"><h2>Da ordinare</h2><span class="count c-blue">${richieste.length}</span></div>
      <div class="card b-blue">${perCliente(richieste, x => clienteDi(x.v)).map(([, l]) => `<div class="money-row"><span><b>${esc(nomeVendita(l[0].v))}</b>: ${esc(elencoRighe(l.map(x => x.r)))}</span></div>`).join("")}
      <div class="actions"><button class="primary" id="fai-ordine">Fai l'ordine a Yves Rocher</button></div></div>`;
  }
  if (inArrivo.length) {
    h += `<div class="section" id="sec-arrivo"><h2>In arrivo</h2><span class="count c-purple">${inArrivo.length}</span></div>`;
    for (const a of inArrivo) {
      h += `<div class="card b-purple"><div class="row"><div><h3>Ordine del ${dataLunga(a.data)}${a.numeroOrdine ? ` · n° ${esc(a.numeroOrdine)}` : ""}</h3>
          <div class="sub">${plurale((a.prodotti || []).length, "prodotto", "prodotti")} · ${euro(totaleAcquisto(a))}</div></div>
          <span class="badge c-purple" style="margin:0">${plurale(giorniDa(a.data), "giorno", "giorni")}</span></div>
        <div class="actions"><button class="c-purple" data-arrivato="${a.id}">È arrivato</button></div></div>`;
    }
  }
  if (consegne.length) {
    h += `<div class="section" id="sec-consegne"><h2>Da consegnare</h2><span class="count c-orange">${consegne.length}</span></div>`;
    consegne.forEach(([k, l], i) => {
      const v0 = l[0].v, c = clienti.find(x => x.id === v0.clienteId);
      h += `<div class="card b-orange"><div class="who">${avatarVendita(v0)}<div><h3>${esc(nomeVendita(v0))}</h3>
          <div class="sub">${plurale(l.length, "prodotto", "prodotti")}</div></div></div>
        <div class="what">${esc(elencoRighe(l.map(x => x.r)))}</div>
        <div class="actions"><button class="c-orange" data-consegna="${i}">✓ ${isMia(v0) ? "Ce l'ho" : "Consegnato"}</button>
          ${c ? `<button class="wa" data-wa-consegna="${i}">Avvisala</button>` : ""}</div></div>`;
    });
  }
  if (incassi.length) {
    h += `<div class="section" id="sec-incassi"><h2>Devono pagarti</h2><span class="count c-pink">${euro(totIncassi)}</span></div>`;
    incassi.forEach(([k, l], i) => {
      const v0 = l[0].v, c = clienti.find(x => x.id === v0.clienteId);
      h += `<div class="card b-pink"><div class="row"><div class="who">${avatarVendita(v0)}<div><h3>${esc(nomeVendita(v0))}</h3>
          <div class="sub">${esc(elencoRighe(l.flatMap(x => x.v.righe || [])))}</div></div></div><div class="amount num" style="color:var(--pink)">${euro(somma(l, x => x.c.totale))}</div></div>
        <div class="actions"><button class="c-pink" data-paga="${i}">✓ Ha pagato</button>
          ${c ? `<button class="wa" data-wa-paga="${i}">Ricordaglielo</button>` : ""}</div></div>`;
    });
  }
  if (ric.length) {
    h += `<div class="section" id="sec-ric"><h2>Da sentire</h2><span class="count c-purple">${ric.length}</span></div>
      <p class="section-hint">Clienti che non comprano da un po', o con un prodotto che sta finendo.</p>`;
    ric.forEach((x, i) => {
      h += `<div class="card b-purple"><div class="who">${avatar(x.cliente.nome)}<div><h3>${esc(x.cliente.nome)}</h3>
          <div class="sub">${x.tipo === "riacquisto" ? `Sta finendo: ${esc(x.prodotti)}` : `Ultimo acquisto ${x.giorni} giorni fa`}</div></div></div>
        <div class="actions"><button class="wa" data-ric="${i}">Scrivile</button><button class="c-purple" data-ricfatto="${x.cliente.id}">✓ Sentita</button></div></div>`;
    });
  }
  if (!richieste.length && !inArrivo.length && !consegne.length && !incassi.length && !ric.length && !compleanni.length)
    h += `<div class="empty"><div class="e-ico"></div><b>Tutto in ordine!</b><br>Niente da consegnare, ordinare o incassare.</div>`;
  $("#view").innerHTML = h;

  $$("[data-go]").forEach(b => b.addEventListener("click", () => $("#" + b.dataset.go)?.scrollIntoView({ behavior: "smooth", block: "start" })));
  $$("[data-view-go]").forEach(b => b.addEventListener("click", () => vai(b.dataset.viewGo)));
  $("#fai-ordine")?.addEventListener("click", () => apriAcquisto(null, { richieste: true }));
  $("#banner-backup")?.addEventListener("click", scaricaBackup);
  $$("[data-arrivato]").forEach(b => b.addEventListener("click", async () => {
    const a = acquistoDi(b.dataset.arrivato);
    await scriviConAnnulla([{ ref: refAcquisto(a.id), prima: senzaId(a), dopo: { ...senzaId(a), arrivato: true, arrivatoIl: oggi() } }], "Arrivato! I prodotti sono pronti da consegnare");
  }));
  $$("[data-consegna]").forEach(b => b.addEventListener("click", async () => {
    const [, l] = consegne[+b.dataset.consegna];
    const perVendita = perCliente(l, x => x.v.id);
    const mod = perVendita.map(([, xs]) => { const v = xs[0].v, ids = new Set(xs.map(x => x.r.id));
      return { ref: refVendita(v.id), prima: senzaId(v), dopo: { ...senzaId(v), righe: v.righe.map(r => ids.has(r.id) ? { ...r, consegnato: true } : r) } }; });
    await scriviConAnnulla(mod, `${nomeVendita(l[0].v)}: consegnato`);
  }));
  $$("[data-paga]").forEach(b => b.addEventListener("click", async () => {
    const [, l] = incassi[+b.dataset.paga];
    const mod = l.map(x => ({ ref: refVendita(x.v.id), prima: senzaId(x.v), dopo: { ...senzaId(x.v), pagato: true, pagatoIl: oggi() } }));
    await scriviConAnnulla(mod, `${nomeVendita(l[0].v)}: ${euro(somma(l, x => x.c.totale))} incassati`);
  }));
  $$("[data-wa-consegna]").forEach(b => b.addEventListener("click", () => {
    const [, l] = consegne[+b.dataset.waConsegna]; const c = clienti.find(x => x.id === l[0].v.clienteId);
    apriWhatsApp(c, msgConsegna(c, l.map(x => x.r)));
  }));
  $$("[data-wa-paga]").forEach(b => b.addEventListener("click", () => {
    const [, l] = incassi[+b.dataset.waPaga]; const c = clienti.find(x => x.id === l[0].v.clienteId);
    apriWhatsApp(c, msgPagamento(c, somma(l, x => x.c.totale), l.flatMap(x => x.v.righe || [])));
  }));
  $$("[data-ric]").forEach(b => b.addEventListener("click", () => { const x = ric[+b.dataset.ric]; apriWhatsApp(x.cliente, msgRicontatto(x)); }));
  $$("[data-ricfatto]").forEach(b => b.addEventListener("click", async () => {
    const c = clienti.find(x => x.id === b.dataset.ricfatto); const prima = c.ultimoContatto || null;
    await setDoc(doc(col("clienti"), c.id), { ultimoContatto: oggi() }, { merge: true });
    avviso(`${c.nome}: sentita`, () => setDoc(doc(col("clienti"), c.id), { ultimoContatto: prima }, { merge: true }));
  }));
  $$("[data-auguri]").forEach(b => b.addEventListener("click", () => { const c = clienti.find(x => x.id === b.dataset.auguri); apriWhatsApp(c, msgAuguri(c)); }));
  $$("[data-auguri-fatti]").forEach(b => b.addEventListener("click", async () => {
    const c = clienti.find(x => x.id === b.dataset.auguriFatti); const p = prossimoCompleanno(c.compleanno); const prima = c.auguriFatti || null;
    await setDoc(doc(col("clienti"), c.id), { auguriFatti: p.data }, { merge: true });
    avviso(`Auguri a ${primoNome(c)} fatti`, () => setDoc(doc(col("clienti"), c.id), { auguriFatti: prima }, { merge: true }));
  }));
}

// =====================================================================
// OMAGGI (dentro Acquisti)
// =====================================================================
function htmlOmaggi() {
  const g = giacenzaOmaggi(ordiniPerOmaggi(), movimenti);
  const restano = somma(g, v => Math.max(0, v.giacenza)), arrivati = somma(g, v => v.ricevuti + Math.max(0, v.rettifiche)), regalati = somma(g, v => v.dati + Math.max(0, -v.rettifiche));
  const daConvertire = acquisti.filter(a => a.omaggiNote && !(a.omaggiRicevuti || []).length && parseOmaggi(a.omaggiNote).length);
  const listaOm = (arr) => arr.map(x => `<span class="gift-pill">${x.qta > 1 ? `<b>${x.qta}×</b> ` : ""}${esc(x.nome)}</span>`).join("");
  let h = daConvertire.length ? `<div class="card b-gold" style="background:var(--gold-soft)"><h3>Omaggi del vecchio file</h3>
      <div class="sub" style="color:var(--text)">In ${plurale(daConvertire.length, "ordine", "ordini")} gli omaggi sono solo scritti come testo e non vengono contati.</div>
      <div class="actions"><button class="primary" id="converti-omaggi">Trasformali in omaggi veri</button></div></div>` : "";
  h += `<div class="tiles tiles3">
      <div class="tile c-gold"><div class="t-ico"></div><div class="t-val">${restano}</div><div class="t-lbl">ti restano</div></div>
      <div class="tile c-green"><div class="t-ico"></div><div class="t-val">${arrivati}</div><div class="t-lbl">arrivati</div></div>
      <div class="tile c-pink"><div class="t-ico"></div><div class="t-val">${regalati}</div><div class="t-lbl">regalati</div></div></div>
    <div class="segmented"><button data-vo="ordini" class="${vistaOmaggi === "ordini" ? "on" : ""}">Cronologia</button>
      <button data-vo="omaggi" class="${vistaOmaggi === "omaggi" ? "on" : ""}">Per omaggio</button></div>`;
  if (!g.length && !daConvertire.length) return h + `<div class="empty"><div class="e-ico"></div><b>Nessun omaggio ancora</b><br>
    Quelli arrivati li segni nell'ordine a Yves Rocher; quelli regalati nell'ordine della cliente.</div>`;
  if (vistaOmaggi === "ordini") {
    const eventi = [
      ...acquisti.filter(a => (a.omaggiRicevuti || []).length || a.omaggiNote).map(a => ({ data: a.data, html: `<div class="card b-gold tap" data-om-acq="${a.id}">
        <div class="row"><b>Arrivati con l'ordine del ${dataLunga(a.data)}</b><span class="muted">›</span></div>
        <div style="margin-top:8px">${listaOm(a.omaggiRicevuti || [])}</div>${a.omaggiNote ? `<div class="hint">Dal vecchio file: ${esc(a.omaggiNote)}</div>` : ""}</div>` })),
      ...vendite.filter(v => (v.omaggiDati || []).length || v.omaggioVecchio).map(v => ({ data: v.data, html: `<div class="card b-pink tap" data-om-ven="${v.id}">
        <div class="row"><b>Regalati a ${esc(nomeVendita(v))} · ${dataLunga(v.data)}</b><span class="muted">›</span></div>
        <div style="margin-top:8px">${listaOm(v.omaggiDati || [])}</div>${v.omaggioVecchio ? `<div class="hint">Dal vecchio file: ${esc(v.omaggioVecchio)}</div>` : ""}</div>` })),
      ...movimenti.map(m => ({ data: m.data, html: `<div class="card"><div class="row"><span>A mano · ${dataLunga(m.data)} · ${esc(m.nome)}</span>
        <span><b class="num" style="color:${m.qta > 0 ? "var(--green)" : "var(--pink)"}">${m.qta > 0 ? "+" : ""}${m.qta}</b>
        <button class="x-mini" data-delmov="${m.id}" aria-label="Elimina">×</button></span></div></div>` }))
    ].sort((a, b) => String(b.data).localeCompare(String(a.data)));
    h += eventi.map(e => e.html).join("");
  } else {
    for (const v of g) {
      h += `<div class="card b-gold"><div class="gift">
        <div class="g-n"><h3>${esc(v.nome)}</h3><div class="sub">arrivati ${v.ricevuti + Math.max(0, v.rettifiche)} · regalati ${v.dati + Math.max(0, -v.rettifiche)}</div></div>
        <div class="g-q" style="color:${v.giacenza < 0 ? "var(--red)" : "var(--gold)"}">${v.giacenza}</div>
        <div class="g-b"><button class="c-pink" data-mov="${esc(v.nome)}" data-q="-1" aria-label="Uno in meno">−</button>
          <button class="c-green" data-mov="${esc(v.nome)}" data-q="1" aria-label="Uno in più">＋</button></div></div>
        ${v.giacenza < 0 ? `<div class="hint" style="color:var(--red)">Ne risultano regalati più di quelli arrivati: forse manca un arrivo in un ordine.</div>` : ""}
        <details class="storia"><summary>Da dove arrivano e a chi sono andati</summary>${v.eventi.map(evento).join("")}</details></div>`;
    }
  }
  return h;
}
function evento(e) {
  const quando = dataLunga(e.data);
  if (e.tipo === "arrivati") return `<div class="evento"><span class="ev-ico c-green"></span><div><b>${e.qta} arrivati</b> con l'ordine del ${quando}</div></div>`;
  if (e.tipo === "regalati") return `<div class="evento"><span class="ev-ico c-pink"></span><div><b>${e.qta} a ${esc(nomeClienteId(e.clienteId, vendite.find(v => v.id === e.ordineId)))}</b> · ${quando}</div></div>`;
  return `<div class="evento"><span class="ev-ico c-gold"></span><div><b>${e.qta > 0 ? "+" : ""}${e.qta} a mano</b> · ${quando}</div></div>`;
}
function collegaVistaOmaggi() {
  $$("[data-vo]").forEach(b => b.addEventListener("click", () => { vistaOmaggi = b.dataset.vo; render(); }));
  $$("[data-om-acq]").forEach(el => el.addEventListener("click", () => apriAcquisto(acquistoDi(el.dataset.omAcq))));
  $$("[data-om-ven]").forEach(el => el.addEventListener("click", () => apriVendita(vendite.find(v => v.id === el.dataset.omVen))));
  $$("[data-mov]").forEach(b => b.addEventListener("click", async () => {
    const ref = await addDoc(col("movimentiOmaggi"), { nome: b.dataset.mov, qta: Number(b.dataset.q), data: oggi(), nota: "" });
    avviso(`${b.dataset.mov}: ${b.dataset.q > 0 ? "uno in più" : "uno in meno"}`, () => deleteDoc(ref));
  }));
  $$("[data-delmov]").forEach(b => b.addEventListener("click", async () => {
    const m = movimenti.find(x => x.id === b.dataset.delmov);
    await scriviConAnnulla([{ ref: doc(col("movimentiOmaggi"), m.id), prima: senzaId(m), dopo: null }], "Tolto");
  }));
  $("#converti-omaggi")?.addEventListener("click", async () => {
    const lista = acquisti.filter(a => a.omaggiNote && !(a.omaggiRicevuti || []).length && parseOmaggi(a.omaggiNote).length);
    const tot = somma(lista, a => somma(parseOmaggi(a.omaggiNote), x => x.qta));
    if (!confirm(`Trasformo ${tot} omaggi scritti nel vecchio file in omaggi arrivati con i rispettivi ordini. Continuo?`)) return;
    await scriviConAnnulla(lista.map(a => ({ ref: refAcquisto(a.id), prima: senzaId(a),
      dopo: { ...senzaId(a), omaggiRicevuti: parseOmaggi(a.omaggiNote), omaggiNote: "", omaggiNoteOriginale: a.omaggiNote } })), `${tot} omaggi aggiunti`);
  });
}
function apriNuovoOmaggio() {
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Nuovo omaggio", false) + `
    <div class="sh-main"><div class="question">Che omaggio ti è arrivato?</div>
      <p class="q-hint">Per campioncini e regali arrivati fuori da un ordine.</p>
      <label>Nome</label><input id="no-nome" list="dl-omaggi" placeholder="Es. campioncini crema" autocomplete="off">
      <label>Quanti?</label><input id="no-qta" class="money" inputmode="numeric" value="1"></div>
    <div class="sh-foot"><button class="big primary" id="no-ok">✓ Aggiungi</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#no-ok").addEventListener("click", async () => {
    const nome = $("#no-nome").value.trim(); if (!nome) return $("#no-nome").focus();
    await addDoc(col("movimentiOmaggi"), { nome, qta: Math.max(1, parseInt($("#no-qta").value) || 1), data: oggi(), nota: "" });
    chiudiSheet(true); avviso("Omaggio aggiunto");
  });
  apriSheet();
}

// =====================================================================
// CLIENTI
// =====================================================================
function renderClienti() {
  const indice = indiceProdotti(acquisti);
  const camp = impostazioni.campagna;
  let h = `<button class="tile c-purple campagna-btn" id="apri-campagna"><div class="row"><div>
      <div class="t-lbl" style="font-size:17px">Scrivi a tutte le clienti</div>
      <div style="font-size:14px;font-weight:500;opacity:.85">${camp ? `Messaggio in corso: inviato a ${(camp.inviati || []).length}` : "Nuovo catalogo, promozioni, ordine in partenza"}</div></div>
      <span style="font-size:24px">›</span></div></button>`;
  if (!clienti.length) { $("#view").innerHTML = h + `<div class="empty"><div class="e-ico"></div><b>Nessuna cliente</b><br>Si aggiungono da sole quando segni un ordine.</div>`; $("#apri-campagna").addEventListener("click", () => apriCampagna()); return; }
  h += `<input type="search" id="cerca" class="search" placeholder="Cerca una cliente" value="${esc(cercaClienti)}">`;
  const filtrate = clienti.filter(c => !cercaClienti || chiave(c.nome).includes(chiave(cercaClienti)));
  for (const c of filtrate) {
    const sue = venditeCliente(c);
    const deve = somma(sue.filter(v => v.clienteId === c.id && !v.pagato), v => calcolaVendita(v, indice).totale);
    const ultimo = sue.map(v => v.data).filter(Boolean).sort().pop();
    h += `<div class="card tap" data-cli="${c.id}"><div class="row"><div class="who">${avatar(c.nome)}<div><h3>${esc(c.nome)}</h3>
      <div class="sub">${ultimo ? `Ultimo acquisto: ${dataLunga(ultimo)}` : "Nessun acquisto"}${c.compleanno ? ` · compleanno ${compleannoTesto(c.compleanno)}` : ""}</div></div></div>
      ${deve ? `<span class="badge c-pink num" style="margin:0">deve ${euro(deve)}</span>` : ""}</div></div>`;
  }
  if (!filtrate.length) h += `<div class="empty">Nessuna cliente con questo nome.</div>`;
  $("#view").innerHTML = h;
  $("#cerca").addEventListener("input", (e) => { cercaClienti = e.target.value; const pos = e.target.selectionStart; renderClienti(); const i = $("#cerca"); i.focus(); i.setSelectionRange(pos, pos); });
  $$("[data-cli]").forEach(el => el.addEventListener("click", () => apriCliente(clienti.find(c => c.id === el.dataset.cli))));
  $("#apri-campagna").addEventListener("click", () => apriCampagna());
}

function apriCliente(c) {
  const indice = indiceProdotti(acquisti);
  const sue = c ? venditeCliente(c).sort((a, b) => String(b.data).localeCompare(String(a.data))) : [];
  const proprie = sue.filter(v => v.clienteId === c?.id);
  const speso = somma(proprie, v => calcolaVendita(v, indice).totale);
  const nonPagate = proprie.filter(v => !v.pagato);
  const daPagare = somma(nonPagate, v => calcolaVendita(v, indice).totale);
  const daConsegnare = proprie.flatMap(v => (v.righe || []).filter(r => !r.consegnato && !rigaDaOrdinare(r) && rigaArrivata(r)));
  const [cm, cg] = (c?.compleanno || "-").split("-");
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet(c ? "Cliente" : "Nuova cliente", false) + `
    <div class="sh-main">
      ${c ? `<div style="text-align:center;margin:6px 0 16px">
          <div class="avatar ${coloreDi(c.nome)}" style="width:76px;height:76px;font-size:30px;margin:0 auto">${esc(iniziali(c.nome))}</div>
          <div class="question" style="margin-top:8px">${esc(c.nome)}</div>${c.compleanno ? `<div class="muted">Compleanno: ${compleannoTesto(c.compleanno)}</div>` : ""}</div>
        <div class="tiles">
          <div class="tile c-blue"><div class="t-ico"></div><div class="t-val num">${euro(speso)}</div><div class="t-lbl">spesi in totale</div></div>
          <div class="tile ${daPagare ? "c-pink" : "c-green"}"><div class="t-ico"></div><div class="t-val num">${euro(daPagare)}</div><div class="t-lbl">da pagare</div></div></div>
        <div class="stack" style="margin:12px 0 4px">
          <button class="primary" id="c-nuova-vendita">Nuovo ordine per lei</button>
          ${daConsegnare.length ? `<button class="wa" id="wa-consegna">Avvisala che è arrivato</button>` : ""}
          ${daPagare ? `<button class="wa" id="wa-paga">Ricordale il pagamento</button>` : ""}
          <button class="wa" id="wa-libero">Scrivile su WhatsApp</button>
          ${c.telefono ? `<a href="tel:${esc(c.telefono.replace(/\s/g, ""))}" style="text-decoration:none"><button class="c-blue" style="width:100%;text-align:left">Chiamala</button></a>` : ""}
        </div>` : `<div class="question">Nuova cliente</div>`}
      <div class="yesno" style="margin-top:14px">
        <label style="margin-top:0">Nome</label><input id="c-nome" value="${esc(c?.nome)}" placeholder="Es. Giulia Rossi">
        <label>Cellulare (per WhatsApp)</label><input id="c-tel" type="tel" value="${esc(c?.telefono)}" placeholder="333 1234567">
        <label>Compleanno (facoltativo)</label>
        <div class="grid-compleanno"><select id="c-giorno"><option value="">Giorno</option>${Array.from({ length: 31 }, (_, i) => { const x = String(i + 1).padStart(2, "0"); return `<option value="${x}" ${cg === x ? "selected" : ""}>${i + 1}</option>`; }).join("")}</select>
          <select id="c-mese"><option value="">Mese</option>${MESI.map((nm, i) => { const x = String(i + 1).padStart(2, "0"); return `<option value="${x}" ${cm === x ? "selected" : ""}>${nm}</option>`; }).join("")}</select></div>
        <label>Note (tipo di pelle, gusti…)</label><textarea id="c-note">${esc(c?.note)}</textarea></div>
      ${sue.length ? `<div class="section"><h2>Acquisti</h2></div>${sue.map(v => { const cv = calcolaVendita(v, indice); return `<div class="card tap" data-sua="${v.id}" style="padding:12px 16px">
        <div class="row"><b>${dataLunga(v.data)}</b><span class="num">${v.clienteId === STORICO ? "ordine di gruppo" : euro(cv.totale)}</span></div>
        <div class="sub">${esc(elencoRighe(v.righe || []))}</div>
        ${v.clienteId !== STORICO && !v.pagato ? `<span class="badge c-pink">da pagare</span>` : ""}</div>`; }).join("")}` : ""}
      ${c && !proprie.length ? `<button class="danger" id="c-del" style="width:100%;margin-top:10px">Elimina cliente</button>` : ""}
    </div>
    <div class="sh-foot"><button class="big primary" id="c-save">✓ Salva</button></div>`;
  const corrente = () => ({ ...c, nome: $("#c-nome").value.trim(), telefono: $("#c-tel").value.trim() });
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#c-nuova-vendita")?.addEventListener("click", () => apriVendita(null, { clienteId: c.id }));
  $("#wa-consegna")?.addEventListener("click", () => apriWhatsApp(corrente(), msgConsegna(corrente(), daConsegnare)));
  $("#wa-paga")?.addEventListener("click", () => apriWhatsApp(corrente(), msgPagamento(corrente(), daPagare, nonPagate.flatMap(v => v.righe || []))));
  $("#wa-libero")?.addEventListener("click", () => apriWhatsApp(corrente(), componi("libero", { nome: primoNome(corrente()) })));
  $$("[data-sua]").forEach(el => el.addEventListener("click", () => apriVendita(vendite.find(v => v.id === el.dataset.sua))));
  $("#c-save").addEventListener("click", async () => {
    const nome = $("#c-nome").value.trim(); if (!nome) return $("#c-nome").focus();
    const g = $("#c-giorno").value, m = $("#c-mese").value;
    if ((g && !m) || (!g && m)) { avviso("Per il compleanno scegli sia il giorno sia il mese"); return; }
    const dati = { nome, telefono: $("#c-tel").value.trim(), note: $("#c-note").value, compleanno: g && m ? `${m}-${g}` : null };
    if (c) await setDoc(doc(col("clienti"), c.id), dati, { merge: true }); else await addDoc(col("clienti"), dati);
    chiudiSheet(true); avviso("✓ Salvato");
  });
  $("#c-del")?.addEventListener("click", async () => {
    if (!confirm(`Eliminare ${c.nome}?`)) return;
    await scriviConAnnulla([{ ref: doc(col("clienti"), c.id), prima: senzaId(c), dopo: null }], "Cliente eliminata");
    chiudiSheet(true);
  });
  apriSheet();
}

// ---------- Messaggio a tutte le clienti ----------
const MODELLI_CAMPAGNA = [["catalogo", "Nuovo catalogo"], ["promozioni", "Promozioni"], ["ordine", "Sto per ordinare"], ["libero", "Scrivo io"]];
function apriCampagna() {
  let camp = impostazioni.campagna ? structuredClone(impostazioni.campagna) : null;
  let bozza = camp?.testo || testoMessaggio("catalogo");
  let solo6mesi = camp?.solo6mesi || false;
  sheetChiudi = null;
  const salvaCamp = (dati) => setDoc(docImpostazioni(), { campagna: dati }, { merge: true });
  const destinatarie = () => {
    const limite = new Date(Date.parse(oggi() + "T00:00Z") - 183 * 86400000).toISOString().slice(0, 10);
    return clienti.filter(c => !solo6mesi || venditeCliente(c).some(v => (v.data || "") >= limite));
  };
  function schermataTesto() {
    $("#sheet-body").innerHTML = testataSheet("Scrivi a tutte", false) + `
      <div class="sh-main"><div class="question">Cosa vuoi scrivere?</div>
        <p class="q-hint">Scegli un messaggio pronto e modificalo come vuoi. Dove c'è <b>{nome}</b> metto il nome di ogni cliente.</p>
        <div class="chips small-chips" style="margin-bottom:12px">${MODELLI_CAMPAGNA.map(([k, t]) => `<button class="chip" data-modello="${k}">${t}</button>`).join("")}</div>
        <textarea id="camp-testo" style="min-height:150px">${esc(bozza)}</textarea>
        <div class="yesno" style="margin-top:14px"><div class="yn-q">A chi?</div><div class="chips">
          <button class="chip ${!solo6mesi ? "sel" : ""}" data-chi6="0">Tutte</button>
          <button class="chip ${solo6mesi ? "sel" : ""}" data-chi6="1">Chi ha comprato negli ultimi 6 mesi</button></div></div></div>
      <div class="sh-foot"><button class="big primary" id="camp-avanti">Avanti →</button></div>`;
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $$("[data-modello]").forEach(b => b.addEventListener("click", () => { bozza = testoMessaggio(b.dataset.modello); $("#camp-testo").value = bozza; }));
    $("#camp-testo").addEventListener("input", (e) => { bozza = e.target.value; });
    $$("[data-chi6]").forEach(b => b.addEventListener("click", () => { solo6mesi = b.dataset.chi6 === "1"; schermataTesto(); }));
    $("#camp-avanti").addEventListener("click", async () => {
      if (!bozza.trim()) return $("#camp-testo").focus();
      camp = { testo: bozza, solo6mesi, creata: camp?.creata || oggi(), inviati: camp && camp.testo === bozza ? camp.inviati || [] : [] };
      await salvaCamp(camp); schermataInvio();
    });
  }
  function schermataInvio() {
    const lista = destinatarie();
    const conNumero = lista.filter(c => c.telefono), senza = lista.filter(c => !c.telefono);
    const fatti = conNumero.filter(c => camp.inviati.includes(c.id)).length;
    $("#sheet-body").innerHTML = testataSheet("Scrivi a tutte", false) + `
      <div class="sh-main"><div class="question">Inviato a ${fatti} di ${conNumero.length}</div>
        <div class="progress"><span style="width:${conNumero.length ? Math.round(fatti / conNumero.length * 100) : 0}%"></span></div>
        <p class="q-hint" style="margin-top:12px">Tocca “Invia”: si apre WhatsApp con il messaggio pronto. Premi invia lì e torna qui per la prossima.</p>
        <div class="card" style="background:var(--wa-soft);color:var(--text);font-size:15px">${esc(camp.testo.replaceAll("{nome}", primoNome(conNumero[0] || { nome: "Giulia" })))}</div>
        ${conNumero.map(c => { const ok = camp.inviati.includes(c.id); return `<div class="item invio ${ok ? "ok" : ""}">${avatar(c.nome)}<div class="i-name"><b>${esc(c.nome)}</b></div>
          <button class="${ok ? "c-green" : "wa"} pill" data-invia="${c.id}">${ok ? "✓ Inviato" : "Invia"}</button></div>`; }).join("")}
        ${senza.length ? `<div class="section"><h2>Senza numero</h2><span class="count c-gold">${senza.length}</span></div>
          <p class="section-hint">Aggiungi il cellulare dalla scheda cliente per poterle scrivere.</p>
          <div class="chips small-chips">${senza.map(c => `<span class="chip" style="box-shadow:none;opacity:.75">${esc(c.nome)}</span>`).join("")}</div>` : ""}
        <div class="stack" style="margin-top:20px"><button id="camp-modifica">Cambia il messaggio</button>
          <button id="camp-fine" class="danger" style="text-align:center">✓ Ho finito, chiudi questo messaggio</button></div></div>`;
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $$("[data-invia]").forEach(b => b.addEventListener("click", async () => {
      const c = clienti.find(x => x.id === b.dataset.invia);
      window.open(linkWhatsApp(c.telefono, camp.testo.replaceAll("{nome}", primoNome(c))), "_blank");
      if (!camp.inviati.includes(c.id)) { camp.inviati = [...camp.inviati, c.id]; await salvaCamp(camp); }
      mantieniScroll(schermataInvio);
    }));
    $("#camp-modifica").addEventListener("click", () => { bozza = camp.testo; schermataTesto(); });
    $("#camp-fine").addEventListener("click", async () => {
      const prima = camp; await setDoc(docImpostazioni(), { campagna: null }, { merge: true }); chiudiSheet(true);
      avviso("Messaggio chiuso", () => setDoc(docImpostazioni(), { campagna: prima }, { merge: true }));
    });
  }
  if (camp) schermataInvio(); else schermataTesto();
  apriSheet();
}

// =====================================================================
// RIEPILOGO
// =====================================================================
function renderSoldi() {
  const nomeMese = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  const meseBreve = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "short", year: "2-digit" });
  const sposta = (k, d) => { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7); };
  const ultimo = oggi().slice(0, 7);
  const m = riepilogo(acquisti, vendite, meseSel), tot = riepilogo(acquisti, vendite);
  const merce = valoreMagazzino(acquisti, vendite);
  const mesi = mesiPresenti(acquisti, vendite).map(k => ({ k, ...riepilogo(acquisti, vendite, k) }));
  const max = Math.max(1, ...mesi.map(x => Math.abs(x.guadagno)));
  const tile = (cls, ico, val, lbl) => `<div class="tile ${cls}"><div class="t-ico">${ico}</div><div class="t-val num">${euro(val)}</div><div class="t-lbl">${lbl}</div></div>`;

  $("#view").innerHTML = `
    <div class="month-nav"><button id="m-prev" aria-label="Mese prima">‹</button><div class="m">${nomeMese(meseSel)}</div>
      <button id="m-next" aria-label="Mese dopo" ${meseSel >= ultimo ? "disabled style='opacity:.3'" : ""}>›</button></div>
    <div class="big-money ${m.guadagno >= 0 ? "c-green" : "c-pink"}"><div style="font-weight:700">Guadagno del mese</div>
      <div class="v num">${euro(m.guadagno)}</div><div style="font-size:14px;opacity:.85">prezzo di vendita meno quanto avevi pagato quei prodotti</div></div>
    ${htmlLivello(meseSel + "-15", false)}
    ${(() => { const sg = sogliaAcquisti(); if (!sg) return ""; const perc = m.spesoAcquisti / sg;
      return `<div class="card soglia-card"><div class="row"><span>Acquisti del mese</span><b class="num" style="color:${perc >= 1 ? "var(--red)" : "inherit"}">${euro(m.spesoAcquisti)} di ${euro(sg)}</b></div>
        <div class="progress"><span style="width:${Math.min(100, Math.round(perc * 100))}%;background:${perc >= 1 ? "var(--red)" : perc >= 0.8 ? "var(--gold)" : "var(--green)"}"></span></div>
        ${perc >= 1 ? `<div class="hint" style="color:var(--red)">Soglia superata di ${euro(m.spesoAcquisti - sg)}</div>` : `<div class="hint">Ti restano ${euro(sg - m.spesoAcquisti)} prima della soglia</div>`}</div>`; })()}
    <div class="tiles">
      ${tile("c-orange", "", m.spesoAcquisti, "speso in acquisti")}
      ${tile("c-green", "", m.incassato, "incassato")}
      ${tile("c-purple", "", m.daIncassare, "ancora da incassare")}
      ${tile("c-pink", "", m.spesoPerMe, "speso per te")}
      ${tile("c-blue", "", m.venduto, "venduto alle clienti")}
      ${tile("c-gold", "", merce, "merce in casa (oggi)")}
    </div>

    ${htmlClassifica(meseSel + "-15")}

    <div class="section"><h2>Da sempre</h2></div>
    <div class="card">
      <div class="money-row"><span>Speso in acquisti</span><b class="num">${euro(tot.spesoAcquisti)}</b></div>
      <div class="money-row"><span>Incassato dalle clienti</span><b class="num">${euro(tot.incassato)}</b></div>
      <div class="money-row"><span>Ancora da incassare</span><b class="num">${euro(tot.daIncassare)}</b></div>
      <div class="money-row"><span>Speso per te</span><b class="num">${euro(tot.spesoPerMe)}</b></div>
      <div class="money-row"><span>Merce ancora in casa</span><b class="num">${euro(merce)}</b></div>
      <div class="money-row"><span><b>Guadagno</b></span><b class="num" style="color:${tot.guadagno >= 0 ? "var(--green)" : "var(--red)"}">${euro(tot.guadagno)}</b></div>
      <div class="hint">Dove sono finiti i soldi spesi: ${euro(tot.costoVenduto)} in prodotti venduti, ${euro(tot.spesoPerMe)} per te, ${euro(merce)} in magazzino.</div>
    </div>

    <div class="section"><h2>Mese per mese</h2></div>
    <div class="card" style="padding:8px 14px">
      ${mesi.length ? mesi.map(x => `<button class="mese-riga ${x.k === meseSel ? "sel" : ""}" data-mese="${x.k}">
          <span class="mr-nome">${meseBreve(x.k)}</span>
          <span><span class="mr-barra"><span class="${x.guadagno >= 0 ? "pos" : "neg"}" style="width:${Math.max(3, Math.round(Math.abs(x.guadagno) / max * 100))}%"></span></span>
            <span class="mr-sub">speso ${euro(x.spesoAcquisti)} · incassato ${euro(x.incassato)}</span></span>
          <span class="mr-val num" style="color:${x.guadagno >= 0 ? "var(--green)" : "var(--red)"}">${euro(x.guadagno)}</span></button>`).join("")
        : `<div class="empty" style="padding:16px">Ancora niente.</div>`}
    </div>

    <div class="section"><h2>Impostazioni</h2></div>
    <div class="yesno" id="box-notifiche"><div class="yn-q">Notifiche</div><div class="hint" style="margin:0">Controllo…</div></div>
    <div class="yesno"><div class="yn-q">Livelli</div>
      <div class="hint" style="margin:-4px 0 10px">Il livello si calcola per trimestre (gennaio–marzo, aprile–giugno, luglio–settembre, ottobre–dicembre) su tutti gli ordini: quelli delle clienti dal giorno in cui te li chiedono, più i tuoi "Per me".</div>
      <div class="livello-soglie">${[["base", "Base da"], ["expert", "Expert da"], ["prestige", "Prestige da"]].map(([k, t]) =>
        `<div><label>${t}</label><input data-lv-soglia="${k}" inputmode="decimal" value="${esc(inIt(prefLivelli().soglie[k]))}"></div>`).join("")}</div>
      <button class="c-blue" id="lv-salva" style="width:100%;margin-top:10px">Salva livelli</button></div>
    <div class="yesno"><div class="yn-q">Avvisami quando gli acquisti del mese superano</div>
      <div class="chips">${[[150, "150 €"], [250, "250 €"], [400, "400 €"], [0, "Mai"]].map(([x, t]) => `<button class="chip ${sogliaAcquisti() === x ? "sel" : ""}" data-soglia="${x}">${t}</button>`).join("")}</div>
      <div class="two-col" style="margin-top:10px"><input id="soglia-altro" inputmode="decimal" placeholder="Altra cifra €" value="${[150, 250, 400, 0].includes(sogliaAcquisti()) ? "" : esc(inIt(sogliaAcquisti()))}">
        <button class="c-gold" id="soglia-ok">Imposta</button></div>
      <div class="hint">Ti avviso in Oggi, quando salvi un ordine che la supera e con una notifica (se attive).</div></div>
    <div class="yesno"><div class="yn-q">Avvisami delle clienti che non comprano da</div><div class="chips">
      ${[[0, "Mai"], [30, "1 mese"], [60, "2 mesi"], [90, "3 mesi"]].map(([g, t]) => `<button class="chip ${Number(impostazioni.giorniRicontatto) === g ? "sel" : ""}" data-giorni="${g}">${t}</button>`).join("")}</div></div>
    <div class="stack">
      <button id="b-messaggi">Messaggi alle clienti<div class="hint">Personalizza i testi che mandi su WhatsApp</div></button>
      <button id="b-backup">Salva una copia di sicurezza${impostazioni.ultimoBackup ? `<div class="hint">Ultima: ${dataIt(impostazioni.ultimoBackup)}</div>` : ""}</button>
      <button id="b-export">Scarica tutto in Excel</button>
      <button id="b-import">Importa il vecchio file Excel</button>
      <button id="b-restore">Ripristina una copia di sicurezza</button>
    </div>
    <input type="file" id="file-restore" accept=".json,application/json" class="hidden">
    <button class="ghost" id="b-logout" style="width:100%;margin-top:22px">Esci (${esc(auth.currentUser?.email)})</button>
    <p class="versione" style="text-align:center">v24</p>`;
  $$("[data-mese]").forEach(b => b.addEventListener("click", () => { meseSel = b.dataset.mese; renderSoldi(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  $("#m-prev").addEventListener("click", () => { meseSel = sposta(meseSel, -1); renderSoldi(); });
  $("#m-next").addEventListener("click", () => { if (meseSel < ultimo) { meseSel = sposta(meseSel, 1); renderSoldi(); } });
  disegnaNotifiche();
  $$("[data-giorni]").forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { giorniRicontatto: Number(b.dataset.giorni) }, { merge: true })));
  $("#lv-salva").addEventListener("click", () => {
    const soglie = Object.fromEntries($$("[data-lv-soglia]").map(i => [i.dataset.lvSoglia, numIt(i.value)]));
    if (!(soglie.base < soglie.expert && soglie.expert < soglie.prestige)) return avviso("Le soglie devono crescere: Base < Expert < Prestige");
    setDoc(docImpostazioni(), { livelli: { ...prefLivelli(), soglie } }, { merge: true }); avviso("Livelli salvati");
  });
  $$("[data-soglia]").forEach(b => b.addEventListener("click", () => { setDoc(docImpostazioni(), { sogliaAcquisti: Number(b.dataset.soglia) }, { merge: true }); avviso(Number(b.dataset.soglia) ? `Soglia impostata a ${euro(Number(b.dataset.soglia))} al mese` : "Soglia disattivata"); }));
  $("#soglia-ok").addEventListener("click", () => { const x = numIt($("#soglia-altro").value); if (!x) return $("#soglia-altro").focus();
    setDoc(docImpostazioni(), { sogliaAcquisti: x }, { merge: true }); avviso(`Soglia impostata a ${euro(x)} al mese`); });
  $("#b-messaggi").addEventListener("click", apriMessaggi);
  $("#b-backup").addEventListener("click", scaricaBackup);
  $("#b-export").addEventListener("click", esportaCsv);
  $("#b-import").addEventListener("click", sceltaFileExcel);
  $("#b-restore").addEventListener("click", () => $("#file-restore").click());
  $("#file-restore").addEventListener("change", e => { if (e.target.files[0]) ripristinaBackup(e.target.files[0]); e.target.value = ""; });
  $("#b-logout").addEventListener("click", () => { if (confirm("Vuoi uscire?")) signOut(auth); });
}

// =====================================================================
// COPIE DI SICUREZZA, EXCEL
// =====================================================================
function bannerBackup() {
  if (acquisti.length + vendite.length < 5) return "";
  const ultimo = impostazioni.ultimoBackup;
  const giorni = ultimo ? giorniDa(ultimo) : null;
  if (giorni !== null && giorni < 30) return "";
  return `<div class="banner"><span>${ultimo ? `Ultima copia di sicurezza ${giorni} giorni fa` : "Fai una copia di sicurezza dei tuoi dati"}</span>
    <button class="pill c-gold" id="banner-backup">Salva copia</button></div>`;
}
const COLLEZIONI = ["clienti", "acquisti", "vendite", "catalogo", "movimentiOmaggi", "ordini"];
async function scaricaBackup() {
  const dati = { app: "ordini-beauty", versione: 2, creato: new Date().toISOString(),
    clienti, acquisti, vendite, catalogo, movimentiOmaggi: movimenti, ordini: ordiniVecchi,
    impostazioni: { giorniRicontatto: impostazioni.giorniRicontatto, convertito: impostazioni.convertito || null } };
  const json = JSON.stringify(dati, (k, v) => (v && typeof v === "object" && typeof v.toDate === "function") ? v.toDate().toISOString() : v, 2);
  scarica(new Blob([json], { type: "application/json" }), `copia-ordini-${oggi()}.json`);
  await setDoc(docImpostazioni(), { ultimoBackup: oggi() }, { merge: true });
  avviso("Copia di sicurezza scaricata");
}
async function ripristinaBackup(file) {
  let dati;
  try { dati = JSON.parse(await file.text()); } catch { return alert("Il file non è una copia di sicurezza valida."); }
  if (dati.app !== "ordini-beauty") return alert("Il file non è una copia di sicurezza di questa app.");
  if (!confirm(`Ripristino ${dati.clienti?.length || 0} clienti, ${dati.acquisti?.length || 0} acquisti e ${dati.vendite?.length || 0} vendite. Continuo?`)) return;
  const ops = [];
  for (const nome of COLLEZIONI) for (const { id, ...resto } of dati[nome === "movimentiOmaggi" ? "movimentiOmaggi" : nome] || []) ops.push([doc(col(nome), id || nuovoId()), resto]);
  await scriviABlocchi(ops);
  if (dati.impostazioni) await setDoc(docImpostazioni(), dati.impostazioni, { merge: true });
  avviso("✓ Dati ripristinati");
}
async function scriviABlocchi(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([ref, dati]) => b.set(ref, pulisci(dati)));
    await b.commit();
  }
}
function scarica(blob, nome) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function esportaCsv() {
  const n = (x) => (Number(x) || 0).toFixed(2).replace(".", ",");
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const indice = indiceProdotti(acquisti);
  const righe = [["Tipo", "Data", "Chi / N° ordine", "Prodotto", "Quantità", "Prezzo o costo a pezzo", "Totale", "Costo", "Guadagno", "Pagato", "Consegnato / Arrivato"].join(";")];
  for (const a of [...acquisti].reverse()) for (const p of a.prodotti || [])
    righe.push(["Acquisto", dataIt(a.data), q(a.numeroOrdine ? "n° " + a.numeroOrdine : ""), q(p.nome), qtaDi(p), n(p.costo), n(p.costo * qtaDi(p)), "", "", "sì", a.arrivato === false ? "no" : "sì"].join(";"));
  for (const v of [...vendite].reverse()) for (const r of v.righe || []) {
    const c = costoRiga(r, indice);
    righe.push([isMia(v) ? "Per me" : "Vendita", dataIt(v.data), q(nomeVendita(v)), q(r.nome), qtaDi(r), n(r.prezzo), n(r.prezzo * qtaDi(r)),
      c === null ? "da ordinare" : n(c), c === null || isMia(v) ? "" : n(r.prezzo * qtaDi(r) - c), v.pagato ? "sì" : "no", r.consegnato ? "sì" : "no"].join(";"));
  }
  scarica(new Blob(["﻿" + righe.join("\n")], { type: "text/csv;charset=utf-8" }), `ordini-beauty-${oggi()}.csv`);
  avviso("File Excel scaricato");
}

function sceltaFileExcel() {
  const i = document.createElement("input");
  i.type = "file"; i.accept = ".xlsx,.xls,.csv"; i.className = "hidden";
  document.body.appendChild(i);
  i.addEventListener("change", () => { if (i.files[0]) importaExcel(i.files[0]); i.remove(); });
  i.click();
}
function caricaSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = () => ok(window.XLSX); s.onerror = () => ko(new Error("Serve la connessione per leggere il file Excel."));
    document.head.appendChild(s);
  });
}
async function importaExcel(file) {
  let risultato;
  try {
    const XLSX = await caricaSheetJS();
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    risultato = convertiFoglio(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }));
  } catch (err) { return alert("Non riesco a leggere il file: " + err.message); }
  const { ordini: dalFile, nomiClienti, scartate } = risultato;
  if (!dalFile.length) return alert("Nel file non ho trovato ordini da importare.");
  const idPerNome = new Map(clienti.map(c => [chiave(c.nome), c.id]));
  const nuoviNomi = nomiClienti.filter(n => !idPerNome.has(chiave(n)));
  const clientiNuovi = nuoviNomi.map(nome => ({ id: nuovoId(), nome }));
  clientiNuovi.forEach(c => idPerNome.set(chiave(c.nome), c.id));
  const ordiniConId = dalFile.map(({ _controllo, ...o }, i) => ({ ...o, id: "xls" + i, righe: o.righe.map(({ clienteNome, ...r }) => ({ ...r, clienteId: clienteNome ? idPerNome.get(chiave(clienteNome)) : r.clienteId })) }));
  const { acquisti: acqN, vendite: venN } = convertiOrdini(ordiniConId, nuovoId);
  acqN.forEach(a => { delete a.migratoDa; a.importato = true; });
  venN.forEach(v => { v.migrataDa = "xls:" + v.migrataDa; v.importata = true; });
  const t = riepilogo(acqN, venN);
  const guadagnoFile = dalFile.reduce((s, o) => s + o._controllo.entrate - o._controllo.uscite, 0);
  const date = dalFile.map(o => o.data).sort();
  const gia = acquisti.some(a => a.importato);
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Importa da Excel", false) + `
    <div class="sh-main"><div class="question">Ho trovato ${plurale(dalFile.length, "ordine", "ordini")}</div>
      <p class="q-hint">dal ${dataIt(date[0])} al ${dataIt(date.at(-1))} · ${plurale(nuoviNomi.length, "cliente nuova", "clienti nuove")}</p>
      ${gia ? `<div class="banner">Hai già importato un file: importarlo di nuovo duplica gli ordini.</div>` : ""}
      <div class="tiles">
        <div class="tile c-pink"><div class="t-ico"></div><div class="t-val num">${euro(guadagnoFile)}</div><div class="t-lbl">guadagno nel vecchio file</div></div>
        <div class="tile c-green"><div class="t-ico"></div><div class="t-val num">${euro(t.guadagno)}</div><div class="t-lbl">guadagno vero</div></div></div>
      <p class="hint">Ogni riga diventa un ordine a Yves Rocher (quello che hai pagato) e le vendite alle clienti. Il vecchio file contava come perdita i ${euro(t.spesoPerMe)} spesi per te.</p>
      <p class="hint">Gli ordini con più clienti li divido io usando le sigle che avevi scritto (es. MTA, NR); quelli che non capisco li puoi dividere dopo. Tutto risulta pagato, consegnato e arrivato.</p>
      ${scartate.length ? `<p class="hint">Righe saltate: ${scartate.map(s => `${s.riga} (${s.motivo})`).join(", ")}</p>` : ""}</div>
    <div class="sh-foot"><button class="big primary" id="imp-ok">Importa</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#imp-ok").addEventListener("click", async () => {
    $("#imp-ok").disabled = true; $("#imp-ok").textContent = "Importo…";
    const ops = [...clientiNuovi.map(c => [doc(col("clienti"), c.id), { nome: c.nome, telefono: "", note: "" }]),
      ...acqN.map(a => [refAcquisto(a.id), senzaId(a)]), ...venN.map(v => [refVendita(v.id), senzaId(v)])];
    try { await scriviABlocchi(ops);
      const div = dividiAutomaticamente(venN, acqN, clientiNuovi);
      if (div.mod.length) await applicaModifiche(div.mod);
      await setDoc(docImpostazioni(), { convertito: impostazioni.convertito || oggi() }, { merge: true });
      chiudiSheet(true); avviso(`✓ Importati ${dalFile.length} ordini${div.fatte ? ` · ${plurale(div.fatte, "di gruppo diviso", "di gruppo divisi")}` : ""}`); vai("vendite"); }
    catch (err) { alert("Errore durante l'importazione: " + err.message); $("#imp-ok").disabled = false; $("#imp-ok").textContent = "Importa"; }
  });
  apriSheet();
}

// =====================================================================
// CONVERSIONE DAI VECCHI ORDINI (una volta sola)
// =====================================================================
function serveConversione() {
  return ["acquisti", "vendite", "ordini", "impostazioni"].every(k => caricati.has(k))
    && ordiniVecchi.length > 0 && !acquisti.length && !vendite.length && !impostazioni.convertito;
}
function renderConversione() {
  $("#view").innerHTML = `<div class="welcome">
    <h2>Nuova versione dell'app</h2>
    <div>Adesso l'app ha due sezioni: <b>Acquisti</b> (gli ordini a Yves Rocher) e <b>Vendite</b> (gli ordini delle clienti).</div>
    <ol><li>Trasformo i tuoi ${plurale(ordiniVecchi.length, "ordine", "ordini")} nel nuovo formato.</li>
      <li>I conti restano uguali: guadagni, spese e incassi.</li>
      <li>Divido io gli ordini con più clienti, usando le sigle che avevi scritto.</li>
      <li>Prima scarico una copia di sicurezza, per sicurezza.</li></ol>
    <button class="big primary" id="converti">Trasforma i miei ordini</button></div>`;
  $("#converti").addEventListener("click", async () => {
    $("#converti").disabled = true; $("#converti").textContent = "Trasformo…";
    try {
      await scaricaBackup();
      const { acquisti: acqN, vendite: venN } = convertiOrdini(completaCostiScorta(structuredClone(ordiniVecchi)), nuovoId);
      await scriviABlocchi([...acqN.map(a => [refAcquisto(a.id), senzaId(a)]), ...venN.map(v => [refVendita(v.id), senzaId(v)])]);
      const div = dividiAutomaticamente(venN, acqN);
      if (div.mod.length) await applicaModifiche(div.mod);
      await setDoc(docImpostazioni(), { convertito: oggi() }, { merge: true });
      avviso(`✓ Fatto: ${plurale(acqN.length, "acquisto", "acquisti")}${div.fatte ? ` · ${plurale(div.fatte, "ordine di gruppo diviso", "ordini di gruppo divisi")}` : ""}`);
    } catch (err) { alert("Qualcosa non è andato: " + err.message + "\nI tuoi dati vecchi non sono stati toccati."); $("#converti").disabled = false; }
  });
}

// =====================================================================
// NOTIFICHE (Worker Cloudflare)
// =====================================================================
let workerUrlFile = null;
// Indirizzo del Worker: prima quello salvato nell'app (Riepilogo → Notifiche), poi notifiche-config.js
async function leggiWorkerUrl() {
  if (impostazioni.workerUrl) return String(impostazioni.workerUrl).trim().replace(/\/+$/, "");
  if (workerUrlFile !== null) return workerUrlFile;
  try {
    const r = await fetch("notifiche-config.js", { cache: "no-store" });
    const t = r.ok ? await r.text() : "";
    workerUrlFile = (t.replace(/^\s*\/\/.*$/gm, "").match(/https:\/\/[^"'`\s]+\.workers\.dev[^"'`\s]*/) || [""])[0].replace(/\/+$/, "");
  } catch { workerUrlFile = ""; }
  return workerUrlFile;
}
const NOTIFICHE_BASE = { ora: 9, compleanni: true, arrivi: true, pagamenti: true, ricontatti: false, ordinare: true, soglia: true, livelli: true };
const prefNotifiche = () => ({ ...NOTIFICHE_BASE, ...(impostazioni.notifiche || {}) });
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const versioneIOS = () => { const m = navigator.userAgent.match(/OS (\d+)_(\d+)/); return m ? Number(m[1]) + Number(m[2]) / 100 : null; };
const daHome = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const b64uInBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const bytesUguali = (a, b) => a && b && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);
const tokenCasuale = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");
async function chiamaWorker(percorso, corpo) {
  const url = await leggiWorkerUrl();
  const r = await fetch(url + percorso, corpo ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.errore || `errore ${r.status}`); e.dati = j; throw e; }
  return j;
}
async function iscrizioneDispositivo() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
let chiaveVapid = null;          // scaricata prima, così l'iscrizione parte subito dal tocco (iPhone lo richiede)
async function prendiChiaveVapid() {
  if (chiaveVapid) return chiaveVapid;
  const { chiave: k } = await chiamaWorker("/vapid");
  if (!k) throw new Error("Il Worker non ha la chiave VAPID_PUBLIC_KEY");
  chiaveVapid = k; return k;
}

async function disegnaNotifiche() {
  const box = $("#box-notifiche"); if (!box) return;
  const url = await leggiWorkerUrl();
  if (!box.isConnected) return;   // la pagina è stata ridisegnata nel frattempo
  const p = prefNotifiche();
  const campoUrl = `<details class="more" style="margin-top:12px;background:var(--bg)" ${url ? "" : "open"}><summary>Indirizzo del Worker</summary>
      <input id="worker-url" placeholder="https://beauty-ordini-notifiche.tuonome.workers.dev" value="${esc(impostazioni.workerUrl || url)}" autocomplete="off" autocapitalize="off">
      <button class="c-blue" id="worker-salva" style="margin-top:8px;width:100%">Salva indirizzo</button>
      <div class="hint">Lo trovi nella pagina del Worker su Cloudflare, finisce con <b>.workers.dev</b>. Salvato qui, vale su tutti i dispositivi.</div></details>`;
  let corpo;
  if (!url) corpo = `<div class="hint" style="margin:0">Scrivi qui sotto l'indirizzo del Worker Cloudflare.</div>`;
  else if (isIOS() && !daHome()) corpo = `<div class="hint" style="margin:0">Su iPhone le notifiche funzionano solo con l'app aggiunta alla schermata Home:
      in Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi apri l'app da lì.</div>`;
  else if (!("PushManager" in window) || !("Notification" in window)) corpo = `<div class="hint" style="margin:0">Questo browser non supporta le notifiche${isIOS() ? " (serve iOS 16.4 o più recente)" : ""}.</div>`;
  else if (Notification.permission === "denied") corpo = `<div class="hint" style="margin:0">Le notifiche sono bloccate. Su iPhone: Impostazioni → Notifiche → Ordini → Consenti notifiche.</div>`;
  else {
    const sub = await iscrizioneDispositivo();
    if (!box.isConnected) return;
    if (!sub) { corpo = `<div class="hint" style="margin:0 0 10px">Ti avviso io di compleanni, pacchi in ritardo, pagamenti, cose da ordinare e soglia di spesa.</div>
      <button class="big primary" id="notif-attiva">Attiva su questo dispositivo</button>`; prendiChiaveVapid().catch(() => {}); }
    else corpo = `<div class="hint" style="margin:0 0 10px;color:var(--green)"><b>✓ Attive su questo dispositivo</b></div>
      <div class="yn-q" style="font-size:16px">A che ora?</div>
      <div class="chips small-chips">${[8, 9, 12, 18, 20].map(h => `<button class="chip ${p.ora === h ? "sel" : ""}" data-nora="${h}">${h}:00</button>`).join("")}</div>
      <div class="yn-q" style="font-size:16px;margin-top:14px">Avvisami di…</div>
      <div class="chips small-chips">${[["compleanni", "Compleanni"], ["arrivi", "Pacchi in ritardo"], ["pagamenti", "Pagamenti da chiedere"], ["ordinare", "Richieste da ordinare"], ["soglia", "Soglia acquisti"], ["livelli", "Nuovo livello"], ["ricontatti", "Clienti da sentire"]]
        .map(([k, t]) => `<button class="chip ${p[k] ? "sel" : ""}" data-ntipo="${k}">${t}</button>`).join("")}</div>
      <div class="stack" style="margin-top:14px"><button id="notif-prova">Mandami una prova</button>
        <button class="danger" id="notif-off" style="text-align:center">Disattiva su questo dispositivo</button></div>`;
  }
  if (!box.isConnected) return;
  box.innerHTML = `<div class="yn-q">Notifiche</div>${corpo}${campoUrl}
    <button id="notif-check" style="width:100%;margin-top:10px">Controlla perché non funzionano</button><div id="notif-esito"></div>`;
  $("#notif-attiva", box)?.addEventListener("click", attivaNotifiche);
  $("#notif-prova", box)?.addEventListener("click", async () => {
    try { await programmaNotifiche(true); const r = await chiamaWorker("/prova", { utente: uid, token: impostazioni.pushToken });
      avviso(r.inviate ? "Inviata: arriva tra pochi secondi" : "Il Worker non è riuscito a mandarla: tocca “Controlla”"); }
    catch (e) { alert("Non sono riuscita a mandare la prova: " + e.message + "\n\nTocca “Controlla perché non funzionano”."); }
  });
  $("#notif-off", box)?.addEventListener("click", async () => {
    const sub = await iscrizioneDispositivo();
    if (sub) { try { await chiamaWorker("/disiscrivi", { utente: uid, token: impostazioni.pushToken, endpoint: sub.endpoint }); } catch {} await sub.unsubscribe(); }
    avviso("Notifiche disattivate su questo dispositivo"); disegnaNotifiche();
  });
  $("#worker-salva", box).addEventListener("click", async () => {
    const v = $("#worker-url", box).value.trim().replace(/\/+$/, "");
    if (v && !/^https:\/\/[^\s/]+\.workers\.dev$/.test(v) && !confirm("L'indirizzo di solito è tipo https://nome.tuonome.workers.dev. Lo salvo lo stesso?")) return;
    chiaveVapid = null;
    await setDoc(docImpostazioni(), { workerUrl: v || null }, { merge: true });
    avviso(v ? "Indirizzo salvato" : "Indirizzo tolto");
  });
  $("#notif-check", box).addEventListener("click", controllaNotifiche);
  $$("[data-nora]", box).forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { notifiche: { ...p, ora: Number(b.dataset.nora) } }, { merge: true })));
  $$("[data-ntipo]", box).forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { notifiche: { ...p, [b.dataset.ntipo]: !p[b.dataset.ntipo] } }, { merge: true })));
}

async function attivaNotifiche() {
  try {
    // l'iscrizione deve partire subito dal tocco: niente attese di rete prima del permesso
    const permesso = await Notification.requestPermission();
    if (permesso !== "granted") { avviso("Senza il permesso non posso mandarti notifiche"); return disegnaNotifiche(); }
    const k = chiaveVapid || await prendiChiaveVapid();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uInBytes(k) });
    let token = impostazioni.pushToken;
    if (!token) { token = tokenCasuale(); await setDoc(docImpostazioni(), { pushToken: token, notifiche: prefNotifiche() }, { merge: true }); impostazioni.pushToken = token; }
    await chiamaWorker("/iscrivi", { utente: uid, token, subscription: sub.toJSON() });
    await programmaNotifiche(true);
    avviso("Notifiche attive! Prova “Mandami una prova”");
  } catch (e) { alert("Non sono riuscita ad attivare le notifiche: " + e.message + "\n\nTocca “Controlla perché non funzionano”."); }
  disegnaNotifiche();
}

// Controllo passo per passo: dice cosa non va e come sistemarlo
async function controllaNotifiche() {
  const out = $("#notif-esito"); const righe = [];
  const pulsante = $("#notif-check");
  const metti = (stato, titolo, dettaglio = "") => { righe.push({ stato, titolo, dettaglio }); out.innerHTML = disegnaEsito(righe); };
  const disegnaEsito = (r) => `<div class="esito">${r.map(x => `<div class="es-riga es-${x.stato}"><span>${{ ok: "✓", no: "✕", forse: "!", info: "i" }[x.stato]}</span>
    <div><b>${esc(x.titolo)}</b>${x.dettaglio ? `<div class="hint" style="margin:2px 0 0">${x.dettaglio}</div>` : ""}</div></div>`).join("")}
    ${r.length ? `<button class="pill" id="esito-copia" style="margin-top:8px">Copia il risultato</button>` : ""}</div>`;
  const fine = () => out.querySelector("#esito-copia")?.addEventListener("click", async () => {
    const t = righe.map(x => `${{ ok: "OK", no: "NO", forse: "?", info: "i" }[x.stato]} ${x.titolo}${x.dettaglio ? " — " + x.dettaglio.replace(/<[^>]+>/g, "") : ""}`).join("\n");
    try { await navigator.clipboard.writeText(t); avviso("Copiato: incollalo nella chat"); } catch { alert(t); }
  });
  pulsante.disabled = true;
  try {
    // 1. indirizzo
    const url = await leggiWorkerUrl();
    if (!url) { metti("no", "Manca l'indirizzo del Worker", "Scrivilo in “Indirizzo del Worker” qui sopra e tocca Salva."); return; }
    metti("ok", "Indirizzo del Worker", esc(url));
    // 2. raggiungibile + ORIGINE
    let info = null;
    try { info = await (await fetch(url + "/", { cache: "no-store" })).json(); }
    catch {
      let esiste = false; try { await fetch(url + "/", { mode: "no-cors", cache: "no-store" }); esiste = true; } catch {}
      if (esiste) metti("no", "Il Worker risponde ma blocca questa app",
        `Nel Worker la variabile <b>ORIGINE</b> deve essere esattamente <b>${esc(location.origin)}</b> (senza barra finale). Poi Deploy.`);
      else metti("no", "Non riesco a raggiungere il Worker", "Controlla l'indirizzo (deve iniziare con https:// e finire con .workers.dev) e che il Worker sia pubblicato (Deploy).");
      return;
    }
    if (!info?.ok) { metti("no", "A quell'indirizzo non c'è il Worker giusto", "Hai incollato worker.js nell'editor di Cloudflare e premuto Deploy?"); return; }
    metti("ok", "Il Worker risponde a questa app");
    // 3. configurazione del Worker (se è la versione nuova la dice)
    if (info.controlli) {
      const c = info.controlli;
      metti(c.kv ? "ok" : "no", "Archivio KV collegato", c.kv ? "" : "Settings → Bindings → KV namespace con nome <b>PROMEMORIA</b> (maiuscolo).");
      metti(c.chiavePubblica ? "ok" : "no", "Chiave VAPID_PUBLIC_KEY", c.chiavePubblica ? "" : "Manca o è incompleta: ricopiala da genera-chiavi.html.");
      metti(c.chiavePrivata ? "ok" : "no", "Chiave VAPID_PRIVATE_JWK", c.chiavePrivata ? "" : esc(c.erroreChiave || "Manca o è copiata a metà: va incollato tutto, dalla { alla }."));
      if (c.chiavePubblica && c.chiavePrivata) metti(c.coppiaGiusta ? "ok" : "no", "Le due chiavi vanno insieme", c.coppiaGiusta ? "" : "Pubblica e privata vengono da generazioni diverse: ricreale e ricopiale entrambe.");
      metti(c.subject ? "ok" : "forse", "VAPID_SUBJECT", c.subject ? esc(c.subject) : "Metti <b>mailto:</b> seguito dalla tua email vera.");
      metti(c.cron ? "ok" : "forse", "Invio automatico ogni ora (Cron)", c.cron ? `ultimo giro: ${new Date(c.cron).toLocaleString("it-IT")}` : "Non risulta ancora partito: Settings → Triggers → Cron <b>0 * * * *</b> (può servire fino a un'ora).");
    } else metti("forse", "Il Worker è una versione vecchia", "Ricarica su Cloudflare il nuovo <b>worker.js</b>: così posso controllare anche chiavi e archivio.");
    // 4. dispositivo
    if (isIOS()) {
      const v = versioneIOS();
      if (v && v < 16.04) { metti("no", `iOS ${String(v).replace(".", ",")}: troppo vecchio`, "Le notifiche delle app web servono da iOS 16.4: aggiorna l'iPhone."); return; }
      if (!daHome()) { metti("no", "App aperta da Safari", "Aggiungila alla schermata Home (Condividi → Aggiungi alla schermata Home) e aprila dall'icona."); return; }
      metti("ok", "App aperta dalla schermata Home");
    }
    if (!("Notification" in window) || !("PushManager" in window)) { metti("no", "Questo browser non supporta le notifiche"); return; }
    if (Notification.permission === "denied") { metti("no", "Notifiche bloccate", "iPhone: Impostazioni → Notifiche → Ordini → Consenti. Mac: impostazioni del sito nel browser."); return; }
    if (Notification.permission !== "granted") { metti("forse", "Permesso non ancora dato", "Tocca “Attiva su questo dispositivo”."); return; }
    metti("ok", "Permesso notifiche dato");
    // 5. iscrizione e chiave
    const sub = await iscrizioneDispositivo();
    if (!sub) { metti("no", "Questo dispositivo non è iscritto", "Tocca “Attiva su questo dispositivo”."); return; }
    try {
      const k = await prendiChiaveVapid();
      const stessa = bytesUguali(sub.options?.applicationServerKey, b64uInBytes(k).buffer);
      if (sub.options?.applicationServerKey && !stessa) {
        metti("no", "Iscritto con chiavi vecchie", "Le chiavi del Worker sono cambiate: tocca “Disattiva su questo dispositivo” e poi di nuovo “Attiva”.");
        return;
      }
    } catch (e) { metti("no", "Il Worker non dà la chiave pubblica", esc(e.message)); return; }
    metti("ok", "Dispositivo iscritto");
    if (!impostazioni.pushToken) { metti("no", "Manca il codice di iscrizione", "Disattiva e riattiva le notifiche."); return; }
    try { await chiamaWorker("/iscrivi", { utente: uid, token: impostazioni.pushToken, subscription: sub.toJSON() }); metti("ok", "Il Worker conosce questo dispositivo"); }
    catch (e) { metti("no", "Il Worker rifiuta l'iscrizione", esc(e.message) + (/codice/.test(e.message) ? " — disattiva e riattiva le notifiche." : "")); return; }
    // 6. prova vera
    try {
      const r = await chiamaWorker("/prova", { utente: uid, token: impostazioni.pushToken });
      const mio = (r.dettagli || []).find(d => d.endpoint === sub.endpoint.slice(-24)) || (r.dettagli || [])[0];
      if (r.inviate) metti("ok", "Prova inviata dal Worker", "Deve arrivare entro pochi secondi. Se non arriva: controlla che non sia attiva la modalità Full Immersion / Non disturbare.");
      else metti("no", "Il servizio di Apple/Google ha rifiutato la notifica", mio ? `Risposta ${mio.stato}: ${esc(mio.testo || "")}. ${spiegaRifiuto(mio)}` : "");
    } catch (e) {
      const d = e.dati?.dettagli?.[0];
      metti("no", "La prova non è partita", esc(e.message) + (d ? ` — risposta ${d.stato}: ${esc(d.testo || "")}. ${spiegaRifiuto(d)}` : ""));
    }
  } finally { pulsante.disabled = false; fine(); }
}
function spiegaRifiuto(d) {
  const t = String(d.testo || "");
  if (d.stato === 403 && /BadJwtToken|jwt|vapid/i.test(t)) return "Problema con le chiavi o con VAPID_SUBJECT: controlla che il subject sia mailto: + una email vera, poi disattiva e riattiva.";
  if (d.stato === 403) return "Le chiavi non corrispondono all'iscrizione: disattiva e riattiva le notifiche su questo dispositivo.";
  if (d.stato === 404 || d.stato === 410) return "Iscrizione scaduta: disattiva e riattiva le notifiche.";
  if (d.stato === 400) return "Richiesta non valida: ricarica su Cloudflare l'ultimo worker.js.";
  return "";
}

function calcolaPromemoria() {
  const p = prefNotifiche();
  const oraTxt = String(p.ora).padStart(2, "0") + ":00:00";
  const quando = (giorno) => new Date(`${giorno}T${oraTxt}`).getTime();
  const piu = (iso, n) => new Date(Date.parse(iso + "T00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const tra = (a, b) => Math.round((Date.parse(b + "T00:00Z") - Date.parse(a + "T00:00Z")) / 86400000);
  const indice = indiceProdotti(acquisti), oggiIso = oggi(), lista = [];
  if (p.compleanni) for (const c of clienti) {
    const pc = prossimoCompleanno(c.compleanno);
    if (pc && pc.giorni <= 14 && c.auguriFatti !== pc.data)
      lista.push({ id: `comp:${c.id}:${pc.data}`, quando: quando(pc.data), titolo: `Oggi compie gli anni ${c.nome}`, testo: "Apri l'app e mandale gli auguri su WhatsApp." });
  }
  for (let i = 0; i < 7; i++) {
    const g = piu(oggiIso, i), parti = [];
    if (p.arrivi) { const n = acquisti.filter(a => a.arrivato === false && a.data && tra(a.data, g) >= 10).length;
      if (n) parti.push(`${n === 1 ? "1 ordine aspetta" : n + " ordini aspettano"} da più di 10 giorni`); }
    if (p.pagamenti) { const vv = vendite.filter(v => !isMia(v) && !v.pagato && v.data && tra(v.data, g) >= 14 && (v.righe || []).some(r => r.consegnato));
      if (vv.length) parti.push(`${vv.length === 1 ? "1 cliente deve" : vv.length + " clienti devono"} pagarti ${euro(somma(vv, v => calcolaVendita(v, indice).totale))}`); }
    if (p.ordinare) { const n = vendite.flatMap(v => (v.righe || []).filter(rigaDaOrdinare)).length;
      if (n && i % 3 === 0) parti.push(`${n === 1 ? "1 prodotto da ordinare" : n + " prodotti da ordinare"}`); }
    if (p.ricontatti) { const n = daRicontattare(clienti, venditeComeOrdini(vendite), g, Number(impostazioni.giorniRicontatto) || 0).length;
      if (n) parti.push(`${n === 1 ? "1 cliente da sentire" : n + " clienti da sentire"}`); }
    if (parti.length) lista.push({ id: `riep:${g}`, quando: quando(g), titolo: "Oggi da fare", testo: parti.join(" · ") });
  }
  // nuovo livello raggiunto nel periodo: una notifica sola per livello
  const L = statoLivello();
  if (p.livelli !== false && L.nome) { const ora = new Date(); ora.setMinutes(0, 0, 0);
    lista.push({ id: `livello:${L.chiave}:${L.nome}`, quando: ora.getTime(), titolo: `Livello ${L.nome} raggiunto`,
      testo: `Hai ${euro(L.speso)} di vendite ${L.nomePeriodo === "da sempre" ? "in tutto" : "nel periodo " + L.nomePeriodo}.${L.prossimo ? ` Mancano ${euro(L.mancano)} al livello ${L.prossimo[0]}.` : ""}` }); }
  // vicina al livello successivo verso fine trimestre
  if (p.livelli !== false && L.prossimo && L.mancano <= L.prossimo[1] * VICINO) {
    for (const meno of [21, 14, 7, 3]) {
      const g = piu(L.fine, -meno); if (g < oggiIso) continue;
      lista.push({ id: `vicino:${L.chiave}:${L.prossimo[0]}:${meno}`, quando: quando(g), titolo: `Sei vicina al livello ${L.prossimo[0]}`,
        testo: `Mancano ${meno} giorni alla fine del trimestre e ti servono circa ${euro(L.mancano)} di vendite. Apri l'app per il dato aggiornato.` });
    }
  }
  // soglia superata nel mese corrente: una notifica sola (il Worker non la rimanda)
  const sg = sogliaAcquisti(), meseOra = oggiIso.slice(0, 7), spesoOra = spesoMese(meseOra);
  if (p.soglia !== false && sg && spesoOra >= sg) {
    const ora = new Date(); ora.setMinutes(0, 0, 0);
    lista.push({ id: `soglia:${meseOra}:${sg}`, quando: ora.getTime(), titolo: "Soglia acquisti superata",
      testo: `Questo mese hai speso ${euro(spesoOra)} in acquisti Yves Rocher (soglia ${euro(sg)}).` });
  }
  return lista.filter(x => x.quando > Date.now() - 3600000);
}
let timerProgramma;
function programmaNotificheTraPoco() { clearTimeout(timerProgramma); timerProgramma = setTimeout(() => programmaNotifiche(false), 4000); }
async function programmaNotifiche(forza) {
  if (!uid || !impostazioni.pushToken) return;
  if (!(await leggiWorkerUrl())) return;
  const promemoria = calcolaPromemoria();
  const firma = JSON.stringify(promemoria);
  let ultima = null; try { ultima = localStorage.getItem("ultimiPromemoria"); } catch {}
  if (!forza && ultima === firma) return;
  try { await chiamaWorker("/programma", { utente: uid, token: impostazioni.pushToken, promemoria }); try { localStorage.setItem("ultimiPromemoria", firma); } catch {} } catch {}
}

// ---------- App installabile ----------
// Aggiornamenti: controlla subito e ogni volta che l'app torna in primo piano; quando arriva la versione nuova ricarica da sola
if ("serviceWorker" in navigator) {
  const cePrima = !!navigator.serviceWorker.controller; let ricaricata = false;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (cePrima && !ricaricata) { ricaricata = true; location.reload(); } });
}
