// Cache dell'interfaccia: l'app si apre anche senza rete (i dati li gestisce Firestore offline)
const CACHE = "ordini-v6";
const FILES = ["./", "index.html", "styles.css", "app.js", "calc.js", "importa.js", "firebase-config.js", "manifest.json", "icon.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Firebase va sempre in rete
  // Rete prima (aggiornamenti immediati), cache se offline
  e.respondWith(fetch(e.request).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; })
    .catch(() => caches.match(e.request)));
});
