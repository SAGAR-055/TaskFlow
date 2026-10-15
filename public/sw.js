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

self.addEventListener("push", event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (error) {
    console.error("TaskFlow received an unreadable push notification.", error);
    return;
  }

  const data = payload.data || payload;
  const title = data.title;
  if (typeof title !== "string" || !title) {
    console.error("TaskFlow received a push notification without a title.");
    return;
  }

  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: new URL("Icon-192.png", self.registration.scope).toString(),
    badge: new URL("Icon-192.png", self.registration.scope).toString(),
    tag: typeof data.id === "string" ? data.id : undefined,
    data: {
      url: typeof data.url === "string" ? data.url : self.registration.scope,
      notification: data,
    },
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      clients.forEach(client => client.postMessage({ type: "taskflow-push", notification: data }));
    }),
  ]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const requestedUrl = event.notification.data && event.notification.data.url;
  const targetUrl = new URL(typeof requestedUrl === "string" ? requestedUrl : self.registration.scope);

  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    const existingClient = clients.find(client => new URL(client.url).origin === targetUrl.origin);
    if (existingClient) {
      await existingClient.navigate(targetUrl.toString());
      return existingClient.focus();
    }
    return self.clients.openWindow(targetUrl.toString());
  }));
});
