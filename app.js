import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot,
  addDoc, setDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { calcolaOrdine, riepilogoPeriodo, giacenzaOmaggi, daRicontattare, linkWhatsApp, euro, chiave, IO, STORICO } from "./calc.js";
import { convertiFoglio } from "./importa.js";

// ---------- Firebase ----------
if (!firebaseConfig?.apiKey || /INSERISCI/.test(JSON.stringify(firebaseConfig))) {
  throw new Error("firebase-config.js contiene ancora i valori di esempio “INSERISCI…”: incolla la configurazione del tuo progetto Firebase.");
}
window.__appAvviata = true;
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Cache locale: funziona anche offline e sincronizza quando torna la rete
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

let uid = null;
let clienti = [], ordini = [], catalogo = [], movimenti = [];
let impostazioni = { giorniRicontatto: 60, ultimoBackup: null };
let unsub = [];
let vista = "todo";
let meseSel = new Date().toISOString().slice(0, 7);

const col = (nome) => collection(db, "utenti", uid, nome);
const docImpostazioni = () => doc(db, "utenti", uid, "impostazioni", "generale");
const $ = (s) => document.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const numIt = (v) => { const n = Number(String(v ?? "").replace(/\s|€/g, "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const inIt = (v) => v === null || v === undefined || v === "" ? "" : String(v).replace(".", ",");
const nuovoId = () => Math.random().toString(36).slice(2, 10);
const oggi = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dataIt = (iso) => iso ? new Date(iso + "T00:00").toLocaleDateString("it-IT") : "";
const slug = (s) => chiave(s).replace(/[^a-z0-9àèéìòù]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || nuovoId();
const nomeRiga = (r) => r.clienteId === IO ? "Io (personale)" : r.clienteId === STORICO ? (r.clientiStorico || "Più clienti")
  : (clienti.find(c => c.id === r.clienteId)?.nome || "Cliente eliminato");
const nomeCliente = (id) => nomeRiga({ clienteId: id });
const listaOmaggi = (arr) => (arr || []).filter(x => x.nome).map(x => `${x.qta > 1 ? x.qta + "× " : ""}${x.nome}`).join(", ");

// ---------- Auth ----------
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
  try { await createUserWithEmailAndPassword(auth, $("#login-email").value, $("#login-pass").value); }
  catch (err) { $("#login-error").textContent = err.code === "auth/weak-password" ? "Password di almeno 6 caratteri." : "Impossibile creare l'account."; }
});
$("#btn-reset").addEventListener("click", async () => {
  const email = $("#login-email").value.trim();
  if (!email) { $("#login-error").textContent = "Scrivi prima la tua email."; return; }
  try { await sendPasswordResetEmail(auth, email); $("#login-error").textContent = "Ti ho inviato un'email per reimpostare la password."; }
  catch { $("#login-error").textContent = "Impossibile inviare l'email."; }
});

// ---------- Navigazione ----------
const titoli = { todo: "Da fare", ordini: "Ordini", clienti: "Clienti", omaggi: "Omaggi", riepilogo: "Riepilogo" };
const nuovo = { todo: ["+ Ordine", () => apriOrdine()], ordini: ["+ Ordine", () => apriOrdine()],
  clienti: ["+ Cliente", () => apriCliente()], omaggi: ["+ Movimento", () => apriMovimento()] };
$$(".tabbar button").forEach(b => b.addEventListener("click", () => {
  vista = b.dataset.view;
  $$(".tabbar button").forEach(x => x.classList.toggle("active", x === b));
  window.scrollTo(0, 0);
  render();
}));
$("#btn-new").addEventListener("click", () => nuovo[vista]?.[1]());

function render() {
  if (!uid) return;
  $("#view-title").textContent = titoli[vista];
  $("#btn-new").classList.toggle("hidden", !nuovo[vista]);
  if (nuovo[vista]) $("#btn-new").textContent = nuovo[vista][0];
  ({ todo: renderTodo, ordini: renderOrdini, clienti: renderClienti, omaggi: renderOmaggi, riepilogo: renderRiepilogo })[vista]();
  aggiornaSuggerimenti();
}

// Suggerimenti per prodotti e omaggi (autocompletamento)
function aggiornaSuggerimenti() {
  const prodotti = new Map();
  for (const p of catalogo) prodotti.set(chiave(p.nome), p.nome);
  for (const o of ordini) for (const r of o.righe || []) for (const p of String(r.prodotti || "").split(",")) {
    const n = p.trim(); if (n && n.length < 60 && !prodotti.has(chiave(n))) prodotti.set(chiave(n), n);
  }
  $("#dl-prodotti").innerHTML = [...prodotti.values()].sort((a, b) => a.localeCompare(b, "it")).map(n => `<option value="${esc(n)}">`).join("");
  $("#dl-omaggi").innerHTML = giacenzaOmaggi(ordini, movimenti).map(v => `<option value="${esc(v.nome)}">`).join("");
}

// ---------- Messaggi WhatsApp ----------
function apriWhatsApp(cliente, testo) {
  if (!cliente?.telefono) {
    if (!confirm(`${cliente?.nome || "Il cliente"} non ha un numero salvato. Apro WhatsApp per scegliere il contatto?`)) return;
  }
  window.open(linkWhatsApp(cliente?.telefono, testo), "_blank");
}
const primoNome = (c) => String(c?.nome || "").split(" ")[0];

function messaggioCliente(cliente, items) {
  const daPagare = items.filter(x => x.r.clienteId !== IO && !x.r.pagato);
  const daConsegnare = items.filter(x => !x.r.consegnato);
  const tot = daPagare.reduce((s, x) => s + (Number(x.r.importo) || 0), 0);
  let t = `Ciao ${primoNome(cliente)}! `;
  if (daConsegnare.length) t += `Sono arrivati i tuoi prodotti Yves Rocher: ${daConsegnare.map(x => x.r.prodotti).filter(Boolean).join(", ")}. `;
  if (daPagare.length) t += `${daConsegnare.length ? "Il totale è" : "Ti ricordo il saldo di"} ${euro(tot)}${daConsegnare.length ? "" : ` per ${daPagare.map(x => x.r.prodotti).filter(Boolean).join(", ")}`}. `;
  t += daConsegnare.length ? "Quando ci vediamo per la consegna?" : "Quando ti è comodo? Grazie! 😊";
  return t;
}
function messaggioRicontatto(x) {
  return x.tipo === "riacquisto"
    ? `Ciao ${primoNome(x.cliente)}! Come ti stai trovando con ${x.prodotti}? Dovrebbe essere quasi finito: vuoi che te lo riordini? Ci sono anche le nuove promozioni Yves Rocher 😊`
    : `Ciao ${primoNome(x.cliente)}! È uscito il nuovo catalogo Yves Rocher con diverse promozioni. Ti mando qualche proposta? 😊`;
}

// ---------- Vista: Da fare ----------
function righePendenti() {
  const perCliente = new Map();
  for (const o of ordini) for (const r of o.righe || []) {
    const daIncassare = r.clienteId !== IO && !r.pagato;
    if (r.consegnato && !daIncassare) continue;
    const k = r.clienteId === STORICO ? STORICO + ":" + r.clientiStorico : r.clienteId;
    if (!perCliente.has(k)) perCliente.set(k, []);
    perCliente.get(k).push({ o, r, daIncassare });
  }
  return perCliente;
}

function renderTodo() {
  let html = bannerBackup();
  const perCliente = righePendenti();
  const tutte = [...perCliente.values()].flat();
  const tot = tutte.filter(x => x.daIncassare).reduce((s, x) => s + (Number(x.r.importo) || 0), 0);
  html += `<div class="kpis"><div class="kpi"><div class="v num">${euro(tot)}</div><div class="l">Da incassare</div></div>
    <div class="kpi"><div class="v">${tutte.filter(x => !x.r.consegnato).length}</div><div class="l">Consegne da fare</div></div></div>`;

  if (!perCliente.size) html += `<div class="empty">Tutto consegnato e incassato 🎉</div>`;
  const ordinati = [...perCliente.entries()].sort((a, b) => nomeRiga(a[1][0].r).localeCompare(nomeRiga(b[1][0].r), "it"));
  for (const [k, items] of ordinati) {
    const r0 = items[0].r;
    const dovuto = items.filter(x => x.daIncassare).reduce((s, x) => s + (Number(x.r.importo) || 0), 0);
    const cliente = clienti.find(c => c.id === r0.clienteId);
    html += `<div class="card"><div class="row"><h3>${esc(nomeRiga(r0))}</h3>${dovuto ? `<span class="num badge warn">${euro(dovuto)}</span>` : ""}</div>`;
    for (const { o, r } of items) html += rigaHtml(o, r, true);
    if (cliente) html += `<button class="small wa" data-wa="${esc(k)}" style="margin-top:8px">💬 Scrivi su WhatsApp</button>`;
    html += `</div>`;
  }

  const ric = daRicontattare(clienti, ordini, oggi(), Number(impostazioni.giorniRicontatto) || 0);
  if (ric.length) {
    html += `<div class="section-title">Da ricontattare</div>`;
    ric.forEach((x, i) => {
      html += `<div class="card"><div class="row"><h3>${esc(x.cliente.nome)}</h3><span class="badge">${x.giorni} gg</span></div>
        <div class="muted" style="font-size:14px">${x.tipo === "riacquisto" ? `Probabilmente sta finendo: ${esc(x.prodotti)}` : `Ultimo acquisto il ${dataIt(x.ultimoAcquisto)}`}</div>
        <div class="toggles" style="margin-top:8px">
          <button class="small wa" data-ric="${i}">💬 WhatsApp</button>
          <button class="small" data-ricfatto="${x.cliente.id}">✓ Contattata</button>
        </div></div>`;
    });
  }
  $("#view").innerHTML = html;
  collegaToggle();
  collegaBackupBanner();
  $$("[data-wa]").forEach(b => b.addEventListener("click", () => {
    const items = perCliente.get(b.dataset.wa);
    apriWhatsApp(clienti.find(c => c.id === items[0].r.clienteId), messaggioCliente(clienti.find(c => c.id === items[0].r.clienteId), items));
  }));
  $$("[data-ric]").forEach(b => b.addEventListener("click", async () => {
    const x = ric[+b.dataset.ric];
    apriWhatsApp(x.cliente, messaggioRicontatto(x));
  }));
  $$("[data-ricfatto]").forEach(b => b.addEventListener("click", () =>
    setDoc(doc(col("clienti"), b.dataset.ricfatto), { ultimoContatto: oggi() }, { merge: true })));
}

function rigaHtml(o, r, conData) {
  const isIo = r.clienteId === IO;
  const omaggi = [listaOmaggi(r.omaggiDati), r.omaggio].filter(Boolean).join(", ");
  return `<div class="line-item"><div class="grow">
      <div>${esc(r.prodotti) || "<span class='muted'>(nessun prodotto)</span>"}</div>
      <div class="muted" style="font-size:13px">${conData ? "Ordine del " + dataIt(o.data) : ""}${omaggi ? (conData ? " · " : "") + "🎁 " + esc(omaggi) : ""}</div>
      <div class="toggles" style="margin-top:6px">
        <button class="toggle ${r.consegnato ? "on" : ""}" data-o="${o.id}" data-r="${r.id}" data-k="consegnato">${r.consegnato ? "✓ Consegnato" : "Da consegnare"}</button>
        ${isIo ? "" : `<button class="toggle ${r.pagato ? "on" : ""}" data-o="${o.id}" data-r="${r.id}" data-k="pagato">${r.pagato ? "✓ Pagato" : "Da pagare"}</button>`}
      </div></div>
    <div class="num">${euro(r.importo)}</div></div>`;
}

function collegaToggle() {
  $$(".toggle[data-k]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const o = ordini.find(x => x.id === b.dataset.o); if (!o) return;
    const righe = o.righe.map(r => r.id === b.dataset.r ? { ...r, [b.dataset.k]: !r[b.dataset.k] } : r);
    await setDoc(doc(col("ordini"), o.id), { righe }, { merge: true });
  }));
}

