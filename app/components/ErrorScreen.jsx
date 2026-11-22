"use client";

import { useEffect } from "react";
import { isAuth } from "../helpers/helper";

// Shown instead of the bare "Application error" page: it says what failed (so it can be fixed),
// and when the person is signed out (e.g. right after logging out) it simply goes to the sign-in page.
export default function ErrorScreen({ error }) {
  useEffect(() => {
    console.error("App error:", error);
    try {
      if (window.location.pathname === "/auth" || isAuth()) return;
      const last = Number(window.sessionStorage.getItem("convo-error-redirect") || 0);
      if (Date.now() - last < 5000) return; // never loop
      window.sessionStorage.setItem("convo-error-redirect", String(Date.now()));
      window.location.replace("/auth");
    } catch {
      // storage blocked: just show the message below
    }
  }, [error]);

  const detail = [error?.message, error?.digest ? `digest ${error.digest}` : ""].filter(Boolean).join(" · ");
  const stack = String(error?.stack || "").split("\n").slice(0, 4).join("\n");

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#090d17", color: "#e8edf7", fontFamily: "Arial, sans-serif" }}>
      <div style={{ width: "min(100%, 460px)", textAlign: "center" }}>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
        <p style={{ margin: "0 0 16px", color: "#91a0b7", fontSize: 14 }}>The page could not be shown. Reload to try again.</p>
        {detail && (
          <pre style={{ margin: "0 0 16px", padding: 12, borderRadius: 10, background: "#111827", color: "#fca5a5", fontSize: 12, textAlign: "left", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {detail}
            {stack ? `\n${stack}` : ""}
          </pre>
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: "10px 18px", borderRadius: 10, border: 0, background: "#6366f1", color: "white", fontSize: 14 }}>Reload</button>
          <button type="button" onClick={() => window.location.replace("/auth")} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #334155", background: "transparent", color: "#e8edf7", fontSize: 14 }}>Sign in</button>
        </div>
      </div>
    </main>
  );
}
