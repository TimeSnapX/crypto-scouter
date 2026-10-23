// Network-first app shell. API calls (any other origin, or feed.json) are never cached.
// WebSockets (PumpPortal Launch Feed) never pass through a service worker, and are never cached.
const VERSION = "scouter-v3";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "src/app.js", "src/api.js", "src/score.js", "src/config.js", "src/launch.js", "src/best.js", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "js/install.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith(new URL(self.registration.scope).pathname) || u.pathname.endsWith(".json")) return; // network only, browser default
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { if (r.ok && r.type === "basic") { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => cs[0] ? cs[0].focus() : self.clients.openWindow("./"))); });
