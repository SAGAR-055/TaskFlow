const CACHE_NAME = "taskflow-v1";
const APP_SHELL_URL = new URL("./", self.registration.scope).toString();

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.add(APP_SHELL_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(
        cacheNames
          .filter(cacheName => cacheName.startsWith("taskflow-") && cacheName !== CACHE_NAME)
          .map(cacheName => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        } catch (error) {
          console.error("TaskFlow could not cache a resource for offline use.", error);
        }
      }
      return response;
    } catch (error) {
      const cachedResponse = await caches.match(request);
      if (cachedResponse) return cachedResponse;
      if (request.mode === "navigate") {
        const appShell = await caches.match(APP_SHELL_URL);
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
