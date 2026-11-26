"use client";

import { useEffect } from "react";

export default function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });

    // a tapped notification asks the open app to show that chat (?ticket=…); signed out, sign-in comes first
    const onMessage = (event) => {
      // Accept / Reject / Hang Up / Call Back buttons on call notifications: the call screen handles them
      if (event.data?.type === "call-action") {
        window.dispatchEvent(new CustomEvent("chat:call-action", { detail: event.data }));
        return;
      }
      if (event.data?.type === "refresh-conversations") {
        window.dispatchEvent(new Event("chat:refresh-conversations"));
        return;
      }
      const url = event.data?.type === "open-url" ? String(event.data.url || "") : "";
      if (url.startsWith("/") && !url.startsWith("//")) {
        window.__convoLoggingOut = true; // this reload is deliberate: no "leave site?" prompt
        window.location.assign(url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return null;
}
