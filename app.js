import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  addDoc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { calcolaOrdine, riepilogoPeriodo, giacenzaOmaggi, daRicontattare, linkWhatsApp, euro, chiave, IO, SCORTA, STORICO,
  isSpeciale, statoScorta, guadagnoPerMese, inventarioScorta, completaCostiScorta, costoDaConfezione, omaggiOrdine } from "./calc.js?v=14";
import { convertiFoglio, parseOmaggi } from "./importa.js?v=14";

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
let vistaOmaggi = "ordini";

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

const nomeRiga = (r) => r.clienteId === IO ? "Per me" : r.clienteId === SCORTA ? "Da rivendere" : r.clienteId === STORICO ? (r.clientiStorico || "Più clienti")
  : (clienti.find(c => c.id === r.clienteId)?.nome || "Cliente eliminata");
const primoNome = (c) => String(c?.nome || "").split(" ")[0];
const arrivato = (o) => o.arrivato !== false;   // ordini vecchi (senza il campo) = arrivati
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const compleannoTesto = (mmdd) => { if (!mmdd) return ""; const [m, d] = mmdd.split("-").map(Number); return `${d} ${MESI[m - 1]}`; };
// prossimo compleanno: { data: "AAAA-MM-GG", giorni: 0 = oggi }
function prossimoCompleanno(mmdd) {
  if (!/^\d{2}-\d{2}$/.test(mmdd || "")) return null;
  const oggiIso = oggi(), anno = Number(oggiIso.slice(0, 4));
  let data = `${anno}-${mmdd}`;
  if (data < oggiIso) data = `${anno + 1}-${mmdd}`;
  return { data, giorni: Math.round((Date.parse(data + "T00:00Z") - Date.parse(oggiIso + "T00:00Z")) / 86400000) };
}

