import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  addDoc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { calcolaOrdine, riepilogoPeriodo, giacenzaOmaggi, daRicontattare, linkWhatsApp, euro, chiave, IO, STORICO } from "./calc.js?v=7";
import { convertiFoglio } from "./importa.js?v=7";

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
let clienti = [], ordini = [], catalogo = [], movimenti = [];
let impostazioni = { giorniRicontatto: 60, ultimoBackup: null };
let unsub = [];
let vista = "home";
let meseSel = oggi().slice(0, 7);
let cercaClienti = "";

// ---------- Utilità ----------
const col = (nome) => collection(db, "utenti", uid, nome);
const docImpostazioni = () => doc(db, "utenti", uid, "impostazioni", "generale");
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numIt = (v) => { const n = Number(String(v ?? "").replace(/\s|€/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const inIt = (v) => v === null || v === undefined || v === "" ? "" : (typeof v === "number" ? v.toFixed(2) : String(v)).replace(".", ",");
const nuovoId = () => Math.random().toString(36).slice(2, 10);
function oggi() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const dataIt = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString("it-IT") : "";
const dataLunga = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString("it-IT", { day: "numeric", month: "long" }) : "";
const slug = (s) => chiave(s).replace(/[^a-z0-9àèéìòù]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || nuovoId();
const somma = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const plurale = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;

const nomeRiga = (r) => r.clienteId === IO ? "Per me" : r.clienteId === STORICO ? (r.clientiStorico || "Più clienti")
  : (clienti.find(c => c.id === r.clienteId)?.nome || "Cliente eliminata");
const primoNome = (c) => String(c?.nome || "").split(" ")[0];

// Colore fisso per ogni persona (avatar)
const PALETTE = ["c-pink", "c-orange", "c-purple", "c-blue", "c-green", "c-gold"];
const coloreDi = (nome) => PALETTE[[...chiave(nome)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % PALETTE.length];
const iniziali = (nome) => String(nome || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("") || "?";
const avatar = (nome, isIo) => `<div class="avatar ${isIo ? "c-pink" : coloreDi(nome)}">${isIo ? "🙋‍♀️" : esc(iniziali(nome))}</div>`;

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
  unsub.forEach(u => u()); unsub = [];
  if (!user) { uid = null; $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); return; }
  uid = user.uid;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  const ascolta = (nome, cb) => unsub.push(onSnapshot(col(nome), s => { cb(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }));
  ascolta("clienti", d => clienti = d.sort((a, b) => a.nome.localeCompare(b.nome, "it")));
  ascolta("ordini", d => ordini = d.sort((a, b) => (b.data || "").localeCompare(a.data || "")));
  ascolta("catalogo", d => catalogo = d);
  ascolta("movimentiOmaggi", d => movimenti = d);
  unsub.push(onSnapshot(docImpostazioni(), s => { impostazioni = { giorniRicontatto: 60, ultimoBackup: null, ...(s.data() || {}) }; render(); }));
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
  home:    { titolo: "Oggi", fab: ["Nuovo ordine", () => apriOrdine()] },
  ordini:  { titolo: "Ordini", fab: ["Nuovo ordine", () => apriOrdine()] },
  clienti: { titolo: "Clienti", fab: ["Nuova cliente", () => apriCliente()] },
  omaggi:  { titolo: "Omaggi", fab: ["Nuovo omaggio", () => apriNuovoOmaggio()] },
  soldi:   { titolo: "Soldi", fab: null }
};
$$(".tabbar button").forEach(b => b.addEventListener("click", () => vai(b.dataset.view)));
$("#fab").addEventListener("click", () => VISTE[vista].fab?.[1]());

function vai(v) {
  vista = v;
  $$(".tabbar button").forEach(x => x.classList.toggle("active", x.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}

function render() {
  if (!uid) return;
  const v = VISTE[vista];
  $("#view-title").textContent = v.titolo;
  $("#hello").textContent = vista === "home"
    ? "Ciao! 👋 " + new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" }) : "";
  $("#fab").classList.toggle("hidden", !v.fab);
  if (v.fab) $("#fab span").textContent = v.fab[0];
  ({ home: renderHome, ordini: renderOrdini, clienti: renderClienti, omaggi: renderOmaggi, soldi: renderSoldi })[vista]();
  aggiornaSuggerimenti();
}

// Suggerimenti per prodotti e omaggi
function aggiornaSuggerimenti() {
  const prodotti = new Map();
  for (const p of catalogo) prodotti.set(chiave(p.nome), p.nome);
  for (const o of ordini) for (const r of o.righe || []) {
    const nomi = r.articoli?.length ? r.articoli.map(a => a.nome) : String(r.prodotti || "").split(",");
    for (const p of nomi) { const n = String(p).trim(); if (n && n.length < 60 && !prodotti.has(chiave(n))) prodotti.set(chiave(n), n); }
  }
  $("#dl-prodotti").innerHTML = [...prodotti.values()].sort((a, b) => a.localeCompare(b, "it")).map(n => `<option value="${esc(n)}">`).join("");
  $("#dl-omaggi").innerHTML = giacenzaOmaggi(ordini, movimenti).map(v => `<option value="${esc(v.nome)}">`).join("");
}

// ---------- WhatsApp ----------
function apriWhatsApp(cliente, testo) {
  if (!cliente?.telefono && !confirm(`Non hai il numero di ${cliente?.nome || "questa cliente"}. Apro WhatsApp e scegli tu il contatto?`)) return;
  window.open(linkWhatsApp(cliente?.telefono, testo), "_blank");
}
const elencoProdotti = (righe) => righe.map(r => r.prodotti).filter(Boolean).join(", ");
const msgConsegna = (c, righe) => `Ciao ${primoNome(c)}! Sono arrivati i tuoi prodotti Yves Rocher: ${elencoProdotti(righe)}. Quando ci vediamo per la consegna? 😊`;
const msgPagamento = (c, righe) => `Ciao ${primoNome(c)}! Ti ricordo il saldo di ${euro(somma(righe, r => r.importo))} per ${elencoProdotti(righe)}. Quando ti è comodo? Grazie! 😊`;
const msgRicontatto = (x) => x.tipo === "riacquisto"
  ? `Ciao ${primoNome(x.cliente)}! Come ti stai trovando con ${x.prodotti}? Dovrebbe essere quasi finito: vuoi che te lo riordini? Ci sono anche le nuove promozioni Yves Rocher 😊`
  : `Ciao ${primoNome(x.cliente)}! È uscito il nuovo catalogo Yves Rocher con tante promozioni. Ti mando qualche proposta? 😊`;

// ---------- Modifiche veloci con Annulla ----------
// cambia: (riga) => riga modificata (o la stessa). Si applica a tutte le righe che soddisfano "filtro".
async function aggiornaRighe(filtro, cambia, messaggio) {
  const prima = [];
  const batch = writeBatch(db);
  for (const o of ordini) {
    if (!(o.righe || []).some(filtro)) continue;
    prima.push({ id: o.id, righe: o.righe });
    batch.set(doc(col("ordini"), o.id), { righe: o.righe.map(r => filtro(r) ? cambia(r) : r) }, { merge: true });
  }
  if (!prima.length) return;
  await batch.commit();
  avviso(messaggio, async () => {
    const b = writeBatch(db);
    prima.forEach(p => b.set(doc(col("ordini"), p.id), { righe: p.righe }, { merge: true }));
    await b.commit();
  });
}

// ---------- OGGI ----------
function gruppiPerCliente(filtro) {
  const m = new Map();
  for (const o of ordini) for (const r of o.righe || []) {
    if (!filtro(r)) continue;
    const k = r.clienteId === STORICO ? STORICO + ":" + r.clientiStorico : r.clienteId;
    if (!m.has(k)) m.set(k, { chiave: k, clienteId: r.clienteId, nome: nomeRiga(r), righe: [] });
    m.get(k).righe.push(r);
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome, "it"));
}

function renderHome() {
  if (!ordini.length && !clienti.length) {
    $("#view").innerHTML = `<div class="welcome">
      <h2>Benvenuta! 🌿</h2>
      <div>Qui tieni tutto: cosa consegnare, chi deve pagarti e quanto guadagni.</div>
      <ol><li>Se hai il vecchio file Excel, importalo.</li><li>Poi crea gli ordini nuovi con il pulsante verde.</li></ol>
      <div class="stack"><button id="w-import">📥 Importa il vecchio Excel</button><button id="w-new" class="primary">＋ Crea il primo ordine</button></div>
    </div>`;
    $("#w-import").addEventListener("click", sceltaFileExcel);
    $("#w-new").addEventListener("click", () => apriOrdine());
    return;
  }
  const consegne = gruppiPerCliente(r => !r.consegnato);
  const incassi = gruppiPerCliente(r => r.clienteId !== IO && !r.pagato);
  const ric = daRicontattare(clienti, ordini, oggi(), Number(impostazioni.giorniRicontatto) || 0);
  const mese = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(oggi().slice(0, 7))));
  const totIncassi = somma(incassi.flatMap(g => g.righe), r => r.importo);
  const nomeMese = new Date().toLocaleDateString("it-IT", { month: "long" });

  let h = bannerBackup();
  h += `<div class="tiles">
    <button class="tile c-orange" data-go="sec-consegne"><div class="t-ico">📦</div><div class="t-val">${consegne.length}</div><div class="t-lbl">da consegnare</div></button>
    <button class="tile c-pink" data-go="sec-incassi"><div class="t-ico">💶</div><div class="t-val num">${euro(totIncassi)}</div><div class="t-lbl">da incassare</div></button>
    <button class="tile c-purple" data-go="sec-ric"><div class="t-ico">💜</div><div class="t-val">${ric.length}</div><div class="t-lbl">da sentire</div></button>
    <button class="tile c-green" data-view-go="soldi"><div class="t-ico">🌿</div><div class="t-val num">${euro(mese.guadagnoAtteso)}</div><div class="t-lbl">guadagno di ${nomeMese}</div></button>
  </div>`;

  if (!consegne.length && !incassi.length && !ric.length) h += `<div class="empty"><div class="e-ico">🎉</div><b>Tutto in ordine!</b><br>Niente da consegnare, nessuno ti deve soldi.</div>`;

  if (consegne.length) {
    h += `<div class="section" id="sec-consegne"><h2>📦 Da consegnare</h2><span class="count c-orange">${consegne.length}</span></div>`;
    for (const g of consegne) {
      const c = clienti.find(x => x.id === g.clienteId);
      h += `<div class="card b-orange"><div class="who">${avatar(g.nome, g.clienteId === IO)}<div><h3>${esc(g.nome)}</h3>
          <div class="sub">${plurale(g.righe.length, "ordine", "ordini")}</div></div></div>
        <div class="what">${esc(elencoProdotti(g.righe))}</div>
        <div class="actions"><button class="c-orange" data-consegna="${esc(g.chiave)}">✓ ${g.clienteId === IO ? "Ce l'ho" : "Consegnato"}</button>
          ${c ? `<button class="wa" data-wa-consegna="${esc(g.chiave)}">💬 Avvisala</button>` : ""}</div></div>`;
    }
  }
  if (incassi.length) {
    h += `<div class="section" id="sec-incassi"><h2>💶 Devono pagarti</h2><span class="count c-pink">${euro(totIncassi)}</span></div>`;
    for (const g of incassi) {
      const c = clienti.find(x => x.id === g.clienteId);
      h += `<div class="card b-pink"><div class="row"><div class="who">${avatar(g.nome)}<div><h3>${esc(g.nome)}</h3>
          <div class="sub">${esc(elencoProdotti(g.righe))}</div></div></div><div class="amount num" style="color:var(--pink)">${euro(somma(g.righe, r => r.importo))}</div></div>
        <div class="actions"><button class="c-pink" data-paga="${esc(g.chiave)}">✓ Ha pagato</button>
          ${c ? `<button class="wa" data-wa-paga="${esc(g.chiave)}">💬 Ricordaglielo</button>` : ""}</div></div>`;
    }
  }
  if (ric.length) {
    h += `<div class="section" id="sec-ric"><h2>💜 Da sentire</h2><span class="count c-purple">${ric.length}</span></div>
      <p class="section-hint">Clienti che non comprano da un po', o con un prodotto che sta finendo.</p>`;
    ric.forEach((x, i) => {
      h += `<div class="card b-purple"><div class="who">${avatar(x.cliente.nome)}<div><h3>${esc(x.cliente.nome)}</h3>
          <div class="sub">${x.tipo === "riacquisto" ? `Sta finendo: ${esc(x.prodotti)}` : `Ultimo acquisto ${x.giorni} giorni fa`}</div></div></div>
        <div class="actions"><button class="wa" data-ric="${i}">💬 Scrivile</button><button class="c-purple" data-ricfatto="${x.cliente.id}">✓ Sentita</button></div></div>`;
    });
  }
  $("#view").innerHTML = h;

  const trova = (lista, k) => lista.find(g => g.chiave === k);
  const filtroGruppo = (g, extra) => (r) => extra(r) && (g.clienteId === STORICO ? r.clienteId === STORICO && r.clientiStorico === g.chiave.slice(STORICO.length + 1) : r.clienteId === g.clienteId);
  $$("[data-go]").forEach(b => b.addEventListener("click", () => $("#" + b.dataset.go)?.scrollIntoView({ behavior: "smooth", block: "start" })));
  $$("[data-view-go]").forEach(b => b.addEventListener("click", () => vai(b.dataset.viewGo)));
  $$("[data-consegna]").forEach(b => b.addEventListener("click", () => {
    const g = trova(consegne, b.dataset.consegna);
    aggiornaRighe(filtroGruppo(g, r => !r.consegnato), r => ({ ...r, consegnato: true }), `📦 ${g.nome}: consegnato`);
  }));
  $$("[data-paga]").forEach(b => b.addEventListener("click", () => {
    const g = trova(incassi, b.dataset.paga);
    aggiornaRighe(filtroGruppo(g, r => r.clienteId !== IO && !r.pagato), r => ({ ...r, pagato: true }), `💶 ${g.nome}: ${euro(somma(g.righe, r => r.importo))} incassati`);
  }));
  $$("[data-wa-consegna]").forEach(b => b.addEventListener("click", () => {
    const g = trova(consegne, b.dataset.waConsegna); const c = clienti.find(x => x.id === g.clienteId);
    apriWhatsApp(c, msgConsegna(c, g.righe));
  }));
  $$("[data-wa-paga]").forEach(b => b.addEventListener("click", () => {
    const g = trova(incassi, b.dataset.waPaga); const c = clienti.find(x => x.id === g.clienteId);
    apriWhatsApp(c, msgPagamento(c, g.righe));
  }));
  $$("[data-ric]").forEach(b => b.addEventListener("click", () => { const x = ric[+b.dataset.ric]; apriWhatsApp(x.cliente, msgRicontatto(x)); }));
  $$("[data-ricfatto]").forEach(b => b.addEventListener("click", async () => {
    const c = clienti.find(x => x.id === b.dataset.ricfatto); const prima = c.ultimoContatto || null;
    await setDoc(doc(col("clienti"), c.id), { ultimoContatto: oggi() }, { merge: true });
    avviso(`💜 ${c.nome}: sentita`, () => setDoc(doc(col("clienti"), c.id), { ultimoContatto: prima }, { merge: true }));
  }));
  $("#banner-backup")?.addEventListener("click", scaricaBackup);
}

// ---------- Backup ----------
function bannerBackup() {
  if (ordini.length < 5) return "";
  const ultimo = impostazioni.ultimoBackup;
  const giorni = ultimo ? Math.round((new Date(oggi()) - new Date(ultimo)) / 86400000) : null;
  if (giorni !== null && giorni < 30) return "";
  return `<div class="banner"><span>💾 ${ultimo ? `Ultima copia di sicurezza ${giorni} giorni fa` : "Fai una copia di sicurezza dei tuoi dati"}</span>
    <button class="pill c-gold" id="banner-backup">Salva copia</button></div>`;
}

async function scaricaBackup() {
  const dati = { app: "ordini-beauty", versione: 1, creato: new Date().toISOString(), clienti, ordini, catalogo, movimentiOmaggi: movimenti,
    impostazioni: { giorniRicontatto: impostazioni.giorniRicontatto } };
  const json = JSON.stringify(dati, (k, v) => (v && typeof v === "object" && typeof v.toDate === "function") ? v.toDate().toISOString() : v, 2);
  scarica(new Blob([json], { type: "application/json" }), `copia-ordini-${oggi()}.json`);
  await setDoc(docImpostazioni(), { ultimoBackup: oggi() }, { merge: true });
  avviso("💾 Copia di sicurezza scaricata");
}

async function ripristinaBackup(file) {
  let dati;
  try { dati = JSON.parse(await file.text()); } catch { return alert("Il file non è una copia di sicurezza valida."); }
  if (dati.app !== "ordini-beauty") return alert("Il file non è una copia di sicurezza di questa app.");
  if (!confirm(`Ripristino ${dati.clienti?.length || 0} clienti e ${dati.ordini?.length || 0} ordini. Continuo?`)) return;
  const ops = [];
  for (const [nome, lista] of [["clienti", dati.clienti], ["ordini", dati.ordini], ["catalogo", dati.catalogo], ["movimentiOmaggi", dati.movimentiOmaggi]])
    for (const { id, ...resto } of lista || []) ops.push([doc(col(nome), id || nuovoId()), resto]);
  await scriviABlocchi(ops);
  if (dati.impostazioni) await setDoc(docImpostazioni(), dati.impostazioni, { merge: true });
  avviso("✓ Dati ripristinati");
}

async function scriviABlocchi(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([ref, dati]) => b.set(ref, dati));
    await b.commit();
  }
}

function scarica(blob, nome) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- ORDINI ----------
function renderOrdini() {
  if (!ordini.length) {
    $("#view").innerHTML = `<div class="empty"><div class="e-ico">🛍️</div><b>Nessun ordine</b><br>Tocca “Nuovo ordine” per iniziare.</div>`;
    return;
  }
  let h = "", meseCorr = "";
  for (const o of ordini) {
    const m = (o.data || "").slice(0, 7);
    if (m !== meseCorr) {
      meseCorr = m;
      h += `<div class="section"><h2 style="text-transform:capitalize">${new Date(m + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" })}</h2></div>`;
    }
    const c = calcolaOrdine(o);
    const nomi = [...new Set((o.righe || []).map(nomeRiga))].join(", ");
    h += `<div class="card b-blue tap" data-open="${o.id}">
      <div class="row"><h3>${dataLunga(o.data)}</h3><span class="amount num" style="color:${c.guadagnoAtteso < 0 ? "var(--red)" : "var(--green)"}">${c.guadagnoAtteso >= 0 ? "+" : ""}${euro(c.guadagnoAtteso)}</span></div>
      <div class="sub">${esc(nomi)}</div>
      ${c.daConsegnare ? `<span class="badge c-orange">📦 ${c.daConsegnare} da consegnare</span>` : ""}
      ${c.daIncassare > 0 ? `<span class="badge c-pink">💶 ${euro(c.daIncassare)} da incassare</span>` : ""}
      ${!c.daConsegnare && c.daIncassare <= 0 ? `<span class="badge c-green">✓ Tutto fatto</span>` : ""}
      ${!o.costo ? `<span class="badge c-gold">🧾 Manca quanto hai pagato</span>` : ""}
    </div>`;
  }
  $("#view").innerHTML = h;
  $$("[data-open]").forEach(el => el.addEventListener("click", () => apriOrdine(ordini.find(o => o.id === el.dataset.open))));
}

// ---------- Schermata a comparsa ----------
let sheetChiudi = null;          // funzione che decide se si può chiudere
function apriSheet() { if (!$("#sheet").open) $("#sheet").showModal(); }
function chiudiSheet(forza) {
  if (!forza && sheetChiudi && !sheetChiudi()) return;
  sheetChiudi = null; $("#sheet").close();
}
$("#sheet").addEventListener("cancel", (e) => { e.preventDefault(); chiudiSheet(); });

function testataSheet(titolo, indietro, passi) {
  return `<div class="sh-head"><button id="sh-back">${indietro ? "‹ Indietro" : "✕"}</button><div class="sh-title">${esc(titolo)}</div><span style="min-width:44px"></span></div>
    ${passi ? `<div class="sh-steps">${[1, 2, 3].map(n => `<span class="${n <= passi ? "on" : ""}"></span>`).join("")}</div>` : ""}`;
}

// ---------- NUOVO / MODIFICA ORDINE (a passaggi) ----------
function apriOrdine(o) {
  const ord = o ? structuredClone(o) : { data: oggi(), costo: null, costoIoManuale: null, omaggiRicevuti: [], omaggiNote: "", note: "", righe: [] };
  ord.omaggiRicevuti ||= [];
  for (const r of ord.righe) {
    r.id ||= nuovoId(); r.omaggiDati ||= [];
    if (!r.articoli) r.articoli = r.prodotti || r.importo ? [{ nome: r.prodotti || "Prodotti", prezzo: Number(r.importo) || 0 }] : [];
    r.sconto ||= 0;
  }
  let modificato = false;
  const nuoviPrezzi = [];
  let passo = o ? "panoramica" : "chi";
  let idx = 0;
  let nuovaRiga = !o;
  if (!o) ord.righe.push(rigaVuota());
  let cercaChi = "", mostraNuovaCliente = false;

  sheetChiudi = () => !modificato || confirm("Uscire senza salvare? Le modifiche andranno perse.");
  const totaleRiga = (r) => Math.round((somma(r.articoli, a => a.prezzo) - (Number(r.sconto) || 0)) * 100) / 100;
  const rigaPronta = (r) => ({ ...r, importo: totaleRiga(r), prodotti: r.articoli.map(a => a.nome).join(", ") });
  const segna = () => { modificato = true; };

  const disegna = () => {
    const r = ord.righe[idx];
    ({ chi: passoChi, cosa: passoCosa, stato: passoStato, panoramica: passoPanoramica })[passo](r);
    $("#sh-back").addEventListener("click", indietro);
    apriSheet();
    $(".sh-main").scrollTop = 0;
  };

  function indietro() {
    if (passo === "chi") {
      if (nuovaRiga) {
        ord.righe.splice(idx, 1); nuovaRiga = false;
        if (!ord.righe.length) return chiudiSheet();
        passo = "panoramica";
      } else passo = "cosa";
    } else if (passo === "cosa") passo = nuovaRiga ? "chi" : "panoramica";
    else if (passo === "stato") passo = "cosa";
    else return chiudiSheet();
    disegna();
  }

  // Passo 1 — Per chi?
  function passoChi(r) {
    const recenti = new Map();
    for (const oo of ordini) for (const rr of oo.righe || []) if (rr.clienteId && rr.clienteId !== IO && rr.clienteId !== STORICO && !recenti.has(rr.clienteId)) recenti.set(rr.clienteId, true);
    const ordinate = [...clienti].sort((a, b) => (recenti.has(b.id) - recenti.has(a.id)) || a.nome.localeCompare(b.nome, "it"));
    const filtrate = ordinate.filter(c => !cercaChi || chiave(c.nome).includes(chiave(cercaChi))).slice(0, 40);
    $("#sheet-body").innerHTML = testataSheet(o ? "Ordine" : "Nuovo ordine", !nuovaRiga || ord.righe.length > 1, 1) + `
      <div class="sh-main">
        <div class="question">Per chi è?</div>
        <p class="q-hint">Tocca il nome della cliente.</p>
        ${clienti.length > 8 ? `<input id="chi-cerca" class="search" placeholder="🔍 Cerca per nome" value="${esc(cercaChi)}">` : ""}
        <div class="chips">
          ${r.clienteId === STORICO ? `<button class="chip sel" data-chi="${STORICO}">${esc(r.clientiStorico)}</button>` : ""}
          <button class="chip me ${r.clienteId === IO ? "sel" : ""}" data-chi="${IO}">🙋‍♀️ Per me</button>
          ${filtrate.map(c => `<button class="chip ${r.clienteId === c.id ? "sel" : ""}" data-chi="${c.id}">${esc(c.nome)}</button>`).join("")}
          <button class="chip new" id="chi-nuova">➕ Nuova cliente</button>
        </div>
        <div id="box-nuova" class="${mostraNuovaCliente ? "" : "hidden"}" style="margin-top:16px">
          <label>Nome della nuova cliente</label>
          <input id="nuova-nome" placeholder="Es. Giulia Rossi" autocomplete="off">
          <label>Cellulare (per WhatsApp, facoltativo)</label>
          <input id="nuova-tel" type="tel" placeholder="333 1234567">
          <button class="big primary" id="nuova-ok" style="margin-top:12px">Aggiungi e continua</button>
        </div>
      </div>`;
    $("#chi-cerca")?.addEventListener("input", (e) => { cercaChi = e.target.value; const pos = e.target.selectionStart; passoChi(r); $("#sh-back").addEventListener("click", indietro); const i = $("#chi-cerca"); i.focus(); i.setSelectionRange(pos, pos); });
    $$("[data-chi]").forEach(b => b.addEventListener("click", () => { r.clienteId = b.dataset.chi; segna(); passo = "cosa"; disegna(); }));
    $("#chi-nuova").addEventListener("click", () => { mostraNuovaCliente = true; $("#box-nuova").classList.remove("hidden"); $("#nuova-nome").focus(); });
    $("#nuova-ok").addEventListener("click", async () => {
      const nome = $("#nuova-nome").value.trim(); if (!nome) return $("#nuova-nome").focus();
      const ref = await addDoc(col("clienti"), { nome, telefono: $("#nuova-tel").value.trim(), note: "" });
      if (!clienti.some(c => c.id === ref.id)) clienti.push({ id: ref.id, nome, telefono: $("#nuova-tel").value.trim() });
      r.clienteId = ref.id; mostraNuovaCliente = false; segna(); passo = "cosa"; disegna();
    });
  }

  // Passo 2 — Cosa ha preso?
  function passoCosa(r) {
    const isIo = r.clienteId === IO;
    $("#sheet-body").innerHTML = testataSheet(nomeRiga(r), true, 2) + `
      <div class="sh-main">
        <div class="question">${isIo ? "Cosa hai preso per te?" : `Cosa ha preso ${esc(primoNome({ nome: nomeRiga(r) }))}?`}</div>
        <p class="q-hint">Scrivi un prodotto alla volta con il suo prezzo.</p>
        <div class="items">${r.articoli.map((a, i) => `<div class="item"><div class="i-name">${esc(a.nome)}</div>
            <b class="num">${euro(a.prezzo)}</b><button class="x" data-xart="${i}" aria-label="Togli">×</button></div>`).join("")}</div>
        <div class="add-box">
          <input id="art-nome" list="dl-prodotti" placeholder="Nome del prodotto" autocomplete="off">
          <div class="two"><input id="art-prezzo" inputmode="decimal" placeholder="Prezzo €" autocomplete="off">
            <button class="c-blue" id="art-add">＋ Aggiungi</button></div>
        </div>
        <div class="total-line"><span>Totale</span><b class="num">${euro(totaleRiga(r))}</b></div>
        <details class="more" ${r.sconto ? "open" : ""}><summary>Hai fatto uno sconto?</summary>
          <label>Sconto in euro</label><input id="art-sconto" inputmode="decimal" placeholder="0" value="${esc(inIt(r.sconto || ""))}">
        </details>
      </div>
      <div class="sh-foot"><button class="big primary" id="avanti">Avanti →</button></div>`;
    const nomeIn = $("#art-nome"), prezzoIn = $("#art-prezzo");
    const suggerisciPrezzo = () => { const p = catalogo.find(x => chiave(x.nome) === chiave(nomeIn.value)); if (p?.prezzo && !prezzoIn.value) prezzoIn.value = inIt(p.prezzo); };
    nomeIn.addEventListener("change", suggerisciPrezzo);
    nomeIn.addEventListener("input", suggerisciPrezzo);
    const aggiungi = () => {
      const nome = nomeIn.value.trim();
      if (!nome) { nomeIn.focus(); return false; }
      const prezzo = numIt(prezzoIn.value);
      r.articoli.push({ nome, prezzo }); segna();
      if (prezzo) nuoviPrezzi.push({ nome, prezzo });
      return true;
    };
    $("#art-add").addEventListener("click", () => { if (aggiungi()) { passoCosa(r); $("#sh-back").addEventListener("click", indietro); $("#art-nome").focus(); } });
    prezzoIn.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#art-add").click(); });
    nomeIn.addEventListener("keydown", (e) => { if (e.key === "Enter") prezzoIn.focus(); });
    $$("[data-xart]").forEach(b => b.addEventListener("click", () => { r.articoli.splice(+b.dataset.xart, 1); segna(); passoCosa(r); $("#sh-back").addEventListener("click", indietro); }));
    $("#art-sconto").addEventListener("input", (e) => { r.sconto = numIt(e.target.value); segna(); $(".total-line b").textContent = euro(totaleRiga(r)); });
    $("#avanti").addEventListener("click", () => {
      if (nomeIn.value.trim()) aggiungi();   // prodotto scritto ma non aggiunto: lo aggiungo io
      if (!r.articoli.length) { nomeIn.focus(); avviso("Aggiungi almeno un prodotto"); return; }
      passo = "stato"; disegna();
    });
  }

  // Passo 3 — Pagato? Consegnato?
  function passoStato(r) {
    const isIo = r.clienteId === IO;
    const yn = (campo, domanda) => `<div class="yesno"><div class="yn-q">${domanda}</div><div class="yn-b">
        <button data-yn="${campo}" data-v="1" class="${r[campo] ? "on-yes" : ""}">👍 Sì</button>
        <button data-yn="${campo}" data-v="0" class="${!r[campo] ? "on-no" : ""}">Non ancora</button></div></div>`;
    $("#sheet-body").innerHTML = testataSheet(nomeRiga(r), true, 3) + `
      <div class="sh-main">
        <div class="question">Ultime cose</div>
        <p class="q-hint">Totale ${euro(totaleRiga(r))}</p>
        ${isIo ? "" : yn("pagato", "💶 Ha già pagato?")}
        ${yn("consegnato", isIo ? "📦 Ce l'hai già?" : "📦 Le hai già consegnato i prodotti?")}
        ${isIo ? "" : `<div class="yesno"><div class="yn-q">🎁 Le hai dato un omaggio?</div>
          <div class="items">${r.omaggiDati.map((x, i) => `<div class="item"><div class="i-name">${x.qta > 1 ? x.qta + " × " : ""}${esc(x.nome)}</div>
            <button class="x" data-xom="${i}">×</button></div>`).join("")}</div>
          <div class="add-box" style="box-shadow:none;padding:0"><div class="two"><input id="om-nome" list="dl-omaggi" placeholder="Es. campioncino" autocomplete="off">
            <button class="c-gold" id="om-add">＋ Aggiungi</button></div></div></div>
        <div class="yesno"><div class="yn-q">⏰ Ricordami di risentirla</div><div class="chips">
          ${[["", "No"], ["30", "Tra 1 mese"], ["60", "Tra 2 mesi"], ["90", "Tra 3 mesi"]].map(([v, t]) =>
            `<button class="chip ${String(r.riacquistoGiorni || "") === v ? "sel" : ""}" data-ric="${v}">${t}</button>`).join("")}</div>
          <div class="hint">Utile per creme e prodotti che finiscono.</div></div>`}
        <button class="danger" id="rimuovi" style="width:100%;margin-top:6px">Togli ${isIo ? "questa parte" : "questa cliente"} dall'ordine</button>
      </div>
      <div class="sh-foot"><button class="big primary" id="fatto">✓ Fatto</button></div>`;
    const ridisegna = () => { passoStato(r); $("#sh-back").addEventListener("click", indietro); };
    $$("[data-yn]").forEach(b => b.addEventListener("click", () => { r[b.dataset.yn] = b.dataset.v === "1"; segna(); ridisegna(); }));
    $$("[data-ric]").forEach(b => b.addEventListener("click", () => { r.riacquistoGiorni = b.dataset.ric ? Number(b.dataset.ric) : null; segna(); ridisegna(); }));
    $$("[data-xom]").forEach(b => b.addEventListener("click", () => { r.omaggiDati.splice(+b.dataset.xom, 1); segna(); ridisegna(); }));
    $("#om-add")?.addEventListener("click", () => {
      const nome = $("#om-nome").value.trim(); if (!nome) return $("#om-nome").focus();
      const e = r.omaggiDati.find(x => chiave(x.nome) === chiave(nome)); if (e) e.qta++; else r.omaggiDati.push({ nome, qta: 1 });
      segna(); ridisegna();
    });
    $("#rimuovi").addEventListener("click", () => {
      if (!confirm("Togliere dall'ordine?")) return;
      ord.righe.splice(idx, 1); segna(); nuovaRiga = false;
      if (!ord.righe.length && !o) return chiudiSheet(true);
      passo = "panoramica"; disegna();
    });
    $("#fatto").addEventListener("click", () => { nuovaRiga = false; passo = "panoramica"; disegna(); });
  }

  // Riepilogo dell'ordine
  function passoPanoramica() {
    const pronte = ord.righe.map(rigaPronta);
    const c = calcolaOrdine({ ...ord, righe: pronte, costo: numIt(ord.costo) });
    const haCosto = numIt(ord.costo) > 0;
    $("#sheet-body").innerHTML = testataSheet(o ? `Ordine del ${dataLunga(ord.data)}` : "Nuovo ordine", false) + `
      <div class="sh-main">
        <div class="question">${plurale(pronte.length, "persona", "persone")} in quest'ordine</div>
        <p class="q-hint">Tocca una scheda per cambiarla.</p>
        ${pronte.map((r, i) => `<div class="card tap ${r.clienteId === IO ? "b-pink" : "b-blue"}" data-riga="${i}">
          <div class="row"><div class="who">${avatar(nomeRiga(r), r.clienteId === IO)}<div><h3>${esc(nomeRiga(r))}</h3>
            <div class="sub">${esc(r.prodotti)}</div></div></div><div class="amount num">${euro(r.importo)}</div></div>
          ${r.clienteId === IO ? "" : `<span class="badge ${r.pagato ? "c-green" : "c-pink"}">${r.pagato ? "✓ Pagato" : "💶 Da pagare"}</span>`}
          <span class="badge ${r.consegnato ? "c-green" : "c-orange"}">${r.consegnato ? "✓ Consegnato" : "📦 Da consegnare"}</span>
          ${r.omaggiDati?.length ? `<span class="badge c-gold">🎁 ${r.omaggiDati.reduce((s, x) => s + x.qta, 0)}</span>` : ""}
        </div>`).join("")}
        <button class="big c-blue" id="add-cliente">＋ Aggiungi un'altra persona</button>

        <div class="yesno" style="margin-top:20px"><div class="yn-q">🧾 Quanto hai pagato a Yves Rocher?</div>
          <input id="costo" class="money" inputmode="decimal" placeholder="0,00 €" value="${esc(inIt(ord.costo))}">
          <div class="hint">Il totale dell'ordine che hai fatto all'azienda. Puoi metterlo anche dopo.</div></div>

        <div class="result ${haCosto ? (c.guadagnoAtteso >= 0 ? "c-green" : "c-pink") : "c-gold"}" id="risultato">${risultatoHtml(c, haCosto)}</div>

        <details class="more"><summary>🎁 Omaggi arrivati con l'ordine${ord.omaggiRicevuti.length ? ` (${ord.omaggiRicevuti.reduce((s, x) => s + x.qta, 0)})` : ""}</summary>
          ${ord.omaggiNote ? `<div class="hint">Dal vecchio file: ${esc(ord.omaggiNote)}</div>` : ""}
          <div class="items">${ord.omaggiRicevuti.map((x, i) => `<div class="item"><div class="i-name">${esc(x.nome)}</div>
            <input class="qta-in" data-qric="${i}" inputmode="numeric" value="${x.qta}" style="width:70px;text-align:center;padding:8px">
            <button class="x" data-xric="${i}">×</button></div>`).join("")}</div>
          <div class="two" style="display:grid;grid-template-columns:1fr 110px;gap:8px"><input id="ric-nome" list="dl-omaggi" placeholder="Es. campioncini" autocomplete="off">
            <button class="c-gold" id="ric-add">＋ Aggiungi</button></div>
        </details>

        <details class="more"><summary>⚙️ Altro (data, note…)</summary>
          <label>Data dell'ordine</label><input type="date" id="data" value="${esc(ord.data)}">
          ${c.valoreIo > 0 ? `<label>Quanto hai pagato davvero i tuoi prodotti? (facoltativo)</label>
            <input id="costoio" inputmode="decimal" placeholder="${inIt(c.quotaIo.toFixed(2))} (calcolato da solo)" value="${esc(inIt(ord.costoIoManuale))}">
            <div class="hint">Lascia vuoto e l'app lo calcola in proporzione.</div>` : ""}
          <label>Note</label><textarea id="note">${esc(ord.note)}</textarea>
          ${o ? `<button class="danger" id="elimina" style="width:100%;margin-top:12px">🗑 Elimina questo ordine</button>` : ""}
        </details>
      </div>
      <div class="sh-foot"><button class="big primary" id="salva">✓ Salva ordine</button></div>`;

    const aggiornaRisultato = () => {
      const cc = calcolaOrdine({ ...ord, righe: ord.righe.map(rigaPronta), costo: numIt(ord.costo),
        costoIoManuale: ord.costoIoManuale === "" || ord.costoIoManuale == null ? null : numIt(ord.costoIoManuale) });
      const hc = numIt(ord.costo) > 0;
      const box = $("#risultato");
      box.className = "result " + (hc ? (cc.guadagnoAtteso >= 0 ? "c-green" : "c-pink") : "c-gold");
      box.innerHTML = risultatoHtml(cc, hc);
    };
    $$("[data-riga]").forEach(el => el.addEventListener("click", () => { idx = +el.dataset.riga; passo = "cosa"; disegna(); }));
    $("#add-cliente").addEventListener("click", () => { ord.righe.push(rigaVuota()); idx = ord.righe.length - 1; nuovaRiga = true; cercaChi = ""; passo = "chi"; disegna(); });
    $("#costo").addEventListener("input", (e) => { ord.costo = e.target.value; segna(); aggiornaRisultato(); });
    $("#costoio")?.addEventListener("input", (e) => { ord.costoIoManuale = e.target.value; segna(); aggiornaRisultato(); });
    $("#data").addEventListener("change", (e) => { ord.data = e.target.value; segna(); });
    $("#note").addEventListener("input", (e) => { ord.note = e.target.value; segna(); });
    $$("[data-qric]").forEach(i => i.addEventListener("input", () => { ord.omaggiRicevuti[+i.dataset.qric].qta = Math.max(1, parseInt(i.value) || 1); segna(); }));
    $$("[data-xric]").forEach(b => b.addEventListener("click", () => { ord.omaggiRicevuti.splice(+b.dataset.xric, 1); segna(); passoPanoramica(); $("#sh-back").addEventListener("click", indietro); $$("details.more")[0].open = true; }));
    $("#ric-add").addEventListener("click", () => {
      const nome = $("#ric-nome").value.trim(); if (!nome) return $("#ric-nome").focus();
      const e = ord.omaggiRicevuti.find(x => chiave(x.nome) === chiave(nome)); if (e) e.qta++; else ord.omaggiRicevuti.push({ nome, qta: 1 });
      segna(); passoPanoramica(); $("#sh-back").addEventListener("click", indietro); $$("details.more")[0].open = true;
    });
    $("#elimina")?.addEventListener("click", async () => {
      if (!confirm("Eliminare questo ordine?")) return;
      const copia = structuredClone(o); delete copia.id;
      await deleteDoc(doc(col("ordini"), o.id)); chiudiSheet(true);
      avviso("🗑 Ordine eliminato", () => setDoc(doc(col("ordini"), o.id), copia));
    });
    $("#salva").addEventListener("click", salva);
  }

  async function salva() {
    const righe = ord.righe.filter(r => r.clienteId && r.articoli.length).map(r => {
      const p = rigaPronta(r);
      return { ...p, pagato: p.clienteId === IO ? true : !!p.pagato, consegnato: !!p.consegnato, riacquistoGiorni: p.riacquistoGiorni || null };
    });
    if (!righe.length) return avviso("Aggiungi almeno una persona con dei prodotti");
    const { id, ...resto } = ord;
    const dati = { ...resto, righe, costo: numIt(ord.costo),
      costoIoManuale: ord.costoIoManuale === "" || ord.costoIoManuale == null ? null : numIt(ord.costoIoManuale), aggiornato: serverTimestamp() };
    $("#salva").disabled = true;
    if (o) await setDoc(doc(col("ordini"), o.id), dati); else await addDoc(col("ordini"), dati);
    for (const p of nuoviPrezzi) setDoc(doc(col("catalogo"), slug(p.nome)), { nome: p.nome, prezzo: p.prezzo, ultimoUso: oggi() }, { merge: true });
    chiudiSheet(true);
    avviso(o ? "✓ Ordine aggiornato" : "✓ Ordine salvato");
  }

  disegna();
}

const rigaVuota = () => ({ id: nuovoId(), clienteId: "", articoli: [], sconto: 0, omaggiDati: [], pagato: false, consegnato: false, riacquistoGiorni: null });

function risultatoHtml(c, haCosto) {
  if (!haCosto) return `<div class="r-lbl">🌿 Il tuo guadagno</div><div class="r-sub" style="margin-top:6px">Scrivi quanto hai pagato a Yves Rocher e lo calcolo io.</div>`;
  return `<div class="r-lbl">🌿 Ti resta in tasca</div><div class="r-val num">${euro(c.guadagnoAtteso)}</div>
    <div class="r-sub">Venduto ${euro(c.venditaClienti)} · costo ${euro(c.costoClienti)}${c.valoreIo > 0 ? ` · per te ${euro(c.quotaIo)}` : ""}</div>
    ${c.daIncassare > 0 ? `<div class="r-sub">di cui ancora da incassare ${euro(c.daIncassare)}</div>` : ""}`;
}

// ---------- CLIENTI ----------
function acquistiCliente(c) {
  const k = chiave(c.nome);
  return ordini.flatMap(o => (o.righe || []).filter(r => r.clienteId === c.id ||
    (r.clienteId === STORICO && String(r.clientiStorico || "").split(",").map(chiave).includes(k))).map(r => ({ o, r })));
}

function renderClienti() {
  if (!clienti.length) { $("#view").innerHTML = `<div class="empty"><div class="e-ico">👩</div><b>Nessuna cliente</b><br>Si aggiungono da sole quando crei un ordine.</div>`; return; }
  let h = `<input type="search" id="cerca" class="search" placeholder="🔍 Cerca una cliente" value="${esc(cercaClienti)}">`;
  const filtrate = clienti.filter(c => !cercaClienti || chiave(c.nome).includes(chiave(cercaClienti)));
  for (const c of filtrate) {
    const acq = acquistiCliente(c);
    const deve = somma(acq.filter(x => x.r.clienteId === c.id && !x.r.pagato), x => x.r.importo);
    const ultimo = acq.map(x => x.o.data).filter(Boolean).sort().pop();
    h += `<div class="card tap" data-cli="${c.id}"><div class="row"><div class="who">${avatar(c.nome)}<div><h3>${esc(c.nome)}</h3>
      <div class="sub">${ultimo ? `Ultimo acquisto: ${dataLunga(ultimo)}` : "Nessun acquisto"}</div></div></div>
      ${deve ? `<span class="badge c-pink num" style="margin:0">deve ${euro(deve)}</span>` : ""}</div></div>`;
  }
  if (!filtrate.length) h += `<div class="empty">Nessuna cliente con questo nome.</div>`;
  $("#view").innerHTML = h;
  $("#cerca").addEventListener("input", (e) => {
    cercaClienti = e.target.value; const pos = e.target.selectionStart;
    renderClienti(); const i = $("#cerca"); i.focus(); i.setSelectionRange(pos, pos);
  });
  $$("[data-cli]").forEach(el => el.addEventListener("click", () => apriCliente(clienti.find(c => c.id === el.dataset.cli))));
}

function apriCliente(c) {
  const acq = c ? acquistiCliente(c).sort((a, b) => (b.o.data || "").localeCompare(a.o.data || "")) : [];
  const proprie = acq.filter(x => x.r.clienteId === c?.id);
  const speso = somma(proprie, x => x.r.importo);
  const daPagare = proprie.filter(x => !x.r.pagato).map(x => x.r);
  const daConsegnare = proprie.filter(x => !x.r.consegnato).map(x => x.r);
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet(c ? "Cliente" : "Nuova cliente", false) + `
    <div class="sh-main">
      ${c ? `<div style="text-align:center;margin:6px 0 16px">
          <div class="avatar ${coloreDi(c.nome)}" style="width:76px;height:76px;font-size:30px;margin:0 auto">${esc(iniziali(c.nome))}</div>
          <div class="question" style="margin-top:8px">${esc(c.nome)}</div></div>
        <div class="tiles">
          <div class="tile c-blue"><div class="t-ico">🛍️</div><div class="t-val num">${euro(speso)}</div><div class="t-lbl">spesi in totale</div></div>
          <div class="tile ${daPagare.length ? "c-pink" : "c-green"}"><div class="t-ico">💶</div><div class="t-val num">${euro(somma(daPagare, r => r.importo))}</div><div class="t-lbl">da pagare</div></div>
        </div>
        <div class="stack" style="margin:12px 0 4px">
          ${daConsegnare.length ? `<button class="wa" id="wa-consegna">💬 Avvisala che è arrivato</button>` : ""}
          ${daPagare.length ? `<button class="wa" id="wa-paga">💬 Ricordale il pagamento</button>` : ""}
          <button class="wa" id="wa-libero">💬 Scrivile su WhatsApp</button>
          ${c.telefono ? `<a href="tel:${esc(c.telefono.replace(/\s/g, ""))}" style="text-decoration:none"><button class="c-blue" style="width:100%;text-align:left">📞 Chiamala</button></a>` : ""}
        </div>` : `<div class="question">Nuova cliente</div>`}
      <div class="yesno" style="margin-top:14px">
        <label style="margin-top:0">Nome</label><input id="c-nome" value="${esc(c?.nome)}" placeholder="Es. Giulia Rossi">
        <label>Cellulare (per WhatsApp)</label><input id="c-tel" type="tel" value="${esc(c?.telefono)}" placeholder="333 1234567">
        <label>Note (tipo di pelle, gusti, compleanno…)</label><textarea id="c-note">${esc(c?.note)}</textarea>
      </div>
      ${acq.length ? `<div class="section"><h2>🛍️ Acquisti</h2></div>${acq.map(({ o, r }) => `<div class="card" style="padding:12px 16px">
        <div class="row"><b>${dataLunga(o.data)}</b><span class="num">${r.clienteId === STORICO ? "ordine di gruppo" : euro(r.importo)}</span></div>
        <div class="sub">${esc(r.prodotti)}</div></div>`).join("")}` : ""}
      ${c && !proprie.length ? `<button class="danger" id="c-del" style="width:100%;margin-top:10px">🗑 Elimina cliente</button>` : ""}
    </div>
    <div class="sh-foot"><button class="big primary" id="c-save">✓ Salva</button></div>`;
  const corrente = () => ({ ...c, nome: $("#c-nome").value.trim(), telefono: $("#c-tel").value.trim() });
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#wa-consegna")?.addEventListener("click", () => apriWhatsApp(corrente(), msgConsegna(corrente(), daConsegnare)));
  $("#wa-paga")?.addEventListener("click", () => apriWhatsApp(corrente(), msgPagamento(corrente(), daPagare)));
  $("#wa-libero")?.addEventListener("click", () => apriWhatsApp(corrente(), `Ciao ${primoNome(corrente())}! `));
  $("#c-save").addEventListener("click", async () => {
    const nome = $("#c-nome").value.trim(); if (!nome) return $("#c-nome").focus();
    const dati = { nome, telefono: $("#c-tel").value.trim(), note: $("#c-note").value };
    if (c) await setDoc(doc(col("clienti"), c.id), dati, { merge: true }); else await addDoc(col("clienti"), dati);
    chiudiSheet(true); avviso("✓ Salvato");
  });
  $("#c-del")?.addEventListener("click", async () => {
    if (!confirm(`Eliminare ${c.nome}?`)) return;
    const { id, ...copia } = c;
    await deleteDoc(doc(col("clienti"), c.id)); chiudiSheet(true);
    avviso("🗑 Cliente eliminata", () => setDoc(doc(col("clienti"), id), copia));
  });
  apriSheet();
}

// ---------- OMAGGI ----------
function renderOmaggi() {
  const g = giacenzaOmaggi(ordini, movimenti);
  let h = `<p class="section-hint" style="margin-top:0">Quanti omaggi e campioncini ti restano. Si aggiornano da soli con gli ordini; usa ＋ e − per quelli arrivati o dati fuori dagli ordini.</p>`;
  if (!g.length) h += `<div class="empty"><div class="e-ico">🎁</div><b>Nessun omaggio</b><br>Aggiungili negli ordini oppure con “Nuovo omaggio”.</div>`;
  for (const v of g) {
    h += `<div class="card b-gold"><div class="gift">
      <div class="g-n"><h3>${esc(v.nome)}</h3><div class="sub">arrivati ${v.ricevuti + Math.max(0, v.rettifiche)} · dati ${v.dati + Math.max(0, -v.rettifiche)}</div></div>
      <div class="g-q" style="color:${v.giacenza < 0 ? "var(--red)" : "var(--gold)"}">${v.giacenza}</div>
      <div class="g-b"><button class="c-pink" data-mov="${esc(v.nome)}" data-q="-1" aria-label="Uno in meno">−</button>
        <button class="c-green" data-mov="${esc(v.nome)}" data-q="1" aria-label="Uno in più">＋</button></div>
    </div></div>`;
  }
  $("#view").innerHTML = h;
  $$("[data-mov]").forEach(b => b.addEventListener("click", async () => {
    const ref = await addDoc(col("movimentiOmaggi"), { nome: b.dataset.mov, qta: Number(b.dataset.q), data: oggi(), nota: "" });
    avviso(`🎁 ${b.dataset.mov}: ${b.dataset.q > 0 ? "uno in più" : "uno in meno"}`, () => deleteDoc(ref));
  }));
}

function apriNuovoOmaggio() {
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Nuovo omaggio", false) + `
    <div class="sh-main">
      <div class="question">Che omaggio ti è arrivato?</div>
      <p class="q-hint">Per campioncini e regali arrivati fuori da un ordine.</p>
      <label>Nome</label><input id="no-nome" list="dl-omaggi" placeholder="Es. campioncini crema" autocomplete="off">
      <label>Quanti?</label><input id="no-qta" class="money" inputmode="numeric" value="1">
    </div>
    <div class="sh-foot"><button class="big primary" id="no-ok">✓ Aggiungi</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#no-ok").addEventListener("click", async () => {
    const nome = $("#no-nome").value.trim(); if (!nome) return $("#no-nome").focus();
    await addDoc(col("movimentiOmaggi"), { nome, qta: Math.max(1, parseInt($("#no-qta").value) || 1), data: oggi(), nota: "" });
    chiudiSheet(true); avviso("🎁 Omaggio aggiunto");
  });
  apriSheet();
}

// ---------- SOLDI ----------
function renderSoldi() {
  const nomeMese = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  const sposta = (k, d) => { const [y, m] = k.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return t.toISOString().slice(0, 7); };
  const anno = meseSel.slice(0, 4);
  const m = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(meseSel)));
  const a = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(anno)));
  const ultimo = oggi().slice(0, 7);

  $("#view").innerHTML = `
    <div class="month-nav"><button id="m-prev" aria-label="Mese prima">‹</button><div class="m">${nomeMese(meseSel)}</div>
      <button id="m-next" aria-label="Mese dopo" ${meseSel >= ultimo ? "disabled style='opacity:.3'" : ""}>›</button></div>
    <div class="big-money ${m.guadagnoAtteso >= 0 ? "c-green" : "c-pink"}"><div style="font-weight:700">🌿 Ti sei messa in tasca</div>
      <div class="v num">${euro(m.guadagnoAtteso)}</div><div style="font-size:14px;opacity:.85">${plurale(m.ordini, "ordine", "ordini")} questo mese</div></div>
    <div class="tiles">
      <div class="tile c-blue"><div class="t-ico">🛍️</div><div class="t-val num">${euro(m.venditaClienti)}</div><div class="t-lbl">venduto alle clienti</div></div>
      <div class="tile c-orange"><div class="t-ico">🧾</div><div class="t-val num">${euro(m.costo)}</div><div class="t-lbl">pagato a Yves Rocher</div></div>
      <div class="tile c-pink"><div class="t-ico">🙋‍♀️</div><div class="t-val num">${euro(m.quotaIo)}</div><div class="t-lbl">speso per te</div></div>
      <div class="tile c-purple"><div class="t-ico">⏳</div><div class="t-val num">${euro(m.daIncassare)}</div><div class="t-lbl">ancora da incassare</div></div>
    </div>
    <div class="section"><h2>📅 Tutto il ${anno}</h2></div>
    <div class="card">
      <div class="money-row"><span>Venduto alle clienti</span><b class="num">${euro(a.venditaClienti)}</b></div>
      <div class="money-row"><span>Pagato a Yves Rocher</span><b class="num">${euro(a.costo)}</b></div>
      <div class="money-row"><span>di cui per te</span><b class="num">${euro(a.quotaIo)}</b></div>
      <div class="money-row"><span>🌿 Guadagno</span><b class="num" style="color:${a.guadagnoAtteso >= 0 ? "var(--green)" : "var(--red)"}">${euro(a.guadagnoAtteso)}</b></div>
    </div>

    <div class="section"><h2>⚙️ Impostazioni</h2></div>
    <div class="yesno"><div class="yn-q">💜 Avvisami delle clienti che non comprano da</div><div class="chips">
      ${[[0, "Mai"], [30, "1 mese"], [60, "2 mesi"], [90, "3 mesi"]].map(([v, t]) =>
        `<button class="chip ${Number(impostazioni.giorniRicontatto) === v ? "sel" : ""}" data-giorni="${v}">${t}</button>`).join("")}</div></div>
    <div class="stack">
      <button id="b-backup">💾 Salva una copia di sicurezza${impostazioni.ultimoBackup ? `<div class="hint">Ultima: ${dataIt(impostazioni.ultimoBackup)}</div>` : ""}</button>
      <button id="b-export">📊 Scarica tutto in Excel</button>
      <button id="b-import">📥 Importa il vecchio file Excel</button>
      <button id="b-restore">♻️ Ripristina una copia di sicurezza</button>
    </div>
    <input type="file" id="file-restore" accept=".json,application/json" class="hidden">
    <button class="ghost" id="b-logout" style="width:100%;margin-top:22px">Esci (${esc(auth.currentUser?.email)})</button>
    <p class="versione" style="text-align:center">v7</p>`;
  $("#m-prev").addEventListener("click", () => { meseSel = sposta(meseSel, -1); renderSoldi(); });
  $("#m-next").addEventListener("click", () => { if (meseSel < ultimo) { meseSel = sposta(meseSel, 1); renderSoldi(); } });
  $$("[data-giorni]").forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { giorniRicontatto: Number(b.dataset.giorni) }, { merge: true })));
  $("#b-backup").addEventListener("click", scaricaBackup);
  $("#b-export").addEventListener("click", esportaCsv);
  $("#b-import").addEventListener("click", sceltaFileExcel);
  $("#b-restore").addEventListener("click", () => $("#file-restore").click());
  $("#file-restore").addEventListener("change", e => { if (e.target.files[0]) ripristinaBackup(e.target.files[0]); e.target.value = ""; });
  $("#b-logout").addEventListener("click", () => { if (confirm("Vuoi uscire?")) signOut(auth); });
}

