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

    const callData = {
      url: payload.url || "/",
      ticket: payload.ticket || "",
      isGroup: payload.isGroup ? 1 : 0,
      callId: payload.callId || "",
      callerId: payload.callerId || "",
      isVideo: payload.isVideo ? 1 : 0,
      socketUrl: payload.socketUrl || "",
    };

    // ringing: Accept / Reject buttons; stays until answered, declined or the call is cancelled
    if (payload.type === "call-ring") {
      await self.registration.showNotification(payload.title || "Incoming call", {
        body: payload.body || "Someone is calling you.",
        icon: "/icons/icon.svg",
        badge: "/icons/icon.svg",
        silent: false,
        tag: payload.tag || "convo-call-ring",
        renotify: true,
        requireInteraction: true,
        vibrate: [400, 200, 400, 200, 400, 200, 400],
        timestamp: Date.now(),
        actions: [
          { action: "accept", title: "Accept" },
          { action: "reject", title: "Reject" },
        ],
        data: { ...callData, kind: "call-ring" },
      });
      return;
    }

    // missed: the ringing notification of that call goes away, replaced by "Missed call" with a Call Back button
    if (payload.type === "call-missed") {
      if (payload.ringCallId) {
        const rings = await self.registration.getNotifications({ tag: `ring-${payload.ringCallId}` });
        rings.forEach((item) => item.close());
      }
      await self.registration.showNotification(payload.title || "Missed call", {
        body: payload.body || "You missed a call.",
        icon: "/icons/icon.svg",
        badge: "/icons/icon.svg",
        silent: false,
        tag: payload.tag || "convo-call-missed",
        vibrate: [120, 60, 120],
        timestamp: Date.now(),
        actions: [{ action: "callback", title: "Call Back" }],
        data: { ...callData, kind: "call-missed" },
      });
      return;
    }

    await self.registration.showNotification(payload.title || "New message", {
      body: payload.body || "You have a new message.",
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      silent: false,
      tag: payload.tag || "convo-message",
      vibrate: [120, 60, 120],
      timestamp: Date.now(),
      // like WhatsApp: Reply (typed right in the notification where the phone supports it), Mark as read, Mute
      actions: payload.ticket ? [
        { action: "reply", title: "Reply", type: "text", placeholder: "Type a reply" },
        { action: "mark-read", title: "Mark as read" },
        { action: "mute", title: "Mute" },
      ] : [],
      data: {
        url: payload.url || "/",
        ticket: payload.ticket || "",
        isGroup: payload.isGroup ? 1 : 0,
        kind: "message",
        socketUrl: payload.socketUrl || "",
      },
    });
  })());
});

// Reply / Mark as read / Mute straight from a message notification, without opening the app. Everything goes through
// the app's own API (same session cookie); the socket server is then told, so people with the app open see it live.
async function relayToSocketServer(data, kind, payload) {
  if (!data.socketUrl) return;
  try {
    const tokenResponse = await fetch("/api/socket-token", { cache: "no-store" });
    const { token } = await tokenResponse.json();
    if (!token) return;
    await fetch(`${data.socketUrl}/sw-relay`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token, kind, payload }),
    });
  } catch {
    // the other side sees it on its next refresh
  }
}