// ---------- Backup ----------
function bannerBackup() {
  if (!ordini.length) return "";
  const ultimo = impostazioni.ultimoBackup;
  const giorni = ultimo ? Math.round((new Date(oggi()) - new Date(ultimo)) / 86400000) : null;
  if (giorni !== null && giorni < 30) return "";
  return `<div class="card banner"><div class="row"><span>${ultimo ? `Ultimo backup ${giorni} giorni fa.` : "Non hai ancora fatto un backup."}</span>
    <button class="small primary" id="banner-backup">Scarica backup</button></div></div>`;
}
function collegaBackupBanner() { $("#banner-backup")?.addEventListener("click", scaricaBackup); }

async function scaricaBackup() {
  const dati = { app: "ordini-beauty", versione: 1, creato: new Date().toISOString(), clienti, ordini, catalogo, movimentiOmaggi: movimenti,
    impostazioni: { giorniRicontatto: impostazioni.giorniRicontatto } };
  const json = JSON.stringify(dati, (k, v) => (v && typeof v === "object" && typeof v.toDate === "function") ? v.toDate().toISOString() : v, 2);
  scarica(new Blob([json], { type: "application/json" }), `backup-ordini-${oggi()}.json`);
  await setDoc(docImpostazioni(), { ultimoBackup: oggi() }, { merge: true });
}

