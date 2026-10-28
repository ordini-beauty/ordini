// Cache dell'interfaccia: l'app si apre anche senza rete (i dati li gestisce Firestore offline)
const CACHE = "ordini-v15";
const FILES = ["./", "index.html", "styles.css", "app.js", "calc.js", "importa.js", "firebase-config.js", "manifest.json", "icon.svg", "icon-180.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return; // Firebase e Worker vanno sempre in rete
  // Rete prima (aggiornamenti immediati), cache se offline
  e.respondWith(fetch(e.request).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; })
    .catch(() => caches.match(e.request)));
});

// ---------- Notifiche ----------
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { testo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titolo || "Ordini Beauty", {
    body: d.testo || "", icon: "icon-180.png", badge: "icon-180.png", tag: d.tag || undefined, data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(lista => {
    for (const c of lista) if (c.url.startsWith(self.registration.scope)) return c.focus();
    return self.clients.openWindow(url);
  }));
});
