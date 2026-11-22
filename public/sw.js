const CACHE_NAME = "convo-shell-v3";
const APP_SHELL = ["/auth", "/manifest.json", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  if (url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/images/users/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request)) || caches.match("/auth"))
    );
    return;
  }

  const isStaticAsset = url.pathname.startsWith("/_next/static/") ||
    /\.(?:css|js|svg|png|jpg|webp|woff2?)$/i.test(url.pathname);
  if (!isStaticAsset) return;

  event.respondWith(caches.match(request).then(async (cached) => {
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  }));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "You have a new message." };
  }
  event.waitUntil((async () => {
    const unreadCount = Number(payload.badge);
    if (Number.isFinite(unreadCount)) {
      try {
        if (unreadCount > 0 && typeof self.navigator.setAppBadge === "function") {
          await self.navigator.setAppBadge(unreadCount);
        } else if (unreadCount === 0 && typeof self.navigator.clearAppBadge === "function") {
          await self.navigator.clearAppBadge();
        }
      } catch (error) {
        console.warn("Unable to update the app unread badge:", error);
      }
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // the app is open and in front: it shows the message itself
    if (windows.some((client) => client.focused && client.visibilityState === "visible")) return;
    await self.registration.showNotification(payload.title || "New message", {
      body: payload.body || "You have a new message.",
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      silent: false,
      tag: payload.tag || "convo-message",
      vibrate: [120, 60, 120],
      timestamp: Date.now(),
      data: { url: payload.url || "/", ticket: payload.ticket || "", isGroup: payload.isGroup ? 1 : 0 },
    });
  })());
});

// Tapping a notification opens that chat: in the open app if there is one, otherwise in a new window.
// (Signed out: the app sends the user to sign in and back to this chat afterwards.)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const opened = event.notification.data || {};
  // opening a chat clears every notification of that chat, not just the one tapped
  const closeSameChat = async () => {
    if (!opened.ticket) return;
    const all = await self.registration.getNotifications();
    all
      .filter((item) => item.data?.ticket === opened.ticket && item.data?.isGroup === opened.isGroup)
      .forEach((item) => item.close());
  };
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    await closeSameChat();
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) {
      try {
        await client.focus();
        client.postMessage({ type: "open-url", url: target.pathname + target.search });
        return;
      } catch {
        // could not reach that window: open a new one
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