function esportaCsv() {
  // CSV con ; e BOM: si apre correttamente in Excel italiano
  const n = (x) => (Number(x) || 0).toFixed(2).replace(".", ",");
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const listaOm = (arr) => (arr || []).map(x => `${x.qta > 1 ? x.qta + "x " : ""}${x.nome}`).join(", ");
  const righe = [["Data ordine", "Cliente", "Prodotti", "Omaggi dati", "Importo", "Pagato", "Consegnato", "Pagato a Yves Rocher", "Spesa per me", "Guadagno ordine"].join(";")];
  for (const o of [...ordini].reverse()) {
    const c = calcolaOrdine(o);
    (o.righe || []).forEach((r, i) => righe.push([dataIt(o.data), q(nomeRiga(r)), q(r.prodotti), q([listaOm(r.omaggiDati), r.omaggio].filter(Boolean).join(", ")),
      n(r.importo), r.pagato ? "sì" : "no", r.consegnato ? "sì" : "no",
      i === 0 ? n(o.costo) : "", i === 0 ? n(c.quotaIo) : "", i === 0 ? n(c.guadagnoAtteso) : ""].join(";")));
  }
  scarica(new Blob(["﻿" + righe.join("\n")], { type: "text/csv;charset=utf-8" }), `ordini-${oggi()}.csv`);
  avviso("📊 File Excel scaricato");
}