// Colore fisso per ogni persona (avatar)
const PALETTE = ["c-pink", "c-orange", "c-purple", "c-blue", "c-green", "c-gold"];
const coloreDi = (nome) => PALETTE[[...chiave(nome)].reduce((s, ch) => s + ch.charCodeAt(0), 0) % PALETTE.length];
const iniziali = (nome) => String(nome || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("") || "?";
const avatar = (nome, isIo) => `<div class="avatar ${isIo ? "c-pink" : coloreDi(nome)}">${isIo ? "🙋‍♀️" : esc(iniziali(nome))}</div>`;
const avatarRiga = (r) => r.clienteId === SCORTA ? `<div class="avatar c-orange">📦</div>` : avatar(nomeRiga(r), r.clienteId === IO);

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
  ascolta("ordini", d => ordini = completaCostiScorta(d.sort((a, b) => (b.data || "").localeCompare(a.data || ""))));
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
  programmaNotificheTraPoco();
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
const msgAuguri = (c) => `Tanti auguri ${primoNome(c)}! 🎂🎉 Ti auguro una giornata bellissima. Ho un piccolo pensiero per te da parte mia: quando ci vediamo? 😊`;
const msgRicontatto = (x) => x.tipo === "riacquisto"
  ? `Ciao ${primoNome(x.cliente)}! Come ti stai trovando con ${x.prodotti}? Dovrebbe essere quasi finito: vuoi che te lo riordini? Ci sono anche le nuove promozioni Yves Rocher 😊`
  : `Ciao ${primoNome(x.cliente)}! È uscito il nuovo catalogo Yves Rocher con tante promozioni. Ti mando qualche proposta? 😊`;

// ---------- Modifiche veloci con Annulla ----------
// cambia: (riga) => riga modificata (o la stessa). Si applica a tutte le righe che soddisfano "filtro".
const pulisciRighe = (righe) => (righe || []).map(r => r.articoli ? { ...r, articoli: r.articoli.map(({ _costo, ...a }) => a) } : r);
async function aggiornaRighe(filtro, cambia, messaggio) {
  const prima = [];
  const batch = writeBatch(db);
  for (const o of ordini) {
    if (!(o.righe || []).some(r => filtro(r, o))) continue;
    prima.push({ id: o.id, righe: pulisciRighe(o.righe) });
    batch.set(doc(col("ordini"), o.id), { righe: pulisciRighe(o.righe.map(r => filtro(r, o) ? cambia(r) : r)) }, { merge: true });
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
    if (!filtro(r, o)) continue;
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
  const consegne = gruppiPerCliente((r, o) => !r.consegnato && r.clienteId !== SCORTA && arrivato(o));
  const inArrivo = ordini.filter(o => !arrivato(o)).sort((a, b) => (a.data || "").localeCompare(b.data || ""));
  const compleanni = clienti.map(c => ({ c, p: prossimoCompleanno(c.compleanno) }))
    .filter(x => x.p && x.p.giorni <= 7 && x.c.auguriFatti !== x.p.data).sort((a, b) => a.p.giorni - b.p.giorni);
  const incassi = gruppiPerCliente(r => !isSpeciale(r.clienteId) && !r.pagato);
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

  if (!consegne.length && !incassi.length && !ric.length && !inArrivo.length && !compleanni.length) h += `<div class="empty"><div class="e-ico">🎉</div><b>Tutto in ordine!</b><br>Niente da consegnare, nessuno ti deve soldi.</div>`;

  if (compleanni.length) {
    h += `<div class="section"><h2>🎂 Compleanni</h2><span class="count c-pink">${compleanni.length}</span></div>`;
    for (const { c, p } of compleanni) {
      const quando = p.giorni === 0 ? "<b>Oggi!</b> 🎉" : p.giorni === 1 ? "Domani" : `Tra ${p.giorni} giorni · ${new Date(p.data + "T00:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}`;
      h += `<div class="card b-pink compleanno"><div class="who">${avatar(c.nome)}<div><h3>${esc(c.nome)}</h3><div class="sub">${quando}</div></div></div>
        <div class="actions"><button class="wa" data-auguri="${c.id}">💬 Fai gli auguri</button><button class="c-pink" data-auguri-fatti="${c.id}">✓ Fatti</button></div></div>`;
    }
  }

  if (inArrivo.length) {
    h += `<div class="section" id="sec-arrivo"><h2>🚚 In arrivo</h2><span class="count c-blue">${inArrivo.length}</span></div>
      <p class="section-hint">Ordini fatti a Yves Rocher non ancora arrivati. Quando arriva il pacco, tocca “È arrivato”.</p>`;
    for (const o of inArrivo) {
      const persone = [...new Set((o.righe || []).map(nomeRiga))].join(", ");
      const giorni = Math.round((Date.parse(oggi() + "T00:00Z") - Date.parse((o.data || oggi()) + "T00:00Z")) / 86400000);
      h += `<div class="card b-blue"><div class="row"><div><h3>Ordine del ${dataLunga(o.data)}</h3>
          <div class="sub">${esc(persone)}</div></div>${giorni > 0 ? `<span class="badge c-blue" style="margin:0">${plurale(giorni, "giorno", "giorni")}</span>` : ""}</div>
        <div class="actions"><button class="c-blue" data-arrivato="${o.id}">📬 È arrivato</button></div></div>`;
    }
  }

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
    const f = filtroGruppo(g, r => !r.consegnato);
    aggiornaRighe((r, o) => f(r) && arrivato(o), r => ({ ...r, consegnato: true }), `📦 ${g.nome}: consegnato`);
  }));
  $$("[data-arrivato]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.arrivato;
    await setDoc(doc(col("ordini"), id), { arrivato: true, arrivatoIl: oggi() }, { merge: true });
    avviso("📬 Arrivato! Ora lo trovi in “Da consegnare”", () => setDoc(doc(col("ordini"), id), { arrivato: false, arrivatoIl: null }, { merge: true }));
  }));
  $$("[data-auguri]").forEach(b => b.addEventListener("click", () => {
    const c = clienti.find(x => x.id === b.dataset.auguri);
    apriWhatsApp(c, msgAuguri(c));
  }));
  $$("[data-auguri-fatti]").forEach(b => b.addEventListener("click", async () => {
    const c = clienti.find(x => x.id === b.dataset.auguriFatti); const p = prossimoCompleanno(c.compleanno); const prima = c.auguriFatti || null;
    await setDoc(doc(col("clienti"), c.id), { auguriFatti: p.data }, { merge: true });
    avviso(`🎂 Auguri a ${primoNome(c)} fatti`, () => setDoc(doc(col("clienti"), c.id), { auguriFatti: prima }, { merge: true }));
  }));
  $$("[data-paga]").forEach(b => b.addEventListener("click", () => {
    const g = trova(incassi, b.dataset.paga);
    aggiornaRighe(filtroGruppo(g, r => !isSpeciale(r.clienteId) && !r.pagato), r => ({ ...r, pagato: true }), `💶 ${g.nome}: ${euro(somma(g.righe, r => r.importo))} incassati`);
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
      ${!arrivato(o) ? `<span class="badge c-blue">🚚 In arrivo</span>` : c.daConsegnare ? `<span class="badge c-orange">📦 ${c.daConsegnare} da consegnare</span>` : ""}
      ${c.daIncassare > 0 ? `<span class="badge c-pink">💶 ${euro(c.daIncassare)} da incassare</span>` : ""}
      ${!c.daConsegnare && c.daIncassare <= 0 ? `<span class="badge c-green">✓ Tutto fatto</span>` : ""}
      ${o.daScorta ? `<span class="badge c-orange">📦 Dalla scorta</span>` : ""}
      ${(() => { const x = omaggiOrdine(o); return x.nArrivati || x.nRegalati ? `<span class="badge c-gold">🎁 ${x.nArrivati ? `${x.nArrivati} arrivati` : ""}${x.nArrivati && x.nRegalati ? " · " : ""}${x.nRegalati ? `${x.nRegalati} regalati` : ""}</span>` : ""; })()}
      ${c.quotaScorta > 0 ? `<span class="badge c-orange">💰 ${euro(c.quotaScorta)} in scorta</span>` : ""}
      ${c.usatoScorta > 0 && !o.daScorta ? `<span class="badge c-orange">📦 ${c.tuttoDaScorta ? "Dalla scorta" : "In parte dalla scorta"}</span>` : ""}
      ${!o.costo && !c.tuttoDaScorta ? `<span class="badge c-gold">🧾 ${o.daScorta ? "Manca il costo" : "Manca quanto hai pagato"}</span>` : ""}
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
  const ord = o ? structuredClone(o) : { data: oggi(), costo: null, costoIoManuale: null, costoScortaManuale: null, daScorta: false, arrivato: false, omaggiRicevuti: [], omaggiNote: "", note: "", righe: [] };
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
  const qta = (a) => Math.max(1, Number(a.qta) || 1);
  const totaleRiga = (r) => Math.round((somma(r.articoli, a => (Number(a.prezzo) || 0) * qta(a)) - (Number(r.sconto) || 0)) * 100) / 100;
  const nomeArt = (a) => `${qta(a) > 1 ? qta(a) + "× " : ""}${a.nome}`;
  const rigaPronta = ({ _tipo, ...r }) => ({ ...r, importo: totaleRiga(r), prodotti: r.articoli.map(nomeArt).join(", "),
    articoli: r.articoli.map(({ _costo, ...a }) => a) });
  const segna = () => { modificato = true; };
  const manuale = (v) => v === "" || v == null ? null : numIt(v);
  const ordinePronto = () => ({ ...ord, righe: ord.righe.map(rigaPronta), costo: numIt(ord.costo),
    costoIoManuale: manuale(ord.costoIoManuale), costoScortaManuale: manuale(ord.costoScortaManuale) });

  // Giacenza omaggi tenendo conto delle modifiche non ancora salvate di quest'ordine
  const giacenzaAttuale = () => giacenzaOmaggi([...ordini.filter(x => x.id !== o?.id), { ...ord, id: o?.id || "nuovo" }], movimenti);

  // Elenco omaggi con − quantità + e suggerimenti da toccare
  function editorOmaggi(lista, pref, suggerimenti, segnaposto) {
    const presenti = new Set(lista.map(x => chiave(x.nome)));
    const sugg = suggerimenti.filter(x => !presenti.has(chiave(x.nome))).slice(0, 12);
    return `<div class="items">${lista.map((x, i) => `<div class="item gift-item"><div class="i-name">${esc(x.nome)}</div>
        <div class="stepper"><button data-${pref}-d="${i}" data-d="-1" aria-label="Uno in meno">−</button><b>${x.qta}</b>
        <button data-${pref}-d="${i}" data-d="1" aria-label="Uno in più">＋</button></div></div>`).join("")}</div>
      ${sugg.length ? `<div class="chips small-chips" style="margin-bottom:10px">${sugg.map(x =>
        `<button class="chip gift-chip" data-${pref}-s="${esc(x.nome)}">＋ ${esc(x.nome)}${x.giacenza !== undefined ? ` <span class="muted">· ne hai ${x.giacenza}</span>` : ""}</button>`).join("")}</div>` : ""}
      <div class="two" style="display:grid;grid-template-columns:1fr 110px;gap:8px"><input id="${pref}-nome" list="dl-omaggi" placeholder="${segnaposto}" autocomplete="off">
        <button class="c-gold" id="${pref}-add">＋ Aggiungi</button></div>`;
  }
  function collegaOmaggi(lista, pref, ridisegna) {
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

  function riquadroOmaggi() {
    const nomiNoti = giacenzaAttuale().map(v => ({ nome: v.nome }));
    const regalati = ord.righe.filter(r => r.omaggiDati?.length);
    return `<div class="yesno gift-box"><div class="yn-q">🎁 Omaggi di quest'ordine</div>
      <div class="gift-sub">📥 Arrivati da Yves Rocher con l'ordine</div>
      ${ord.omaggiNote ? `<div class="hint" style="margin:0 0 8px">📝 Dal vecchio file: ${esc(ord.omaggiNote)}</div>` : ""}
      ${editorOmaggi(ord.omaggiRicevuti, "or", nomiNoti, "Es. campioncini crema")}
      <div class="gift-sub" style="margin-top:16px">🤝 Regalati alle clienti</div>
      ${regalati.length ? regalati.map(r => `<div class="regalo-riga"><b>${esc(nomeRiga(r))}</b>: ${esc(r.omaggiDati.map(x => `${x.qta > 1 ? x.qta + "× " : ""}${x.nome}`).join(", "))}</div>`).join("")
        : `<div class="hint" style="margin:0">Nessuno. Si aggiungono toccando una cliente, all'ultimo passaggio.</div>`}
    </div>`;
  }

  function sezioneCosto(c) {
    if (ord.daScorta) // ordini della versione 8
      return `<div class="yesno" style="margin-top:20px"><div class="yn-q">📦 Quanto ti erano costati questi prodotti presi dalla scorta?</div>
        <input id="costo" class="money" inputmode="decimal" placeholder="0,00 €" value="${esc(inIt(ord.costo))}"></div>`;
    if (c.tuttoDaScorta)
      return `<div class="yesno" style="margin-top:20px"><div class="yn-q">📦 Tutto preso dalla tua scorta</div>
        <div class="hint" style="margin:0">Non hai pagato niente a Yves Rocher: il costo dei prodotti lo calcolo io da quanto avevi pagato bundle e calendari.</div></div>`;
    return `<div class="yesno" style="margin-top:20px"><div class="yn-q">🧾 Quanto hai pagato a Yves Rocher?</div>
        <input id="costo" class="money" inputmode="decimal" placeholder="0,00 €" value="${esc(inIt(ord.costo))}">
        <div class="hint">${c.valoreDaScorta > 0 ? "Solo per i prodotti ordinati adesso: quelli presi dalla scorta li conto io." : "Il totale dell'ordine che hai fatto all'azienda. Puoi metterlo anche dopo."}</div></div>`;
  }

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
    for (const oo of ordini) for (const rr of oo.righe || []) if (rr.clienteId && !isSpeciale(rr.clienteId) && rr.clienteId !== STORICO && !recenti.has(rr.clienteId)) recenti.set(rr.clienteId, true);
    const ordinate = [...clienti].sort((a, b) => (recenti.has(b.id) - recenti.has(a.id)) || a.nome.localeCompare(b.nome, "it"));
    const filtrate = ordinate.filter(c => !cercaChi || chiave(c.nome).includes(chiave(cercaChi))).slice(0, 40);
    $("#sheet-body").innerHTML = testataSheet(o ? "Ordine" : "Nuovo ordine", !nuovaRiga || ord.righe.length > 1, 1) + `
      <div class="sh-main">
        <div class="question">Per chi è?</div>
        <p class="q-hint">Tocca il nome della cliente. Usa “📦 Da rivendere” per i bundle che compri per rivenderli.</p>
        ${clienti.length > 8 ? `<input id="chi-cerca" class="search" placeholder="🔍 Cerca per nome" value="${esc(cercaChi)}">` : ""}
        <div class="chips">
          ${r.clienteId === STORICO ? `<button class="chip sel" data-chi="${STORICO}">${esc(r.clientiStorico)}</button>` : ""}
          <button class="chip me ${r.clienteId === IO ? "sel" : ""}" data-chi="${IO}">🙋‍♀️ Per me</button>
          ${ord.daScorta ? "" : `<button class="chip scorta ${r.clienteId === SCORTA ? "sel" : ""}" data-chi="${SCORTA}">📦 Da rivendere</button>`}
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
  let inAttesaScorta = null;   // prodotto della scorta scelto ma non ancora aggiunto
  function passoCosa(r) {
    const isIo = r.clienteId === IO, isScorta = r.clienteId === SCORTA;
    if (isScorta && !r._tipo) r._tipo = r.articoli.some(a => a.confezione) ? "confezione" : "pezzi";
    const isConf = isScorta && r._tipo === "confezione";
    const inAttesaConf = !!inAttesaScorta?.confezione;
    const inv = isScorta ? [] : inventarioScorta([...ordini.filter(x => x.id !== o?.id), { ...ordinePronto(), id: o?.id || "nuovo" }]).filter(v => v.rimasti > 0);
    $("#sheet-body").innerHTML = testataSheet(nomeRiga(r), true, isScorta ? 0 : 2) + `
      <div class="sh-main">
        <div class="question">${isIo ? "Cosa hai preso per te?" : isScorta ? "Cosa hai comprato da rivendere?" : `Cosa ha preso ${esc(primoNome({ nome: nomeRiga(r) }))}?`}</div>
        ${!nuovaRiga ? `<button class="pill c-blue" id="cambia-chi" style="margin:0 0 10px">👤 ${esc(nomeRiga(r))} · Cambia</button>` : ""}
        ${isScorta ? `<div class="segmented" style="margin:4px 0 12px"><button data-tipo="pezzi" class="${!isConf ? "on" : ""}">📦 Prodotti uguali</button>
          <button data-tipo="confezione" class="${isConf ? "on" : ""}">🎄 Calendario o cofanetto</button></div>` : ""}
        <p class="q-hint">${isConf ? "Scrivi il nome e quanto valgono a catalogo i prodotti dentro (di solito è scritto sul catalogo o sulla scatola). Poi venderai i prodotti uno per uno." :
          isScorta ? "Scrivi i prodotti del bundle, il prezzo di catalogo e quanti pezzi. Non sono spese: li ritrovi nella scorta quando li vendi." : "Scrivi un prodotto alla volta con il suo prezzo."}</p>
        <div class="items">${r.articoli.map((a, i) => `<div class="item"><div class="i-name">${a.confezione ? "🎄 " : ""}${a.fonte === "scorta" ? `<span class="tag-scorta">${a.da ? `🎄 ${esc(a.da)}` : "📦 scorta"}</span> ` : ""}${esc(nomeArt(a))}${a.confezione ? ` <span class="muted" style="font-size:14px">(valore prodotti)</span>` : ""}</div>
            <b class="num">${euro((Number(a.prezzo) || 0) * qta(a))}</b><button class="x" data-xart="${i}" aria-label="Togli">×</button></div>`).join("")}</div>
        ${inv.length ? `<div class="scorta-box"><div class="gift-sub" style="margin-top:0">📦 Dalla tua scorta</div>
          <div class="chips small-chips">${inv.map(v => v.tipo === "confezione"
            ? `<button class="chip scorta ${inAttesaScorta?.confezione && chiave(inAttesaScorta.confezione) === chiave(v.nome) ? "sel" : ""}" data-conf="${esc(v.nome)}">🎄 ${esc(v.nome)} <span class="muted">· ancora ${euro(v.valoreResiduo)}</span></button>`
            : `<button class="chip scorta ${inAttesaScorta && !inAttesaScorta.confezione && chiave(inAttesaScorta.nome) === chiave(v.nome) ? "sel" : ""}" data-scorta="${esc(v.nome)}">${esc(v.nome)} <span class="muted">· ${v.rimasti} ${v.rimasti === 1 ? "rimasto" : "rimasti"}</span></button>`).join("")}</div></div>` : ""}
        <div class="add-box">
          ${inAttesaScorta ? `<div class="tag-scorta big-tag">${inAttesaConf ? `🎄 Dal ${esc(inAttesaScorta.confezione)}` : "📦 Preso dalla scorta"} <button class="x-mini" id="annulla-scorta" aria-label="Non dalla scorta">×</button></div>` : ""}
          <input id="art-nome" list="dl-prodotti" placeholder="${inAttesaConf ? "Quale prodotto? Es. siero" : isConf ? "Es. Calendario dell'avvento" : "Nome del prodotto"}" autocomplete="off" value="${esc(inAttesaConf ? "" : inAttesaScorta?.nome || "")}">
          <div class="two"><input id="art-prezzo" inputmode="decimal" placeholder="${isConf ? "Valore prodotti €" : isScorta ? "Prezzo a pezzo €" : "Prezzo €"}" autocomplete="off" value="${esc(inAttesaScorta && !inAttesaConf ? inIt(inAttesaScorta.prezzo) : "")}">
            ${isScorta ? `<input id="art-qta" inputmode="numeric" placeholder="Pezzi" value="1" aria-label="Quanti pezzi">` : `<button class="c-blue" id="art-add">＋ Aggiungi</button>`}</div>
          ${isScorta ? `<button class="c-blue" id="art-add">＋ Aggiungi</button>` : ""}
          ${inAttesaScorta ? `<div class="hint" style="margin:0">${inAttesaConf ? "Scrivi il prodotto e il prezzo a cui lo vendi: il costo lo calcolo io." : "Scrivi il prezzo a cui lo vendi."}</div>` : ""}
        </div>
        <div class="total-line"><span>Totale</span><b class="num">${euro(totaleRiga(r))}</b></div>
        <details class="more" ${r.sconto ? "open" : ""}><summary>Hai fatto uno sconto?</summary>
          <label>Sconto in euro</label><input id="art-sconto" inputmode="decimal" placeholder="0" value="${esc(inIt(r.sconto || ""))}">
        </details>
        ${!nuovaRiga ? `<button class="danger" id="rimuovi-cosa" style="width:100%;margin-top:14px">Togli dall'ordine</button>` : ""}
      </div>
      <div class="sh-foot"><button class="big primary" id="avanti">${isScorta ? "✓ Fatto" : "Avanti →"}</button></div>`;
    const ridisegna = () => { passoCosa(r); $("#sh-back").addEventListener("click", indietro); };
    const nomeIn = $("#art-nome"), prezzoIn = $("#art-prezzo");
    const suggerisciPrezzo = () => { const p = catalogo.find(x => chiave(x.nome) === chiave(nomeIn.value)); if (p?.prezzo && !prezzoIn.value) prezzoIn.value = inIt(p.prezzo); };
    nomeIn.addEventListener("change", suggerisciPrezzo);
    nomeIn.addEventListener("input", () => {
      if (inAttesaScorta && !inAttesaScorta.confezione && chiave(nomeIn.value) !== chiave(inAttesaScorta.nome)) { inAttesaScorta = null; $(".big-tag")?.remove(); }
      suggerisciPrezzo();
    });
    const aggiungi = () => {
      const nome = nomeIn.value.trim();
      if (!nome) { nomeIn.focus(); return false; }
      const prezzo = numIt(prezzoIn.value);
      const pezzi = isScorta ? Math.max(1, parseInt($("#art-qta").value) || 1) : 1;
      const art = { nome, prezzo, qta: pezzi };
      if (isConf) art.confezione = true;
      if (inAttesaScorta?.confezione) {
        art.fonte = "scorta"; art.da = inAttesaScorta.confezione; art.costo = costoDaConfezione(inv, inAttesaScorta.confezione, prezzo);
        if (art.costo === null) avviso("Ricordati di scrivere quanto hai pagato la confezione: il guadagno si aggiorna da solo");
      } else if (inAttesaScorta) {
        const v = inv.find(x => chiave(x.nome) === chiave(inAttesaScorta.nome));
        art.fonte = "scorta"; art.costo = v && v.costoNoto ? v.costoPezzo : null;
        if (v && !v.costoNoto) avviso("Ricordati di scrivere quanto hai pagato il bundle: il guadagno si aggiorna da solo");
      } else if (prezzo && !isConf) nuoviPrezzi.push({ nome, prezzo });
      const uguale = r.articoli.find(x => chiave(x.nome) === chiave(art.nome) && (x.fonte || "") === (art.fonte || "") && (x.da || "") === (art.da || "") && !!x.confezione === !!art.confezione && Number(x.prezzo) === art.prezzo && x.costo === art.costo);
      if (uguale) uguale.qta = qta(uguale) + art.qta; else r.articoli.push(art);
      inAttesaScorta = null; segna();
      return true;
    };
    $("#art-add").addEventListener("click", () => { if (aggiungi()) { ridisegna(); $("#art-nome").focus(); } });
    prezzoIn.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#art-add").click(); });
    nomeIn.addEventListener("keydown", (e) => { if (e.key === "Enter") prezzoIn.focus(); });
    $$("[data-scorta]").forEach(b => b.addEventListener("click", () => {
      const v = inv.find(x => chiave(x.nome) === chiave(b.dataset.scorta));
      inAttesaScorta = { nome: v.nome, prezzo: v.prezzo }; ridisegna(); $("#art-prezzo").focus(); $("#art-prezzo").select();
    }));
    $("#annulla-scorta")?.addEventListener("click", () => { inAttesaScorta = null; ridisegna(); });
    $$("[data-conf]").forEach(b => b.addEventListener("click", () => { inAttesaScorta = { confezione: b.dataset.conf }; ridisegna(); $("#art-nome").focus(); }));
    $$("[data-tipo]").forEach(b => b.addEventListener("click", () => { r._tipo = b.dataset.tipo; ridisegna(); }));
    $$("[data-xart]").forEach(b => b.addEventListener("click", () => { r.articoli.splice(+b.dataset.xart, 1); segna(); ridisegna(); }));
    $("#art-sconto").addEventListener("input", (e) => { r.sconto = numIt(e.target.value); segna(); $(".total-line b").textContent = euro(totaleRiga(r)); });
    $("#avanti").addEventListener("click", () => {
      if (nomeIn.value.trim()) aggiungi();   // prodotto scritto ma non aggiunto: lo aggiungo io
      if (!r.articoli.length) { nomeIn.focus(); avviso("Aggiungi almeno un prodotto"); return; }
      if (isScorta) { r.pagato = true; r.consegnato = true; nuovaRiga = false; passo = "panoramica"; }
      else passo = "stato";
      disegna();
    });
    $("#rimuovi-cosa")?.addEventListener("click", rimuoviRiga);
    $("#cambia-chi")?.addEventListener("click", () => { cercaChi = ""; passo = "chi"; disegna(); });
  }

  function rimuoviRiga() {
    if (!confirm("Togliere dall'ordine?")) return;
    ord.righe.splice(idx, 1); segna(); nuovaRiga = false;
    if (!ord.righe.length && !o) return chiudiSheet(true);
    if (!ord.righe.length) { ord.righe.push(rigaVuota()); idx = 0; nuovaRiga = true; passo = "chi"; return disegna(); }
    passo = "panoramica"; disegna();
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
        ${isIo ? "" : `<div class="yesno"><div class="yn-q">🎁 Le hai regalato qualcosa?</div>
          <div class="hint" style="margin:-4px 0 10px">Tocca un omaggio che hai: si scala da solo dal totale.</div>
          ${editorOmaggi(r.omaggiDati, "od", giacenzaAttuale().filter(v => v.giacenza > 0).map(v => ({ nome: v.nome, giacenza: v.giacenza })), "Altro omaggio")}</div>
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
    if (!isIo) collegaOmaggi(r.omaggiDati, "od", ridisegna);
    $("#rimuovi").addEventListener("click", rimuoviRiga);
    $("#fatto").addEventListener("click", () => { nuovaRiga = false; passo = "panoramica"; disegna(); });
  }

  // Riepilogo dell'ordine
  function passoPanoramica() {
    const pronte = ord.righe.map(rigaPronta);
    const c = calcolaOrdine(ordinePronto());
    const haCosto = numIt(ord.costo) > 0 || c.tuttoDaScorta;
    $("#sheet-body").innerHTML = testataSheet(o ? `Ordine del ${dataLunga(ord.data)}` : "Nuovo ordine", false) + `
      <div class="sh-main">
        <div class="question">${plurale(pronte.length, "persona", "persone")} in quest'ordine</div>
        <p class="q-hint">Tocca una scheda per cambiarla.</p>
        ${pronte.map((r, i) => `<div class="card tap ${r.clienteId === IO ? "b-pink" : r.clienteId === SCORTA ? "b-orange" : "b-blue"}" data-riga="${i}">
          <div class="row"><div class="who">${avatarRiga(r)}<div><h3>${esc(nomeRiga(r))}</h3>
            <div class="sub">${esc(r.prodotti)}</div></div></div><div class="amount num">${euro(r.importo)}</div></div>
          ${r.clienteId === SCORTA ? `<span class="badge c-orange">💰 soldi anticipati, non spese</span>` : `
          ${r.clienteId === IO ? "" : `<span class="badge ${r.pagato ? "c-green" : "c-pink"}">${r.pagato ? "✓ Pagato" : "💶 Da pagare"}</span>`}
          <span class="badge ${r.consegnato ? "c-green" : "c-orange"}">${r.consegnato ? "✓ Consegnato" : "📦 Da consegnare"}</span>`}
          ${r.omaggiDati?.length ? `<span class="badge c-gold">🎁 ${r.omaggiDati.reduce((s, x) => s + x.qta, 0)}</span>` : ""}
        </div>`).join("")}
        <button class="big c-blue" id="add-cliente">＋ Aggiungi un'altra persona</button>

        ${c.tuttoDaScorta ? "" : `<div class="yesno" style="margin-top:20px"><div class="yn-q">📬 Il pacco di Yves Rocher è arrivato?</div><div class="yn-b">
          <button data-arr="1" class="${arrivato(ord) ? "on-yes" : ""}">👍 Sì, ce l'ho</button>
          <button data-arr="0" class="${!arrivato(ord) ? "on-no" : ""}">🚚 Non ancora</button></div>
          <div class="hint">Finché non arriva, le clienti non compaiono in “Da consegnare”.</div></div>`}
        ${sezioneCosto(c)}

        <div class="result ${haCosto ? (c.guadagnoAtteso >= 0 ? "c-green" : "c-pink") : "c-gold"}" id="risultato">${risultatoHtml(c, haCosto, ord.daScorta)}</div>

        ${riquadroOmaggi()}

        <details class="more"><summary>⚙️ Altro (data, note…)</summary>
          <label>Data dell'ordine</label><input type="date" id="data" value="${esc(ord.data)}">
          ${c.valoreIo > 0 ? `<label>Quanto hai pagato davvero i tuoi prodotti? (facoltativo)</label>
            <input id="costoio" inputmode="decimal" placeholder="${inIt(c.quotaIo.toFixed(2))} (calcolato da solo)" value="${esc(inIt(ord.costoIoManuale))}">
            <div class="hint">Lascia vuoto e l'app lo calcola in proporzione.</div>` : ""}
          ${c.valoreScorta > 0 ? `<label>Quanto hai pagato davvero i prodotti da rivendere? (facoltativo)</label>
            <input id="costoscorta" inputmode="decimal" placeholder="${inIt(c.quotaScorta.toFixed(2))} (calcolato da solo)" value="${esc(inIt(ord.costoScortaManuale))}">
            <div class="hint">Utile se il bundle aveva uno sconto speciale.</div>` : ""}
          <label>Note</label><textarea id="note">${esc(ord.note)}</textarea>
          ${o ? `<button class="danger" id="elimina" style="width:100%;margin-top:12px">🗑 Elimina questo ordine</button>` : ""}
        </details>
      </div>
      <div class="sh-foot"><button class="big primary" id="salva">✓ Salva ordine</button></div>`;

    const aggiornaRisultato = () => {
      const cc = calcolaOrdine(ordinePronto());
      const hc = numIt(ord.costo) > 0 || cc.tuttoDaScorta;
      const box = $("#risultato");
      box.className = "result " + (hc ? (cc.guadagnoAtteso >= 0 ? "c-green" : "c-pink") : "c-gold");
      box.innerHTML = risultatoHtml(cc, hc, ord.daScorta);
    };
    $$("[data-riga]").forEach(el => el.addEventListener("click", () => { idx = +el.dataset.riga; passo = "cosa"; disegna(); }));
    $("#add-cliente").addEventListener("click", () => { ord.righe.push(rigaVuota()); idx = ord.righe.length - 1; nuovaRiga = true; cercaChi = ""; passo = "chi"; disegna(); });
    $("#costo")?.addEventListener("input", (e) => { ord.costo = e.target.value; segna(); aggiornaRisultato(); });
    $("#costoio")?.addEventListener("input", (e) => { ord.costoIoManuale = e.target.value; segna(); aggiornaRisultato(); });
    $$("[data-arr]").forEach(b => b.addEventListener("click", () => {
      ord.arrivato = b.dataset.arr === "1"; segna();
      $$("[data-arr]").forEach(x => { x.className = ""; });
      b.className = ord.arrivato ? "on-yes" : "on-no";
    }));
    $("#costoscorta")?.addEventListener("input", (e) => { ord.costoScortaManuale = e.target.value; segna(); aggiornaRisultato(); });
    $("#data").addEventListener("change", (e) => { ord.data = e.target.value; segna(); });
    $("#note").addEventListener("input", (e) => { ord.note = e.target.value; segna(); });
    collegaOmaggi(ord.omaggiRicevuti, "or", () => {
      const y = $(".sh-main").scrollTop; passoPanoramica(); $("#sh-back").addEventListener("click", indietro); $(".sh-main").scrollTop = y;
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
      return { ...p, pagato: isSpeciale(p.clienteId) ? true : !!p.pagato, consegnato: p.clienteId === SCORTA ? true : !!p.consegnato, riacquistoGiorni: p.riacquistoGiorni || null };
    });
    if (!righe.length) return avviso("Aggiungi almeno una persona con dei prodotti");
    const { id, ...resto } = ord;
    const dati = { ...resto, righe, costo: numIt(ord.costo),
      costoIoManuale: manuale(ord.costoIoManuale), costoScortaManuale: manuale(ord.costoScortaManuale), daScorta: !!ord.daScorta,
      arrivato: calcolaOrdine(ordinePronto()).tuttoDaScorta ? true : arrivato(ord), aggiornato: serverTimestamp() };
    $("#salva").disabled = true;
    if (o) await setDoc(doc(col("ordini"), o.id), dati); else await addDoc(col("ordini"), dati);
    for (const p of nuoviPrezzi) setDoc(doc(col("catalogo"), slug(p.nome)), { nome: p.nome, prezzo: p.prezzo, ultimoUso: oggi() }, { merge: true });
    chiudiSheet(true);
    avviso(o ? "✓ Ordine aggiornato" : "✓ Ordine salvato");
  }

  disegna();
}

const rigaVuota = () => ({ id: nuovoId(), clienteId: "", articoli: [], sconto: 0, omaggiDati: [], pagato: false, consegnato: false, riacquistoGiorni: null });

function risultatoHtml(c, haCosto, daScorta) {
  if (!haCosto) return `<div class="r-lbl">🌿 Il tuo guadagno</div><div class="r-sub" style="margin-top:6px">${daScorta ? "Scrivi quanto ti erano costati i prodotti" : "Scrivi quanto hai pagato a Yves Rocher"} e lo calcolo io.</div>`;
  if (c.venditaClienti === 0 && c.valoreIo === 0 && c.quotaScorta > 0) return `<div class="r-lbl">📦 Soldi messi in scorta</div><div class="r-val num">${euro(c.quotaScorta)}</div>
    <div class="r-sub">Non sono spese: li recuperi quando rivendi questi prodotti.</div>`;
  return `<div class="r-lbl">🌿 Ti resta in tasca</div><div class="r-val num">${euro(c.guadagnoAtteso)}</div>
    <div class="r-sub">Venduto ${euro(c.venditaClienti)} · costo ${euro(c.costoClienti)}${daScorta || c.usatoScorta > 0 ? ` (di cui ${euro(c.usatoScorta)} dalla scorta)` : ""}${c.valoreIo > 0 ? ` · per te ${euro(c.quotaIo)}` : ""}${c.quotaScorta > 0 ? ` · in scorta ${euro(c.quotaScorta)}` : ""}</div>
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
  const camp = impostazioni.campagna;
  let h = `<button class="tile c-purple campagna-btn" id="apri-campagna"><div class="row"><div>
      <div class="t-lbl" style="font-size:17px">📣 Scrivi a tutte le clienti</div>
      <div style="font-size:14px;font-weight:500;opacity:.85">${camp ? `Messaggio in corso: inviato a ${(camp.inviati || []).length}` : "Nuovo catalogo, promozioni, ordine in partenza"}</div></div>
      <span style="font-size:24px">›</span></div></button>
    <input type="search" id="cerca" class="search" placeholder="🔍 Cerca una cliente" value="${esc(cercaClienti)}">`;
  const filtrate = clienti.filter(c => !cercaClienti || chiave(c.nome).includes(chiave(cercaClienti)));
  for (const c of filtrate) {
    const acq = acquistiCliente(c);
    const deve = somma(acq.filter(x => x.r.clienteId === c.id && !x.r.pagato), x => x.r.importo);
    const ultimo = acq.map(x => x.o.data).filter(Boolean).sort().pop();
    h += `<div class="card tap" data-cli="${c.id}"><div class="row"><div class="who">${avatar(c.nome)}<div><h3>${esc(c.nome)}</h3>
      <div class="sub">${ultimo ? `Ultimo acquisto: ${dataLunga(ultimo)}` : "Nessun acquisto"}${c.compleanno ? ` · 🎂 ${compleannoTesto(c.compleanno)}` : ""}</div></div></div>
      ${deve ? `<span class="badge c-pink num" style="margin:0">deve ${euro(deve)}</span>` : ""}</div></div>`;
  }
  if (!filtrate.length) h += `<div class="empty">Nessuna cliente con questo nome.</div>`;
  $("#view").innerHTML = h;
  $("#cerca").addEventListener("input", (e) => {
    cercaClienti = e.target.value; const pos = e.target.selectionStart;
    renderClienti(); const i = $("#cerca"); i.focus(); i.setSelectionRange(pos, pos);
  });
  $$("[data-cli]").forEach(el => el.addEventListener("click", () => apriCliente(clienti.find(c => c.id === el.dataset.cli))));
  $("#apri-campagna").addEventListener("click", () => apriCampagna());
}

// ---------- Messaggio a tutte le clienti ----------
const MODELLI = [
  ["📖 Nuovo catalogo", "Ciao {nome}! 🌿 È uscito il nuovo catalogo Yves Rocher, con tante novità e promozioni. Vuoi che te lo mandi o che ti consigli qualcosa? 😊"],
  ["🏷️ Promozioni", "Ciao {nome}! In questi giorni Yves Rocher ha delle promozioni speciali 🎉 Se ti serve qualcosa dimmelo e te lo ordino! 😊"],
  ["📦 Sto per ordinare", "Ciao {nome}! Nei prossimi giorni faccio l'ordine Yves Rocher: se ti serve qualcosa scrivimi pure 😊"],
  ["✍️ Scrivo io", "Ciao {nome}! "]
];
function apriCampagna(nuova) {
  let camp = !nuova && impostazioni.campagna ? structuredClone(impostazioni.campagna) : null;
  let bozza = camp?.testo || MODELLI[0][1];
  let solo6mesi = camp?.solo6mesi || false;
  sheetChiudi = null;
  const salvaCamp = (dati) => setDoc(docImpostazioni(), { campagna: dati }, { merge: true });

  const destinatarie = () => {
    const limite = new Date(Date.parse(oggi() + "T00:00Z") - 183 * 86400000).toISOString().slice(0, 10);
    return clienti.filter(c => !solo6mesi || acquistiCliente(c).some(x => (x.o.data || "") >= limite));
  };

  function schermataTesto() {
    $("#sheet-body").innerHTML = testataSheet("Scrivi a tutte", false) + `
      <div class="sh-main">
        <div class="question">Cosa vuoi scrivere?</div>
        <p class="q-hint">Scegli un messaggio pronto e modificalo come vuoi. Dove c'è <b>{nome}</b> metto il nome di ogni cliente.</p>
        <div class="chips small-chips" style="margin-bottom:12px">${MODELLI.map(([t], i) => `<button class="chip" data-modello="${i}">${t}</button>`).join("")}</div>
        <textarea id="camp-testo" style="min-height:150px">${esc(bozza)}</textarea>
        <div class="yesno" style="margin-top:14px"><div class="yn-q">A chi?</div><div class="chips">
          <button class="chip ${!solo6mesi ? "sel" : ""}" data-chi6="0">Tutte</button>
          <button class="chip ${solo6mesi ? "sel" : ""}" data-chi6="1">Chi ha comprato negli ultimi 6 mesi</button></div></div>
      </div>
      <div class="sh-foot"><button class="big primary" id="camp-avanti">Avanti →</button></div>`;
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $$("[data-modello]").forEach(b => b.addEventListener("click", () => { bozza = MODELLI[+b.dataset.modello][1]; $("#camp-testo").value = bozza; }));
    $("#camp-testo").addEventListener("input", (e) => { bozza = e.target.value; });
    $$("[data-chi6]").forEach(b => b.addEventListener("click", () => { solo6mesi = b.dataset.chi6 === "1"; schermataTesto(); }));
    $("#camp-avanti").addEventListener("click", async () => {
      if (!bozza.trim()) return $("#camp-testo").focus();
      const inviati = camp && camp.testo === bozza ? camp.inviati || [] : [];
      camp = { testo: bozza, solo6mesi, creata: camp?.creata || oggi(), inviati };
      await salvaCamp(camp);
      schermataInvio();
    });
  }

  function schermataInvio() {
    const lista = destinatarie();
    const conNumero = lista.filter(c => c.telefono), senza = lista.filter(c => !c.telefono);
    const fatti = conNumero.filter(c => camp.inviati.includes(c.id)).length;
    const anteprima = camp.testo.replaceAll("{nome}", primoNome(conNumero[0] || { nome: "Giulia" }));
    $("#sheet-body").innerHTML = testataSheet("Scrivi a tutte", false) + `
      <div class="sh-main">
        <div class="question">Inviato a ${fatti} di ${conNumero.length}</div>
        <div class="progress"><span style="width:${conNumero.length ? Math.round(fatti / conNumero.length * 100) : 0}%"></span></div>
        <p class="q-hint" style="margin-top:12px">Tocca “Invia”: si apre WhatsApp con il messaggio pronto. Premi invia lì e torna qui per la prossima.</p>
        <div class="card" style="background:var(--wa-soft);color:var(--text);font-size:15px">💬 ${esc(anteprima)}</div>
        ${conNumero.map(c => { const ok = camp.inviati.includes(c.id); return `<div class="item invio ${ok ? "ok" : ""}">
          ${avatar(c.nome)}<div class="i-name"><b>${esc(c.nome)}</b></div>
          <button class="${ok ? "c-green" : "wa"} pill" data-invia="${c.id}">${ok ? "✓ Inviato" : "💬 Invia"}</button></div>`; }).join("")}
        ${senza.length ? `<div class="section"><h2>📵 Senza numero</h2><span class="count c-gold">${senza.length}</span></div>
          <p class="section-hint">Aggiungi il cellulare dalla scheda cliente per poterle scrivere.</p>
          <div class="chips small-chips">${senza.map(c => `<span class="chip" style="box-shadow:none;opacity:.75">${esc(c.nome)}</span>`).join("")}</div>` : ""}
        <div class="stack" style="margin-top:20px">
          <button id="camp-modifica">✏️ Cambia il messaggio</button>
          <button id="camp-fine" class="danger" style="text-align:center">✓ Ho finito, chiudi questo messaggio</button>
        </div>
      </div>`;
    $("#sh-back").addEventListener("click", () => chiudiSheet());
    $$("[data-invia]").forEach(b => b.addEventListener("click", async () => {
      const c = clienti.find(x => x.id === b.dataset.invia);
      window.open(linkWhatsApp(c.telefono, camp.testo.replaceAll("{nome}", primoNome(c))), "_blank");
      if (!camp.inviati.includes(c.id)) { camp.inviati = [...camp.inviati, c.id]; await salvaCamp(camp); }
      const y = $(".sh-main").scrollTop; schermataInvio(); $(".sh-main").scrollTop = y;
    }));
    $("#camp-modifica").addEventListener("click", () => { bozza = camp.testo; schermataTesto(); });
    $("#camp-fine").addEventListener("click", async () => {
      const prima = camp;
      await setDoc(docImpostazioni(), { campagna: null }, { merge: true });
      chiudiSheet(true);
      avviso("📣 Messaggio chiuso", () => setDoc(docImpostazioni(), { campagna: prima }, { merge: true }));
    });
  }

  if (camp) schermataInvio(); else schermataTesto();
  apriSheet();
}

function apriCliente(c) {
  const acq = c ? acquistiCliente(c).sort((a, b) => (b.o.data || "").localeCompare(a.o.data || "")) : [];
  const proprie = acq.filter(x => x.r.clienteId === c?.id);
  const speso = somma(proprie, x => x.r.importo);
  const daPagare = proprie.filter(x => !x.r.pagato).map(x => x.r);
  const daConsegnare = proprie.filter(x => !x.r.consegnato && arrivato(x.o)).map(x => x.r);
  const [cm, cg] = (c?.compleanno || "-").split("-");
  sheetChiudi = null;
  $("#sheet-body").innerHTML = testataSheet(c ? "Cliente" : "Nuova cliente", false) + `
    <div class="sh-main">
      ${c ? `<div style="text-align:center;margin:6px 0 16px">
          <div class="avatar ${coloreDi(c.nome)}" style="width:76px;height:76px;font-size:30px;margin:0 auto">${esc(iniziali(c.nome))}</div>
          <div class="question" style="margin-top:8px">${esc(c.nome)}</div>
          ${c.compleanno ? `<div class="muted">🎂 ${compleannoTesto(c.compleanno)}</div>` : ""}</div>
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
        <label>🎂 Compleanno (facoltativo)</label>
        <div class="grid-compleanno"><select id="c-giorno"><option value="">Giorno</option>${Array.from({ length: 31 }, (_, i) => { const v = String(i + 1).padStart(2, "0"); return `<option value="${v}" ${cg === v ? "selected" : ""}>${i + 1}</option>`; }).join("")}</select>
          <select id="c-mese"><option value="">Mese</option>${MESI.map((nm, i) => { const v = String(i + 1).padStart(2, "0"); return `<option value="${v}" ${cm === v ? "selected" : ""}>${nm}</option>`; }).join("")}</select></div>
        <label>Note (tipo di pelle, gusti…)</label><textarea id="c-note">${esc(c?.note)}</textarea>
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
    const g = $("#c-giorno").value, m = $("#c-mese").value;
    if ((g && !m) || (!g && m)) { avviso("Per il compleanno scegli sia il giorno sia il mese"); return; }
    const dati = { nome, telefono: $("#c-tel").value.trim(), note: $("#c-note").value, compleanno: g && m ? `${m}-${g}` : null };
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
  const restano = g.reduce((s, v) => s + Math.max(0, v.giacenza), 0);
  const arrivati = g.reduce((s, v) => s + v.ricevuti + Math.max(0, v.rettifiche), 0);
  const regalati = g.reduce((s, v) => s + v.dati + Math.max(0, -v.rettifiche), 0);
  const nomiOrdine = (o) => [...new Set((o.righe || []).filter(r => r.clienteId !== SCORTA).map(nomeRiga))].join(", ");
  const listaOm = (arr) => arr.map(x => `<span class="gift-pill">${x.qta > 1 ? `<b>${x.qta}×</b> ` : ""}${esc(x.nome)}</span>`).join("");

  const daConvertire = ordini.filter(o => o.omaggiNote && !(o.omaggiRicevuti || []).length && parseOmaggi(o.omaggiNote).length);
  let h = daConvertire.length ? `<div class="card b-gold" style="background:var(--gold-soft)">
      <h3>📝 Omaggi del vecchio file</h3>
      <div class="sub" style="color:var(--text)">In ${plurale(daConvertire.length, "ordine", "ordini")} gli omaggi sono solo scritti come testo e non vengono contati.</div>
      <div class="actions"><button class="primary" id="converti-omaggi">✨ Trasformali in omaggi veri</button></div></div>` : "";
  h += `<div class="tiles tiles3">
      <div class="tile c-gold"><div class="t-ico">🎁</div><div class="t-val">${restano}</div><div class="t-lbl">ti restano</div></div>
      <div class="tile c-green"><div class="t-ico">📥</div><div class="t-val">${arrivati}</div><div class="t-lbl">arrivati</div></div>
      <div class="tile c-pink"><div class="t-ico">🤝</div><div class="t-val">${regalati}</div><div class="t-lbl">regalati</div></div>
    </div>
    <div class="segmented"><button data-vo="ordini" class="${vistaOmaggi === "ordini" ? "on" : ""}">🛍️ Per ordine</button>
      <button data-vo="omaggi" class="${vistaOmaggi === "omaggi" ? "on" : ""}">🎁 Per omaggio</button></div>`;

  if (vistaOmaggi === "ordini") {
    const conOmaggi = ordini.filter(o => { const x = omaggiOrdine(o); return x.nArrivati || x.nRegalati || o.omaggiNote || (o.righe || []).some(r => r.omaggio); });
    if (!conOmaggi.length && !movimenti.length) h += vuotoOmaggi();
    for (const o of conOmaggi) {
      const x = omaggiOrdine(o);
      const vecchiRegali = (o.righe || []).filter(r => r.omaggio);
      h += `<div class="card b-gold tap" data-ordine="${o.id}">
        <div class="row"><div><h3>Ordine del ${dataLunga(o.data)}</h3><div class="sub">${esc(nomiOrdine(o))}</div></div><span class="muted" style="font-size:22px">›</span></div>
        ${x.nArrivati || !o.omaggiNote ? `<div class="gift-sub">📥 Arrivati</div>
        <div>${x.arrivati.length ? listaOm(x.arrivati) : `<span class="muted" style="font-size:15px">nessuno segnato</span>`}</div>` : ""}
        ${o.omaggiNote ? `<div class="hint">📝 Dal vecchio file: ${esc(o.omaggiNote)}</div>` : ""}
        ${x.regalati.length || x.nArrivati ? `<div class="gift-sub">🤝 Regalati</div>
        ${x.regalati.length ? x.regalati.map(gr => `<div class="regalo-riga">${avatarMini(gr.riga)}<b>${esc(nomeRiga(gr.riga))}</b> ${listaOm(gr.omaggi)}</div>`).join("")
          : `<span class="muted" style="font-size:15px">nessuno</span>`}` : ""}
        ${vecchiRegali.map(r => `<div class="hint">📝 ${esc(nomeRiga(r))}: ${esc(r.omaggio)}</div>`).join("")}
      </div>`;
    }
    if (movimenti.length) {
      h += `<div class="section"><h2>✋ Fuori dagli ordini</h2></div><div class="card">
        ${[...movimenti].sort((a, b) => (b.data || "").localeCompare(a.data || "")).map(m => `<div class="money-row">
          <span>${dataLunga(m.data)} · ${esc(m.nome)}</span>
          <span><b class="num" style="color:${m.qta > 0 ? "var(--green)" : "var(--pink)"}">${m.qta > 0 ? "+" : ""}${m.qta}</b>
          <button class="x-mini" data-delmov="${m.id}" aria-label="Elimina">×</button></span></div>`).join("")}
      </div>`;
    }
  } else {
    if (!g.length) h += vuotoOmaggi();
    for (const v of g) {
      h += `<div class="card b-gold"><div class="gift">
        <div class="g-n"><h3>${esc(v.nome)}</h3><div class="sub">📥 ${v.ricevuti + Math.max(0, v.rettifiche)} · 🤝 ${v.dati + Math.max(0, -v.rettifiche)}</div></div>
        <div class="g-q" style="color:${v.giacenza < 0 ? "var(--red)" : "var(--gold)"}">${v.giacenza}</div>
        <div class="g-b"><button class="c-pink" data-mov="${esc(v.nome)}" data-q="-1" aria-label="Uno in meno">−</button>
          <button class="c-green" data-mov="${esc(v.nome)}" data-q="1" aria-label="Uno in più">＋</button></div>
      </div>
      ${v.giacenza < 0 ? `<div class="hint" style="color:var(--red)">Ne risultano regalati più di quelli arrivati: forse manca un arrivo in un ordine.</div>` : ""}
      <details class="storia"><summary>Da dove arrivano e a chi sono andati</summary>
        ${v.eventi.map(e => evento(e)).join("")}
      </details></div>`;
    }
  }
  $("#view").innerHTML = h;
  $$("[data-vo]").forEach(b => b.addEventListener("click", () => { vistaOmaggi = b.dataset.vo; renderOmaggi(); }));
  $("#converti-omaggi")?.addEventListener("click", () => apriConversioneOmaggi(daConvertire));
  $$("[data-ordine]").forEach(el => el.addEventListener("click", () => apriOrdine(ordini.find(o => o.id === el.dataset.ordine))));
  $$("[data-mov]").forEach(b => b.addEventListener("click", async () => {
    const ref = await addDoc(col("movimentiOmaggi"), { nome: b.dataset.mov, qta: Number(b.dataset.q), data: oggi(), nota: "" });
    avviso(`🎁 ${b.dataset.mov}: ${b.dataset.q > 0 ? "uno in più" : "uno in meno"}`, () => deleteDoc(ref));
  }));
  $$("[data-delmov]").forEach(b => b.addEventListener("click", async () => {
    const m = movimenti.find(x => x.id === b.dataset.delmov); const { id, ...copia } = m;
    await deleteDoc(doc(col("movimentiOmaggi"), id));
    avviso("Tolto", () => setDoc(doc(col("movimentiOmaggi"), id), copia));
  }));
}

// Trasforma il testo degli omaggi importati dal vecchio Excel in omaggi contati
function apriConversioneOmaggi(lista) {
  sheetChiudi = null;
  const proposte = lista.map(o => ({ o, omaggi: parseOmaggi(o.omaggiNote) }));
  const tot = proposte.reduce((s, p) => s + p.omaggi.reduce((t, x) => t + x.qta, 0), 0);
  $("#sheet-body").innerHTML = testataSheet("Omaggi del vecchio file", false) + `
    <div class="sh-main">
      <div class="question">Ho trovato ${tot} omaggi</div>
      <p class="q-hint">Li segno come <b>arrivati da Yves Rocher</b> con ogni ordine. Se qualcuno l'hai poi regalato, toglilo con il − nella sezione Omaggi.</p>
      ${proposte.map(p => `<div class="card b-gold" style="padding:12px 16px"><b>Ordine del ${dataLunga(p.o.data)}</b>
        <div class="hint" style="margin:2px 0 8px">Scritto: “${esc(p.o.omaggiNote)}”</div>
        <div>${p.omaggi.map(x => `<span class="gift-pill">${x.qta > 1 ? `<b>${x.qta}×</b> ` : ""}${esc(x.nome)}</span>`).join("")}</div></div>`).join("")}
      <p class="hint">Il testo originale resta salvato. Se qualcosa non va, puoi correggerlo aprendo l'ordine.</p>
    </div>
    <div class="sh-foot"><button class="big primary" id="conv-ok">✨ Trasforma</button></div>`;
  $("#sh-back").addEventListener("click", () => chiudiSheet());
  $("#conv-ok").addEventListener("click", async () => {
    $("#conv-ok").disabled = true;
    const b = writeBatch(db);
    proposte.forEach(p => b.set(doc(col("ordini"), p.o.id), { omaggiRicevuti: p.omaggi, omaggiNote: "", omaggiNoteOriginale: p.o.omaggiNote }, { merge: true }));
    await b.commit();
    chiudiSheet(true);
    avviso(`🎁 ${tot} omaggi aggiunti`, async () => {
      const u = writeBatch(db);
      proposte.forEach(p => u.set(doc(col("ordini"), p.o.id), { omaggiRicevuti: [], omaggiNote: p.o.omaggiNote }, { merge: true }));
      await u.commit();
    });
  });
  apriSheet();
}

function evento(e) {
  const o = e.ordineId ? ordini.find(x => x.id === e.ordineId) : null;
  const quando = dataLunga(e.data);
  if (e.tipo === "arrivati") return `<div class="evento"><span class="ev-ico c-green">📥</span><div><b>${e.qta} arrivati</b> con l'ordine del ${quando}</div></div>`;
  if (e.tipo === "regalati") return `<div class="evento"><span class="ev-ico c-pink">🤝</span><div><b>${e.qta} a ${esc(nomeCliente(e.clienteId))}</b> · ${quando}</div></div>`;
  return `<div class="evento"><span class="ev-ico c-gold">✋</span><div><b>${e.qta > 0 ? "+" : ""}${e.qta} a mano</b> · ${quando}</div></div>`;
}
const nomeCliente = (id) => nomeRiga({ clienteId: id });
const avatarMini = (r) => `<span class="avatar mini ${r.clienteId === IO ? "c-pink" : coloreDi(nomeRiga(r))}">${r.clienteId === IO ? "🙋‍♀️" : esc(iniziali(nomeRiga(r)))}</span>`;
const vuotoOmaggi = () => `<div class="empty"><div class="e-ico">🎁</div><b>Nessun omaggio ancora</b><br>
  Quando crei un ordine, nel riepilogo trovi “🎁 Omaggi di quest'ordine”: segna lì quelli arrivati.
  Quelli che regali li segni toccando la cliente, all'ultimo passaggio.</div>`;

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

// ---------- NOTIFICHE (Worker Cloudflare) ----------
let workerUrl = null;            // letto da notifiche-config.js
async function leggiWorkerUrl() {
  if (workerUrl !== null) return workerUrl;
  try {
    const t = await (await fetch("notifiche-config.js", { cache: "no-store" })).text();
    workerUrl = (t.replace(/^\s*\/\/.*$/gm, "").match(/https:\/\/[^"'`\s]+/) || [""])[0].replace(/\/+$/, "");
  } catch { workerUrl = ""; }
  return workerUrl;
}
const NOTIFICHE_BASE = { ora: 9, compleanni: true, arrivi: true, pagamenti: true, ricontatti: false };
const prefNotifiche = () => ({ ...NOTIFICHE_BASE, ...(impostazioni.notifiche || {}) });
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const daHome = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const b64uInBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const tokenCasuale = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, "0")).join("");

async function chiamaWorker(percorso, corpo) {
  const url = await leggiWorkerUrl();
  const r = await fetch(url + percorso, corpo ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.errore || `errore ${r.status}`);
  return j;
}

async function iscrizioneDispositivo() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function disegnaNotifiche() {
  const box = $("#box-notifiche"); if (!box) return;
  const url = await leggiWorkerUrl();
  const p = prefNotifiche();
  let corpo;
  if (!url) corpo = `<div class="hint" style="margin:0">Non ancora collegate: serve il Worker Cloudflare (vedi istruzioni).</div>`;
  else if (isIOS() && !daHome()) corpo = `<div class="hint" style="margin:0">Su iPhone le notifiche funzionano solo con l'app aggiunta alla schermata Home:
      in Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi apri l'app da lì.</div>`;
  else if (!("PushManager" in window) || !("Notification" in window)) corpo = `<div class="hint" style="margin:0">Questo browser non supporta le notifiche.</div>`;
  else if (Notification.permission === "denied") corpo = `<div class="hint" style="margin:0">Le notifiche sono bloccate. Su iPhone: Impostazioni → Notifiche → Ordini → Consenti notifiche.</div>`;
  else {
    const sub = await iscrizioneDispositivo();
    if (!sub) corpo = `<div class="hint" style="margin:0 0 10px">Ti avviso io di compleanni, pacchi in ritardo e pagamenti da chiedere.</div>
      <button class="big primary" id="notif-attiva">🔔 Attiva su questo dispositivo</button>`;
    else corpo = `<div class="hint" style="margin:0 0 10px;color:var(--green)"><b>✓ Attive su questo dispositivo</b></div>
      <div class="yn-q" style="font-size:16px">A che ora?</div>
      <div class="chips small-chips">${[8, 9, 12, 18, 20].map(h => `<button class="chip ${p.ora === h ? "sel" : ""}" data-nora="${h}">${h}:00</button>`).join("")}</div>
      <div class="yn-q" style="font-size:16px;margin-top:14px">Avvisami di…</div>
      <div class="chips small-chips">${[["compleanni", "🎂 Compleanni"], ["arrivi", "🚚 Pacchi in ritardo"], ["pagamenti", "💶 Pagamenti da chiedere"], ["ricontatti", "💜 Clienti da sentire"]]
        .map(([k, t]) => `<button class="chip ${p[k] ? "sel" : ""}" data-ntipo="${k}">${t}</button>`).join("")}</div>
      <div class="stack" style="margin-top:14px"><button id="notif-prova">📨 Mandami una prova</button>
        <button class="danger" id="notif-off" style="text-align:center">Disattiva su questo dispositivo</button></div>`;
  }
  box.innerHTML = `<div class="yn-q">🔔 Notifiche</div>${corpo}`;

  $("#notif-attiva")?.addEventListener("click", attivaNotifiche);
  $("#notif-prova")?.addEventListener("click", async () => {
    try { await programmaNotifiche(true); await chiamaWorker("/prova", { utente: uid, token: impostazioni.pushToken }); avviso("📨 Inviata: arriva tra pochi secondi"); }
    catch (e) { alert("Non sono riuscita a mandare la prova: " + e.message); }
  });
  $("#notif-off")?.addEventListener("click", async () => {
    const sub = await iscrizioneDispositivo();
    if (sub) { try { await chiamaWorker("/disiscrivi", { utente: uid, token: impostazioni.pushToken, endpoint: sub.endpoint }); } catch {} await sub.unsubscribe(); }
    avviso("🔕 Notifiche disattivate su questo dispositivo"); disegnaNotifiche();
  });
  $$("[data-nora]").forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { notifiche: { ...p, ora: Number(b.dataset.nora) } }, { merge: true })));
  $$("[data-ntipo]").forEach(b => b.addEventListener("click", () => setDoc(docImpostazioni(), { notifiche: { ...p, [b.dataset.ntipo]: !p[b.dataset.ntipo] } }, { merge: true })));
}

async function attivaNotifiche() {
  try {
    const permesso = await Notification.requestPermission();
    if (permesso !== "granted") { avviso("Senza il permesso non posso mandarti notifiche"); return disegnaNotifiche(); }
    const reg = await navigator.serviceWorker.ready;
    const { chiave } = await chiamaWorker("/vapid");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uInBytes(chiave) });
    let token = impostazioni.pushToken;
    if (!token) { token = tokenCasuale(); await setDoc(docImpostazioni(), { pushToken: token, notifiche: prefNotifiche() }, { merge: true }); impostazioni.pushToken = token; }
    await chiamaWorker("/iscrivi", { utente: uid, token, subscription: sub.toJSON() });
    await programmaNotifiche(true);
    avviso("🔔 Notifiche attive!");
  } catch (e) { alert("Non sono riuscita ad attivare le notifiche: " + e.message); }
  disegnaNotifiche();
}

// Promemoria dei prossimi giorni, calcolati qui e mandati al Worker
function calcolaPromemoria() {
  const p = prefNotifiche();
  const oraTxt = String(p.ora).padStart(2, "0") + ":00:00";
  const quando = (giorno) => new Date(`${giorno}T${oraTxt}`).getTime();
  const piu = (iso, n) => new Date(Date.parse(iso + "T00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const tra = (a, b) => Math.round((Date.parse(b + "T00:00Z") - Date.parse(a + "T00:00Z")) / 86400000);
  const oggiIso = oggi(), lista = [];

  if (p.compleanni) for (const c of clienti) {
    const pc = prossimoCompleanno(c.compleanno);
    if (pc && pc.giorni <= 14 && c.auguriFatti !== pc.data)
      lista.push({ id: `comp:${c.id}:${pc.data}`, quando: quando(pc.data), titolo: `🎂 Oggi compie gli anni ${c.nome}`, testo: "Apri l'app e mandale gli auguri su WhatsApp." });
  }
  // riepilogo del giorno per i prossimi 7 giorni (si aggiorna ogni volta che apri l'app)
  for (let i = 0; i < 7; i++) {
    const g = piu(oggiIso, i), parti = [];
    if (p.arrivi) {
      const lenti = ordini.filter(o => !arrivato(o) && o.data && tra(o.data, g) >= 10);
      if (lenti.length) parti.push(`🚚 ${lenti.length === 1 ? "1 ordine aspetta" : lenti.length + " ordini aspettano"} da più di 10 giorni`);
    }
    if (p.pagamenti) {
      const righe = ordini.filter(o => arrivato(o) && o.data && tra(o.data, g) >= 14).flatMap(o => (o.righe || []).filter(r => !isSpeciale(r.clienteId) && !r.pagato));
      if (righe.length) { const n = new Set(righe.map(r => r.clienteId)).size; parti.push(`💶 ${n === 1 ? "1 cliente deve" : n + " clienti devono"} pagarti ${euro(somma(righe, r => r.importo))}`); }
    }
    if (p.ricontatti) {
      const n = daRicontattare(clienti, ordini, g, Number(impostazioni.giorniRicontatto) || 0).length;
      if (n) parti.push(`💜 ${n === 1 ? "1 cliente da sentire" : n + " clienti da sentire"}`);
    }
    if (parti.length) lista.push({ id: `riep:${g}`, quando: quando(g), titolo: "🌿 Oggi da fare", testo: parti.join(" · ") });
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
  if (!forza && ultima === firma) return;     // niente di nuovo: non scrivo
  try {
    await chiamaWorker("/programma", { utente: uid, token: impostazioni.pushToken, promemoria });
    try { localStorage.setItem("ultimiPromemoria", firma); } catch {}
  } catch { /* offline: riprovo al prossimo cambio */ }
}

// ---------- SOLDI ----------
function renderSoldi() {
  const nomeMese = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  const meseBreve = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "short", year: "2-digit" });
  const sposta = (k, d) => { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7); };
  const ultimo = oggi().slice(0, 7);
  const tot = riepilogoPeriodo(ordini);
  const mesi = guadagnoPerMese(ordini);
  const primo = ordini.map(o => o.data).filter(Boolean).sort()[0];
  const m = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(meseSel)));
  const sc = statoScorta(ordini);
  const max = Math.max(1, ...mesi.map(x => Math.abs(x.guadagnoAtteso)));
  const anni = [...new Set(mesi.map(x => x.mese.slice(0, 4)))];

  $("#view").innerHTML = `
    <div class="big-money ${tot.guadagnoAtteso >= 0 ? "c-green" : "c-pink"}"><div style="font-weight:700">🌿 Guadagno totale</div>
      <div class="v num">${euro(tot.guadagnoAtteso)}</div>
      <div style="font-size:14px;opacity:.85">${primo ? `dal ${dataLunga(primo)} ${primo.slice(0, 4)} · ` : ""}${plurale(tot.ordini, "ordine", "ordini")}</div></div>

    ${sc.pezzi.length ? `<div class="card b-orange"><div class="row"><div><h3>📦 La tua scorta</h3>
        <div class="sub">${[sc.pezziRimasti ? plurale(sc.pezziRimasti, "pezzo", "pezzi") : "", sc.confezioniAperte ? plurale(sc.confezioniAperte, "confezione", "confezioni") : ""].filter(Boolean).join(" e ") || "Niente"} da rivendere</div></div>
        <div class="amount num" style="color:var(--orange)">${euro(sc.saldo)}</div></div>
        <div class="hint" style="margin:4px 0 8px">Soldi anticipati in prodotti: non sono spese, rientrano quando li vendi.</div>
        ${sc.pezzi.filter(v => v.rimasti !== 0).map(v => `<div class="money-row"><span>${v.tipo === "confezione" ? "🎄 " : ""}${esc(v.nome)}${v.costoNoto ? "" : ` <span class="badge c-gold" style="margin:0">manca quanto l'hai pagato</span>`}</span>
          <b class="num">${v.tipo === "confezione" ? `ancora ${euro(v.valoreResiduo)}` : `${v.rimasti} ${v.rimasti === 1 ? "pezzo" : "pezzi"}`}</b></div>`).join("") || `<div class="hint">Hai venduto tutto 🎉</div>`}
      </div>` : ""}

    <div class="section"><h2>📅 Mese per mese</h2></div>
    <p class="section-hint">Tocca un mese per vedere il dettaglio.</p>
    <div class="card" style="padding:8px 14px">
      ${mesi.length ? mesi.map(x => `<button class="mese-riga ${x.mese === meseSel ? "sel" : ""}" data-mese="${x.mese}">
          <span class="mr-nome">${meseBreve(x.mese)}</span>
          <span class="mr-barra"><span class="${x.guadagnoAtteso >= 0 ? "pos" : "neg"}" style="width:${Math.max(3, Math.round(Math.abs(x.guadagnoAtteso) / max * 100))}%"></span></span>
          <span class="mr-val num" style="color:${x.guadagnoAtteso >= 0 ? "var(--green)" : "var(--red)"}">${euro(x.guadagnoAtteso)}</span>
        </button>`).join("") : `<div class="empty" style="padding:16px">Ancora nessun ordine.</div>`}
    </div>

    <div class="section" id="dettaglio-mese"><h2>🔍 Dettaglio</h2></div>
    <div class="month-nav"><button id="m-prev" aria-label="Mese prima">‹</button><div class="m">${nomeMese(meseSel)}</div>
      <button id="m-next" aria-label="Mese dopo" ${meseSel >= ultimo ? "disabled style='opacity:.3'" : ""}>›</button></div>
    <div class="result ${m.guadagnoAtteso >= 0 ? "c-green" : "c-pink"}" style="margin-top:0"><div class="r-lbl">🌿 Ti sei messa in tasca</div>
      <div class="r-val num">${euro(m.guadagnoAtteso)}</div><div class="r-sub">${plurale(m.ordini, "ordine", "ordini")}</div></div>
    <div class="tiles">
      <div class="tile c-blue"><div class="t-ico">🛍️</div><div class="t-val num">${euro(m.venditaClienti)}</div><div class="t-lbl">venduto alle clienti</div></div>
      <div class="tile c-orange"><div class="t-ico">🧾</div><div class="t-val num">${euro(m.costo)}</div><div class="t-lbl">pagato a Yves Rocher</div></div>
      <div class="tile c-pink"><div class="t-ico">🙋‍♀️</div><div class="t-val num">${euro(m.quotaIo)}</div><div class="t-lbl">speso per te</div></div>
      <div class="tile c-purple"><div class="t-ico">⏳</div><div class="t-val num">${euro(m.daIncassare)}</div><div class="t-lbl">ancora da incassare</div></div>
      ${m.quotaScorta > 0 || m.usatoScorta > 0 ? `
      <div class="tile c-gold"><div class="t-ico">📦</div><div class="t-val num">${euro(m.quotaScorta)}</div><div class="t-lbl">messi in scorta</div></div>
      <div class="tile c-gold"><div class="t-ico">♻️</div><div class="t-val num">${euro(m.usatoScorta)}</div><div class="t-lbl">presi dalla scorta</div></div>` : ""}
    </div>

    ${anni.length ? `<div class="section"><h2>🗓️ Anno per anno</h2></div><div class="card">
      ${anni.map(y => { const a = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(y)));
        return `<div class="money-row"><span>${y} <span class="muted">· venduto ${euro(a.venditaClienti)}</span></span>
          <b class="num" style="color:${a.guadagnoAtteso >= 0 ? "var(--green)" : "var(--red)"}">${euro(a.guadagnoAtteso)}</b></div>`; }).join("")}
    </div>` : ""}

    <div class="section"><h2>⚙️ Impostazioni</h2></div>
    <div class="yesno" id="box-notifiche"><div class="yn-q">🔔 Notifiche</div><div class="hint" style="margin:0">Controllo…</div></div>
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
    <p class="versione" style="text-align:center">v14</p>`;
  const vaiDettaglio = () => $("#dettaglio-mese").scrollIntoView({ behavior: "smooth", block: "start" });
  $$("[data-mese]").forEach(b => b.addEventListener("click", () => { meseSel = b.dataset.mese; renderSoldi(); vaiDettaglio(); }));
  $("#m-prev").addEventListener("click", () => { meseSel = sposta(meseSel, -1); renderSoldi(); vaiDettaglio(); });
  $("#m-next").addEventListener("click", () => { if (meseSel < ultimo) { meseSel = sposta(meseSel, 1); renderSoldi(); vaiDettaglio(); } });
  disegnaNotifiche();
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
  const righe = [["Data ordine", "Cliente", "Prodotti", "Omaggi dati", "Importo", "Pagato", "Consegnato", "Pagato a Yves Rocher", "Dalla scorta", "Spesa per me", "Messo in scorta", "Guadagno ordine"].join(";")];
  for (const o of [...ordini].reverse()) {
    const c = calcolaOrdine(o);
    (o.righe || []).forEach((r, i) => righe.push([dataIt(o.data), q(nomeRiga(r)), q(r.prodotti), q([listaOm(r.omaggiDati), r.omaggio].filter(Boolean).join(", ")),
      n(r.importo), r.pagato ? "sì" : "no", r.consegnato ? "sì" : "no",
      i === 0 ? n(c.pagatoYR) : "", i === 0 ? n(c.usatoScorta) : "", i === 0 ? n(c.quotaIo) : "", i === 0 ? n(c.quotaScorta) : "", i === 0 ? n(c.guadagnoAtteso) : ""].join(";")));
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
