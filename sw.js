self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("loader-message-")).map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});