// ---------- Import del vecchio Excel ----------
function sceltaFileExcel() {
  const i = document.createElement("input");
  i.type = "file"; i.accept = ".xlsx,.xls,.csv"; i.className = "hidden"; i.id = "file-import";
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

  const { ordini: nuovi, nomiClienti, scartate } = risultato;
  if (!nuovi.length) return alert("Nel file non ho trovato ordini da importare.");
  const giaImportati = ordini.filter(o => o.importato).length;
  const nuoviNomi = nomiClienti.filter(n => !clienti.some(c => chiave(c.nome) === chiave(n)));
  const tot = riepilogoPeriodo(nuovi);
  const guadagnoFile = nuovi.reduce((s, o) => s + o._controllo.entrate - o._controllo.uscite, 0);
  const date = nuovi.map(o => o.data).sort();

  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet("Importa da Excel", false) + `
    <div class="sh-main">
      <div class="question">Ho trovato ${plurale(nuovi.length, "ordine", "ordini")}</div>
      <p class="q-hint">dal ${dataIt(date[0])} al ${dataIt(date.at(-1))} · ${plurale(nuoviNomi.length, "cliente nuova", "clienti nuove")}</p>
      ${giaImportati ? `<div class="banner">⚠️ Hai già importato ${giaImportati} ordini: importare di nuovo lo stesso file li duplica.</div>` : ""}
      <div class="tiles">
        <div class="tile c-pink"><div class="t-ico">📉</div><div class="t-val num">${euro(guadagnoFile)}</div><div class="t-lbl">guadagno nel vecchio file</div></div>
        <div class="tile c-green"><div class="t-ico">🌿</div><div class="t-val num">${euro(tot.guadagnoAtteso)}</div><div class="t-lbl">guadagno vero</div></div>
      </div>
      <p class="hint">La differenza: il vecchio file contava come perdita i ${euro(tot.quotaIo)} che hai speso per te.</p>
      <p class="hint">Gli ordini con più clienti restano “di gruppo”, perché il file non dice quanto ha speso ciascuna. Tutti gli ordini importati risultano pagati e consegnati.</p>
      ${scartate.length ? `<p class="hint">Righe saltate: ${scartate.map(s => `${s.riga} (${s.motivo})`).join(", ")}</p>` : ""}
    </div>
    <div class="sh-foot"><button class="big primary" id="imp-ok">📥 Importa</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#imp-ok").addEventListener("click", async () => {
    $("#imp-ok").disabled = true; $("#imp-ok").textContent = "Importo…";
    const idPerNome = new Map(clienti.map(c => [chiave(c.nome), c.id]));
    const ops = [];
    for (const nome of nuoviNomi) {
      const ref = doc(col("clienti"));
      idPerNome.set(chiave(nome), ref.id);
      ops.push([ref, { nome, telefono: "", note: "" }]);
    }
    for (const { _controllo, ...o } of nuovi) {
      o.righe = o.righe.map(({ clienteNome, ...r }) => ({ ...r, id: nuovoId(), clienteId: clienteNome ? idPerNome.get(chiave(clienteNome)) : r.clienteId }));
      ops.push([doc(col("ordini")), o]);
    }
    try { await scriviABlocchi(ops); chiudiSheet(true); avviso(`✓ Importati ${nuovi.length} ordini`); vai("ordini"); }
    catch (err) { alert("Errore durante l'importazione: " + err.message); $("#imp-ok").disabled = false; $("#imp-ok").textContent = "📥 Importa"; }
  });
  apriSheet();
}

// ---------- App installabile ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