async function ripristinaBackup(file) {
  let dati;
  try { dati = JSON.parse(await file.text()); } catch { return alert("Il file non è un backup valido."); }
  if (dati.app !== "ordini-beauty") return alert("Il file non è un backup di questa app.");
  if (!confirm(`Ripristino ${dati.clienti?.length || 0} clienti e ${dati.ordini?.length || 0} ordini. I dati con lo stesso identificativo verranno sovrascritti, gli altri restano. Continuo?`)) return;
  const ops = [];
  for (const [nome, lista] of [["clienti", dati.clienti], ["ordini", dati.ordini], ["catalogo", dati.catalogo], ["movimentiOmaggi", dati.movimentiOmaggi]])
    for (const { id, ...resto } of lista || []) ops.push([doc(col(nome), id || nuovoId()), resto]);
  await scriviABlocchi(ops);
  if (dati.impostazioni) await setDoc(docImpostazioni(), dati.impostazioni, { merge: true });
  alert("Ripristino completato.");
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

// ---------- Vista: Ordini ----------
function renderOrdini() {
  if (!ordini.length) { $("#view").innerHTML = `<div class="empty">Nessun ordine. Tocca “+ Ordine” per iniziare, oppure importa il vecchio Excel da Riepilogo.</div>`; return; }
  let html = "";
  for (const o of ordini) {
    const c = calcolaOrdine(o);
    const nomi = [...new Set((o.righe || []).map(nomeRiga))].join(", ");
    html += `<div class="card" data-open="${o.id}" style="cursor:pointer">
      <div class="row"><h3>${dataIt(o.data)}</h3><span class="num ${c.guadagnoAtteso < 0 ? "neg" : "pos"}">${euro(c.guadagnoAtteso)}</span></div>
      <div class="muted" style="font-size:14px">${esc(nomi)}</div>
      <div class="row" style="margin-top:6px;font-size:13px">
        <span class="muted">Venduto ${euro(c.venditaClienti)} · Costo ${euro(o.costo)}</span>
        <span>${c.daIncassare > 0 ? `<span class="badge warn">da incassare ${euro(c.daIncassare)}</span>` : ""}
        ${c.daConsegnare ? `<span class="badge warn">${c.daConsegnare} da consegnare</span>` : ""}</span>
      </div></div>`;
  }
  $("#view").innerHTML = html;
  $$("[data-open]").forEach(el => el.addEventListener("click", () => apriOrdine(ordini.find(o => o.id === el.dataset.open))));
}

// ---------- Modale ordine ----------
const rigaVuota = () => ({ id: nuovoId(), clienteId: "", prodotti: "", importo: "", omaggiDati: [], pagato: false, consegnato: false, riacquistoGiorni: "" });

function editorOmaggi(lista, attr) {
  return `<div class="omaggi-list">${(lista || []).map((x, j) => `<span class="chip">${x.qta > 1 ? x.qta + "× " : ""}${esc(x.nome)}
      <button class="chip-x" data-${attr}-del="${j}" aria-label="Rimuovi">×</button></span>`).join("")}</div>
    <div class="add-row"><input list="dl-omaggi" placeholder="Omaggio o campioncino" data-${attr}-nome>
      <input type="number" min="1" value="1" inputmode="numeric" data-${attr}-qta class="qta">
      <button class="small" data-${attr}-add>+</button></div>`;
}

function apriOrdine(o) {
  const ord = o ? structuredClone(o) : { data: oggi(), costo: "", costoIoManuale: "", omaggiRicevuti: [], omaggiNote: "", note: "", righe: [] };
  ord.omaggiRicevuti ||= [];
  ord.righe.forEach(r => { r.omaggiDati ||= []; r.id ||= nuovoId(); });
  if (!ord.righe.length) ord.righe.push(rigaVuota());
  const nuoviProdotti = [];

  const opzioni = (r) => (r.clienteId === STORICO ? `<option value="${STORICO}" selected>${esc(r.clientiStorico)} (storico)</option>` : "") +
    `<option value="">— scegli —</option><option value="${IO}" ${r.clienteId === IO ? "selected" : ""}>Io (acquisto personale)</option>` +
    clienti.map(c => `<option value="${c.id}" ${r.clienteId === c.id ? "selected" : ""}>${esc(c.nome)}</option>`).join("") +
    `<option value="__nuovo">+ Nuovo cliente…</option>`;

  const leggi = () => {
    const v = (s) => $(s)?.value;
    ord.data = v("#f-data"); ord.costo = v("#f-costo"); ord.note = v("#f-note");
    if ($("#f-costoio")) ord.costoIoManuale = v("#f-costoio");
    $$(".riga-edit").forEach(el => {
      const r = ord.righe[+el.dataset.i];
      $$("[data-f]", el).forEach(inp => { r[inp.dataset.f] = inp.type === "checkbox" ? inp.checked : inp.value; });
    });
  };

  const sommario = () => {
    leggi();
    const c = calcolaOrdine({ ...ord, costo: numIt(ord.costo), costoIoManuale: ord.costoIoManuale === "" || ord.costoIoManuale == null ? null : numIt(ord.costoIoManuale),
      righe: ord.righe.map(r => ({ ...r, importo: numIt(r.importo) })) });
    $("#sommario").innerHTML = `<table>
      <tr><td>Venduto ai clienti</td><td class="num">${euro(c.venditaClienti)}</td></tr>
      <tr><td>Costo per i clienti</td><td class="num">− ${euro(c.costoClienti)}</td></tr>
      <tr><td><b>Guadagno</b> (quando tutti pagano)</td><td class="num"><b class="${c.guadagnoAtteso < 0 ? "neg" : "pos"}">${euro(c.guadagnoAtteso)}</b></td></tr>
      ${c.daIncassare > 0 ? `<tr><td>Ancora da incassare</td><td class="num">${euro(c.daIncassare)}</td></tr>` : ""}
      ${c.valoreIo > 0 ? `<tr><td class="muted">Spesa per me</td><td class="num muted">${euro(c.quotaIo)}</td></tr>` : ""}
    </table>`;
    const boxIo = $("#box-io");
    if (boxIo) { boxIo.classList.toggle("hidden", !(c.valoreIo > 0)); $("#f-costoio").placeholder = `${c.quotaIo.toFixed(2)} (stimato)`; }
  };

  const disegna = () => {
    $("#modal-body").innerHTML = `
      <h2 style="margin-top:0">${o ? "Modifica ordine" : "Nuovo ordine"}</h2>
      <div class="grid2">
        <div><label>Data ordine</label><input type="date" id="f-data" value="${esc(ord.data)}"></div>
        <div><label>Pagato a Yves Rocher (€)</label><input type="text" inputmode="decimal" autocomplete="off" id="f-costo" value="${esc(inIt(ord.costo))}"></div>
      </div>
      <label>Omaggi ricevuti dall'azienda</label>
      ${ord.omaggiNote ? `<div class="hint">Dal vecchio file: ${esc(ord.omaggiNote)}</div>` : ""}
      <div data-scope="ric">${editorOmaggi(ord.omaggiRicevuti, "om")}</div>

      <div class="section-title">Clienti</div>
      <div id="righe">${ord.righe.map((r, i) => `
        <div class="riga-edit" data-i="${i}">
          <div class="grid2">
            <div><label>Cliente</label><select data-f="clienteId">${opzioni(r)}</select></div>
            <div><label>Importo (€)</label><input type="text" inputmode="decimal" autocomplete="off" data-f="importo" value="${esc(inIt(r.importo))}"></div>
          </div>
          <label>Prodotti</label><textarea data-f="prodotti">${esc(r.prodotti)}</textarea>
          <div class="add-row"><input list="dl-prodotti" placeholder="Aggiungi prodotto" data-p-nome>
            <input type="text" inputmode="decimal" autocomplete="off" placeholder="€" data-p-prezzo class="qta">
            <button class="small" data-p-add>+</button></div>
          <label>Omaggi dati al cliente</label>
          ${r.omaggio ? `<div class="hint">Dal vecchio file: ${esc(r.omaggio)}</div>` : ""}
          ${editorOmaggi(r.omaggiDati, "od")}
          <div class="grid2">
            <div><label>Promemoria riacquisto</label>
              <select data-f="riacquistoGiorni">${[["", "Nessuno"], ["30", "Tra 1 mese"], ["60", "Tra 2 mesi"], ["90", "Tra 3 mesi"], ["180", "Tra 6 mesi"]]
                .map(([v, t]) => `<option value="${v}" ${String(r.riacquistoGiorni || "") === v ? "selected" : ""}>${t}</option>`).join("")}</select></div>
            <div class="toggles" style="align-items:flex-end">
              <label class="check"><input type="checkbox" data-f="consegnato" ${r.consegnato ? "checked" : ""}> Consegnato</label>
              ${r.clienteId === IO ? "" : `<label class="check"><input type="checkbox" data-f="pagato" ${r.pagato ? "checked" : ""}> Pagato</label>`}
            </div>
          </div>
          <div style="text-align:right"><button class="danger small" data-del="${i}">Rimuovi cliente</button></div>
        </div>`).join("")}</div>
      <button class="small" id="add-riga" style="margin-top:10px">+ Aggiungi cliente</button>

      <div id="box-io" class="hidden"><label>Costo reale dei miei prodotti (€) — facoltativo</label>
        <input type="text" inputmode="decimal" autocomplete="off" id="f-costoio" value="${esc(inIt(ord.costoIoManuale))}">
        <div class="hint">Se vuoto, il costo è ripartito in proporzione al valore dei prodotti.</div></div>

      <div class="card" id="sommario" style="margin-top:14px"></div>
      <label>Note</label><textarea id="f-note">${esc(ord.note)}</textarea>
      <div class="modal-actions">
        ${o ? `<button class="danger" id="m-del">Elimina ordine</button>` : "<span></span>"}
        <span><button id="m-cancel">Annulla</button> <button class="primary" id="m-save">Salva</button></span>
      </div>`;
    sommario();

    // aggiornamento del riepilogo senza ridisegnare (non perde il tocco su "Salva")
    $("#modal-body").oninput = (e) => { if (e.target.matches("#f-costo, #f-costoio, [data-f=importo]")) sommario(); };

    // omaggi ricevuti
    const scopeRic = $("[data-scope=ric]");
    collegaEditorOmaggi(scopeRic, "om", ord.omaggiRicevuti);

    $$(".riga-edit").forEach(el => {
      const r = ord.righe[+el.dataset.i];
      collegaEditorOmaggi(el, "od", r.omaggiDati);

      // cliente: ridisegna (cambia la presenza di "Pagato")
      $("[data-f=clienteId]", el).addEventListener("change", async (e) => {
        leggi();
        if (e.target.value === "__nuovo") {
          const nome = prompt("Nome del nuovo cliente:");
          if (nome?.trim()) {
            const ref = await addDoc(col("clienti"), { nome: nome.trim(), telefono: "", note: "" });
            r.clienteId = ref.id;
            if (!clienti.some(c => c.id === ref.id)) clienti.push({ id: ref.id, nome: nome.trim() });
          } else r.clienteId = "";
        }
        disegna();
      });

      // aggiunta rapida prodotto con prezzo dal catalogo
      const pNome = $("[data-p-nome]", el), pPrezzo = $("[data-p-prezzo]", el);
      pNome.addEventListener("change", () => {
        const p = catalogo.find(x => chiave(x.nome) === chiave(pNome.value));
        if (p && p.prezzo) pPrezzo.value = inIt(p.prezzo);
      });
      $("[data-p-add]", el).addEventListener("click", () => {
        const nome = pNome.value.trim(); if (!nome) return;
        const prezzo = numIt(pPrezzo.value);
        leggi();
        r.prodotti = r.prodotti ? `${r.prodotti}, ${nome}` : nome;
        r.importo = Math.round((numIt(r.importo) + prezzo) * 100) / 100;
        if (prezzo) nuoviProdotti.push({ nome, prezzo });
        disegna();
        $(`.riga-edit[data-i="${el.dataset.i}"] [data-p-nome]`)?.focus();
      });
    });

    $$("[data-del]").forEach(b => b.addEventListener("click", () => { leggi(); ord.righe.splice(+b.dataset.del, 1); if (!ord.righe.length) ord.righe.push(rigaVuota()); disegna(); }));
    $("#add-riga").addEventListener("click", () => { leggi(); ord.righe.push(rigaVuota()); disegna(); });
    $("#m-cancel").addEventListener("click", () => $("#modal").close());
    $("#m-del")?.addEventListener("click", async () => {
      if (!confirm("Eliminare questo ordine?")) return;
      await deleteDoc(doc(col("ordini"), o.id)); $("#modal").close();
    });
    $("#m-save").addEventListener("click", async () => {
      leggi();
      const righe = ord.righe.filter(r => r.clienteId && r.clienteId !== "__nuovo" && (r.prodotti || numIt(r.importo)))
        .map(r => ({ ...r, importo: numIt(r.importo), pagato: r.clienteId === IO ? true : !!r.pagato,
          riacquistoGiorni: r.riacquistoGiorni ? Number(r.riacquistoGiorni) : null }));
      if (!ord.data) return alert("Inserisci la data.");
      if (!righe.length) return alert("Aggiungi almeno un cliente con prodotti o importo.");
      const { id, ...resto } = ord;
      const dati = { ...resto, righe, costo: numIt(ord.costo),
        costoIoManuale: ord.costoIoManuale === "" || ord.costoIoManuale === undefined || ord.costoIoManuale === null ? null : numIt(ord.costoIoManuale),
        aggiornato: serverTimestamp() };
      if (o) await setDoc(doc(col("ordini"), o.id), dati); else await addDoc(col("ordini"), dati);
      // aggiorna il catalogo con gli ultimi prezzi usati
      for (const p of nuoviProdotti) setDoc(doc(col("catalogo"), slug(p.nome)), { nome: p.nome, prezzo: p.prezzo, ultimoUso: oggi() }, { merge: true });
      $("#modal").close();
    });
  };

  function collegaEditorOmaggi(scope, attr, lista) {
    // solo gli elementi di questo blocco (non quelli annidati di altre righe)
    $$(`[data-${attr}-del]`, scope).forEach(b => b.addEventListener("click", () => { leggi(); lista.splice(+b.getAttribute(`data-${attr}-del`), 1); disegna(); }));
    $(`[data-${attr}-add]`, scope)?.addEventListener("click", () => {
      const nome = $(`[data-${attr}-nome]`, scope).value.trim(); if (!nome) return;
      const qta = Math.max(1, parseInt($(`[data-${attr}-qta]`, scope).value) || 1);
      leggi();
      const esist = lista.find(x => chiave(x.nome) === chiave(nome));
      if (esist) esist.qta += qta; else lista.push({ nome, qta });
      disegna();
    });
  }

  disegna();
  $("#modal").showModal();
}

// ---------- Vista: Clienti ----------
function acquistiCliente(c) {
  const k = chiave(c.nome);
  return ordini.flatMap(o => (o.righe || []).filter(r => r.clienteId === c.id ||
    (r.clienteId === STORICO && String(r.clientiStorico || "").split(",").map(chiave).includes(k))).map(r => ({ o, r })));
}

function renderClienti() {
  if (!clienti.length) { $("#view").innerHTML = `<div class="empty">Nessun cliente ancora.</div>`; return; }
  let html = `<input type="search" id="cerca" placeholder="Cerca cliente" style="margin-bottom:12px">`;
  for (const c of clienti) {
    const acq = acquistiCliente(c);
    const proprie = acq.filter(x => x.r.clienteId === c.id);
    const speso = proprie.reduce((s, x) => s + (Number(x.r.importo) || 0), 0);
    const deve = proprie.filter(x => !x.r.pagato).reduce((s, x) => s + (Number(x.r.importo) || 0), 0);
    html += `<div class="card" data-cli="${c.id}" data-nome="${esc(chiave(c.nome))}" style="cursor:pointer"><div class="row"><h3>${esc(c.nome)}</h3>
      ${deve ? `<span class="badge warn num">deve ${euro(deve)}</span>` : ""}</div>
      <div class="muted" style="font-size:14px">${acq.length} ${acq.length === 1 ? "acquisto" : "acquisti"}${speso ? " · " + euro(speso) : ""}${c.telefono ? " · " + esc(c.telefono) : " · senza telefono"}</div></div>`;
  }
  $("#view").innerHTML = html;
  $("#cerca").addEventListener("input", (e) => {
    const q = chiave(e.target.value);
    $$("[data-cli]").forEach(el => el.classList.toggle("hidden", !el.dataset.nome.includes(q)));
  });
  $$("[data-cli]").forEach(el => el.addEventListener("click", () => apriCliente(clienti.find(c => c.id === el.dataset.cli))));
}

function apriCliente(c) {
  const storico = c ? acquistiCliente(c).sort((a, b) => (b.o.data || "").localeCompare(a.o.data || "")) : [];
  const pendenti = storico.filter(x => x.r.clienteId === c?.id && (!x.r.pagato || !x.r.consegnato));
  $("#modal-body").innerHTML = `
    <h2 style="margin-top:0">${c ? esc(c.nome) : "Nuovo cliente"}</h2>
    <label>Nome</label><input id="c-nome" value="${esc(c?.nome)}">
    <label>Cellulare (per WhatsApp)</label><input id="c-tel" type="tel" value="${esc(c?.telefono)}" placeholder="333 1234567">
    <label>Note (tipo di pelle, preferenze, compleanno…)</label><textarea id="c-note">${esc(c?.note)}</textarea>
    ${c ? `<div class="toggles" style="margin-top:10px">
      ${pendenti.length ? `<button class="small wa" id="c-wa">💬 Sollecito / consegna</button>` : ""}
      <button class="small wa" id="c-wa-libero">💬 Scrivi</button></div>` : ""}
    ${storico.length ? `<div class="section-title">Acquisti</div><table>${storico.map(({ o, r }) =>
      `<tr><td>${dataIt(o.data)}</td><td>${esc(r.prodotti)}${r.clienteId === STORICO ? ` <span class="muted">(ordine di gruppo)</span>` : ""}</td>
       <td class="num">${r.clienteId === STORICO ? "" : euro(r.importo)}</td></tr>`).join("")}</table>` : ""}
    <div class="modal-actions">
      ${c ? `<button class="danger" id="c-del">Elimina</button>` : "<span></span>"}
      <span><button id="c-cancel">Annulla</button> <button class="primary" id="c-save">Salva</button></span>
    </div>`;
  const correnti = () => ({ ...c, telefono: $("#c-tel").value.trim(), nome: $("#c-nome").value.trim() });
  $("#c-wa")?.addEventListener("click", () => apriWhatsApp(correnti(), messaggioCliente(correnti(), pendenti)));
  $("#c-wa-libero")?.addEventListener("click", () => apriWhatsApp(correnti(), `Ciao ${primoNome(correnti())}! `));
  $("#c-cancel").addEventListener("click", () => $("#modal").close());
  $("#c-save").addEventListener("click", async () => {
    const nome = $("#c-nome").value.trim(); if (!nome) return alert("Inserisci il nome.");
    const dati = { nome, telefono: $("#c-tel").value.trim(), note: $("#c-note").value };
    if (c) await setDoc(doc(col("clienti"), c.id), dati, { merge: true }); else await addDoc(col("clienti"), dati);
    $("#modal").close();
  });
  $("#c-del")?.addEventListener("click", async () => {
    if (storico.some(x => x.r.clienteId === c.id)) return alert("Questo cliente ha acquisti registrati: non si può eliminare.");
    if (confirm("Eliminare il cliente?")) { await deleteDoc(doc(col("clienti"), c.id)); $("#modal").close(); }
  });
  $("#modal").showModal();
}

// ---------- Vista: Omaggi ----------
function renderOmaggi() {
  const g = giacenzaOmaggi(ordini, movimenti);
  const ricevuti = g.reduce((s, v) => s + v.ricevuti + Math.max(0, v.rettifiche), 0);
  const dati = g.reduce((s, v) => s + v.dati, 0);
  let html = `<div class="kpis"><div class="kpi"><div class="v">${ricevuti}</div><div class="l">Ricevuti</div></div>
    <div class="kpi"><div class="v">${dati}</div><div class="l">Dati ai clienti</div></div></div>`;
  if (!g.length) html += `<div class="empty">Nessun omaggio registrato. Aggiungili negli ordini (“Omaggi ricevuti” e “Omaggi dati al cliente”) oppure con “+ Movimento”.</div>`;
  else html += `<div class="card" style="margin-top:12px"><table>
      <tr><th>Omaggio</th><th class="num">Ricevuti</th><th class="num">Dati</th><th class="num">Rimasti</th></tr>
      ${g.map(v => `<tr><td>${esc(v.nome)}</td><td class="num">${v.ricevuti + (v.rettifiche > 0 ? v.rettifiche : 0)}</td>
        <td class="num">${v.dati + (v.rettifiche < 0 ? -v.rettifiche : 0)}</td>
        <td class="num ${v.giacenza < 0 ? "neg" : ""}"><b>${v.giacenza}</b></td></tr>`).join("")}
    </table></div>
    ${g.some(v => v.giacenza < 0) ? `<div class="hint">In rosso: ne risultano dati più di quanti ricevuti. Correggi con “+ Movimento”.</div>` : ""}`;
  if (movimenti.length) {
    html += `<div class="section-title">Movimenti manuali</div><div class="card"><table>
      ${[...movimenti].sort((a, b) => (b.data || "").localeCompare(a.data || "")).map(m => `<tr data-mov="${m.id}" style="cursor:pointer">
        <td>${dataIt(m.data)}</td><td>${esc(m.nome)}${m.nota ? ` <span class="muted">· ${esc(m.nota)}</span>` : ""}</td>
        <td class="num">${m.qta > 0 ? "+" : ""}${m.qta}</td></tr>`).join("")}</table></div>`;
  }
  $("#view").innerHTML = html;
  $$("[data-mov]").forEach(el => el.addEventListener("click", () => apriMovimento(movimenti.find(m => m.id === el.dataset.mov))));
}

function apriMovimento(m) {
  $("#modal-body").innerHTML = `
    <h2 style="margin-top:0">${m ? "Modifica movimento" : "Movimento omaggi"}</h2>
    <div class="hint">Per omaggi ricevuti o dati fuori dagli ordini, o per correggere la giacenza.</div>
    <label>Omaggio</label><input id="mv-nome" list="dl-omaggi" value="${esc(m?.nome)}">
    <div class="grid2">
      <div><label>Tipo</label><select id="mv-tipo"><option value="1" ${!m || m.qta > 0 ? "selected" : ""}>Ricevuti (+)</option>
        <option value="-1" ${m && m.qta < 0 ? "selected" : ""}>Dati / usati (−)</option></select></div>
      <div><label>Quantità</label><input id="mv-qta" type="number" min="1" inputmode="numeric" value="${m ? Math.abs(m.qta) : 1}"></div>
    </div>
    <label>Data</label><input id="mv-data" type="date" value="${esc(m?.data || oggi())}">
    <label>Nota</label><input id="mv-nota" value="${esc(m?.nota)}">
    <div class="modal-actions">
      ${m ? `<button class="danger" id="mv-del">Elimina</button>` : "<span></span>"}
      <span><button id="mv-cancel">Annulla</button> <button class="primary" id="mv-save">Salva</button></span>
    </div>`;
  $("#mv-cancel").addEventListener("click", () => $("#modal").close());
  $("#mv-del")?.addEventListener("click", async () => { await deleteDoc(doc(col("movimentiOmaggi"), m.id)); $("#modal").close(); });
  $("#mv-save").addEventListener("click", async () => {
    const nome = $("#mv-nome").value.trim(); if (!nome) return alert("Inserisci il nome dell'omaggio.");
    const dati = { nome, qta: (parseInt($("#mv-qta").value) || 1) * Number($("#mv-tipo").value), data: $("#mv-data").value || oggi(), nota: $("#mv-nota").value };
    if (m) await setDoc(doc(col("movimentiOmaggi"), m.id), dati); else await addDoc(col("movimentiOmaggi"), dati);
    $("#modal").close();
  });
  $("#modal").showModal();
}

// ---------- Vista: Riepilogo ----------
function renderRiepilogo() {
  const mesi = [...new Set(ordini.map(o => (o.data || "").slice(0, 7)).filter(Boolean))].sort().reverse();
  if (!mesi.includes(meseSel) && mesi.length) meseSel = mesi[0];
  const anno = meseSel.slice(0, 4);
  const m = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(meseSel)));
  const a = riepilogoPeriodo(ordini.filter(o => (o.data || "").startsWith(anno)));
  const nomeMese = (k) => new Date(k + "-01T00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" });

  $("#view").innerHTML = `
    <select id="sel-mese">${(mesi.length ? mesi : [meseSel]).map(k => `<option value="${k}" ${k === meseSel ? "selected" : ""}>${nomeMese(k)}</option>`).join("")}</select>
    <div class="kpis" style="margin-top:12px">
      <div class="kpi"><div class="v num ${m.guadagnoAtteso < 0 ? "neg" : "pos"}">${euro(m.guadagnoAtteso)}</div><div class="l">Guadagno del mese</div></div>
      <div class="kpi"><div class="v num">${euro(m.daIncassare)}</div><div class="l">Ancora da incassare</div></div>
      <div class="kpi"><div class="v num">${euro(m.venditaClienti)}</div><div class="l">Venduto ai clienti</div></div>
      <div class="kpi"><div class="v num">${euro(m.quotaIo)}</div><div class="l">Speso per me</div></div>
    </div>
    <div class="section-title">Anno ${anno}</div>
    <div class="card"><table>
      <tr><td>Ordini</td><td class="num">${a.ordini}</td></tr>
      <tr><td>Venduto ai clienti</td><td class="num">${euro(a.venditaClienti)}</td></tr>
      <tr><td>Pagato a Yves Rocher</td><td class="num">${euro(a.costo)}</td></tr>
      <tr><td>di cui per me</td><td class="num">${euro(a.quotaIo)}</td></tr>
      <tr><td><b>Guadagno</b></td><td class="num"><b class="${a.guadagnoAtteso < 0 ? "neg" : "pos"}">${euro(a.guadagnoAtteso)}</b></td></tr>
      <tr><td>Ancora da incassare</td><td class="num">${euro(a.daIncassare)}</td></tr>
    </table></div>

    <div class="section-title">Impostazioni</div>
    <div class="card">
      <label style="margin-top:0">Ricontatta i clienti che non comprano da</label>
      <select id="set-giorni">${[[0, "Mai"], [30, "1 mese"], [45, "45 giorni"], [60, "2 mesi"], [90, "3 mesi"], [120, "4 mesi"]]
        .map(([v, t]) => `<option value="${v}" ${Number(impostazioni.giorniRicontatto) === v ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>

    <div class="section-title">Dati</div>
    <div class="stack">
      <button id="btn-import">Importa il vecchio file Excel</button>
      <button id="btn-export">Esporta in Excel (CSV)</button>
      <button id="btn-backup">Scarica backup completo${impostazioni.ultimoBackup ? ` <span class="muted">(ultimo ${dataIt(impostazioni.ultimoBackup)})</span>` : ""}</button>
      <button id="btn-restore">Ripristina da backup</button>
    </div>
    <input type="file" id="file-import" accept=".xlsx,.xls,.csv,.numbers" class="hidden">
    <input type="file" id="file-restore" accept=".json,application/json" class="hidden">
    <button id="btn-logout" class="link" style="width:100%;margin-top:20px">Esci (${esc(auth.currentUser?.email)})</button>`;
  $("#sel-mese").addEventListener("change", e => { meseSel = e.target.value; renderRiepilogo(); });
  $("#set-giorni").addEventListener("change", e => setDoc(docImpostazioni(), { giorniRicontatto: Number(e.target.value) }, { merge: true }));
  $("#btn-export").addEventListener("click", esportaCsv);
  $("#btn-backup").addEventListener("click", scaricaBackup);
  $("#btn-restore").addEventListener("click", () => $("#file-restore").click());
  $("#file-restore").addEventListener("change", e => { if (e.target.files[0]) ripristinaBackup(e.target.files[0]); e.target.value = ""; });
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", e => { if (e.target.files[0]) importaExcel(e.target.files[0]); e.target.value = ""; });
  $("#btn-logout").addEventListener("click", () => signOut(auth));
}

function esportaCsv() {
  // CSV con ; e BOM: si apre correttamente in Excel italiano
  const n = (x) => (Number(x) || 0).toFixed(2).replace(".", ",");
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const righe = [["Data ordine", "Cliente", "Prodotti", "Omaggi dati", "Importo", "Pagato", "Consegnato", "Costo ordine", "Spesa per me", "Guadagno ordine"].join(";")];
  for (const o of [...ordini].reverse()) {
    const c = calcolaOrdine(o);
    (o.righe || []).forEach((r, i) => righe.push([dataIt(o.data), q(nomeRiga(r)), q(r.prodotti), q([listaOmaggi(r.omaggiDati), r.omaggio].filter(Boolean).join(", ")),
      n(r.importo), r.pagato ? "sì" : "no", r.consegnato ? "sì" : "no",
      i === 0 ? n(o.costo) : "", i === 0 ? n(c.quotaIo) : "", i === 0 ? n(c.guadagnoAtteso) : ""].join(";")));
  }
  scarica(new Blob(["﻿" + righe.join("\n")], { type: "text/csv;charset=utf-8" }), `ordini-${oggi()}.csv`);
}

// ---------- Import del vecchio Excel ----------
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
    const foglio = wb.Sheets[wb.SheetNames[0]];
    risultato = convertiFoglio(XLSX.utils.sheet_to_json(foglio, { header: 1, raw: true, defval: null }));
  } catch (err) { return alert("Non riesco a leggere il file: " + err.message); }

  const { ordini: nuovi, nomiClienti, scartate } = risultato;
  if (!nuovi.length) return alert("Nel file non ho trovato ordini da importare.");
  const giaImportati = ordini.filter(o => o.importato).length;
  const nuoviNomi = nomiClienti.filter(n => !clienti.some(c => chiave(c.nome) === chiave(n)));
  const tot = riepilogoPeriodo(nuovi);
  const guadagnoFile = nuovi.reduce((s, o) => s + o._controllo.entrate - o._controllo.uscite, 0);

  $("#modal-body").innerHTML = `
    <h2 style="margin-top:0">Importa da Excel</h2>
    ${giaImportati ? `<div class="card banner">Hai già importato ${giaImportati} ordini. Se importi di nuovo lo stesso file, saranno duplicati.</div>` : ""}
    <table>
      <tr><td>Ordini trovati</td><td class="num">${nuovi.length}</td></tr>
      <tr><td>Periodo</td><td class="num">${dataIt(nuovi.map(o => o.data).sort()[0])} – ${dataIt(nuovi.map(o => o.data).sort().pop())}</td></tr>
      <tr><td>Clienti nuovi da creare</td><td class="num">${nuoviNomi.length}</td></tr>
      <tr><td>Guadagno secondo il vecchio file</td><td class="num">${euro(guadagnoFile)}</td></tr>
      <tr><td><b>Guadagno reale</b> (senza i tuoi acquisti)</td><td class="num"><b class="${tot.guadagnoAtteso < 0 ? "neg" : "pos"}">${euro(tot.guadagnoAtteso)}</b></td></tr>
      <tr><td>Speso per te</td><td class="num">${euro(tot.quotaIo)}</td></tr>
    </table>
    ${scartate.length ? `<div class="hint">Righe saltate: ${scartate.map(s => `${s.riga} (${s.motivo})`).join(", ")}</div>` : ""}
    <div class="hint" style="margin-top:10px">Gli ordini con più clienti restano “di gruppo”: il file non dice quanto ha speso ciascuno.
      Tutti gli ordini importati risultano pagati e consegnati.</div>
    <div class="modal-actions"><span></span>
      <span><button id="imp-cancel">Annulla</button> <button class="primary" id="imp-ok">Importa</button></span></div>`;
  $("#imp-cancel").addEventListener("click", () => $("#modal").close());
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
    try { await scriviABlocchi(ops); $("#modal").close(); alert(`Importati ${nuovi.length} ordini e ${nuoviNomi.length} clienti.`); }
    catch (err) { alert("Errore durante l'importazione: " + err.message); $("#imp-ok").disabled = false; $("#imp-ok").textContent = "Importa"; }
  });
  $("#modal").showModal();
}

// ---------- PWA ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