async function runMessageAction(action, data, reply) {
  const ticket = data.ticket;
  const isGroup = data.isGroup ? 1 : 0;
  if (action === "reply") {
    const text = String(reply || "").trim();
    if (!text) return false;
    const response = await fetch("/api/messages", {
      method: "POST",
      body: JSON.stringify({ message: text, receiver_id: ticket, is_group: isGroup, type: "text" }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) return false;
    await relayToSocketServer(data, "message", result.data);
    // reading the chat to reply means the earlier messages are read too
    await runMessageAction("mark-read", data);
    return true;
  }
  if (action === "mark-read") {
    const response = await fetch(`/api/messages?ref_id=${encodeURIComponent(ticket)}&is_group=${isGroup}`, { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) return false;
    for (const event of result.seen_events || []) await relayToSocketServer(data, "seen", event);
    return true;
  }
  if (action === "mute") {
    const response = await fetch("/api/conversations/preferences", {
      method: "POST",
      body: JSON.stringify({ conversation_id: ticket, is_group: isGroup, action: "mute" }),
    });
    const result = await response.json().catch(() => ({}));
    return response.ok && result.success;
  }
  return false;
}

// Tapping a notification opens that chat: in the open app if there is one, otherwise in a new window.
// (Signed out: the app sends the user to sign in and back to this chat afterwards.)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const opened = event.notification.data || {};
  const findWindow = async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return windows.find((item) => new URL(item.url).origin === self.location.origin);
  };

  // buttons on message notifications: done right here, the app is not opened. (A Reply button that shows no text box
  // on this phone has nothing typed: it falls through to opening the chat, like tapping the notification.)
  const typedReply = String(event.reply || "").trim();
  if (opened.kind === "message" && (event.action === "mark-read" || event.action === "mute" || (event.action === "reply" && typedReply))) {
    event.waitUntil((async () => {
      let done = false;
      try {
        done = await runMessageAction(event.action, opened, typedReply);
      } catch {
        done = false;
      }
      if (!done) {
        if (event.action === "reply") {
          await self.registration.showNotification("Reply not sent", {
            body: "Tap to open the chat and send it there.",
            icon: "/icons/icon.svg",
            badge: "/icons/icon.svg",
            tag: `reply-failed-${opened.ticket}`,
            data: { url: opened.url || "/", ticket: opened.ticket, isGroup: opened.isGroup },
          });
        }
        return;
      }
      // this chat's notifications go away; the app icon count drops when nothing is left
      const shown = await self.registration.getNotifications();
      shown
        .filter((item) => item.data?.ticket === opened.ticket && item.data?.isGroup === opened.isGroup)
        .forEach((item) => item.close());
      const remaining = shown.filter((item) => item.data?.ticket !== opened.ticket || item.data?.isGroup !== opened.isGroup);
      if (!remaining.length && typeof self.navigator.clearAppBadge === "function") {
        try { await self.navigator.clearAppBadge(); } catch { /* not supported here */ }
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      windows.forEach((client) => client.postMessage({ type: "refresh-conversations" }));
    })());
    return;
  }

  // buttons on call notifications. The open app answers them straight away (no reload, the call is not
  // disturbed); when the app is closed it is opened with the action in the address, and applies it as soon
  // as the call reaches it.
  if (event.action === "hangup") {
    event.waitUntil((async () => {
      const client = await findWindow();
      client?.postMessage({ type: "call-action", action: "hangup" });
    })());
    return;
  }
  if (event.action === "accept" || event.action === "reject") {
    event.waitUntil((async () => {
      const message = { type: "call-action", action: event.action, callId: opened.callId, callerId: opened.callerId };
      const client = await findWindow();
      if (client) {
        try {
          if (event.action === "accept") await client.focus();
          client.postMessage(message);
          return;
        } catch {
          // could not reach that window: open a new one
        }
      }
      // app closed: decline straight from here without opening it; only open the app if that did not work
      if (event.action === "reject" && opened.socketUrl && opened.callId) {
        try {
          const tokenResponse = await fetch("/api/socket-token", { cache: "no-store" });
          const { token } = await tokenResponse.json();
          if (token) {
            const declined = await fetch(`${opened.socketUrl}/call-reject`, {
              method: "POST",
              headers: { "Content-Type": "text/plain" },
              body: JSON.stringify({ token, callId: opened.callId, callerId: opened.callerId }),
            });
            if (declined.ok) return;
          }
        } catch {
          // fall through: open the app and decline there
        }
      }
      const params = new URLSearchParams({
        callAction: event.action,
        callId: opened.callId || "",
        callerId: opened.callerId || "",
      });
      await self.clients.openWindow(`/?${params.toString()}`);
    })());
    return;
  }
  if (event.action === "callback") {
    event.waitUntil((async () => {
      const message = {
        type: "call-action",
        action: "callback",
        ticket: opened.ticket,
        isGroup: opened.isGroup,
        isVideo: opened.isVideo,
      };
      const client = await findWindow();
      if (client) {
        try {
          await client.focus();
          client.postMessage(message);
          return;
        } catch {
          // could not reach that window: open a new one
        }
      }
      const params = new URLSearchParams({
        ticket: opened.ticket || "",
        is_group: opened.isGroup ? "1" : "0",
        callback: opened.isVideo ? "video" : "voice",
      });
      await self.clients.openWindow(`/?${params.toString()}`);
    })());
    return;
  }
  // tapping the ringing / in-call notification itself just brings the app forward; reloading it would drop the call
  if (opened.kind === "call-ring" || opened.kind === "call-active") {
    event.waitUntil((async () => {
      const client = await findWindow();
      if (client) {
        try { await client.focus(); return; } catch { /* open a new one */ }
      }
      await self.clients.openWindow("/");
    })());
    return;
  }
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
