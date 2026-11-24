import { useEffect, useRef } from "react";

// history.back() is asynchronous; anything that must push a new entry right after a dialog/tab layer is
// dropped has to wait until that traversal has finished, or the new entry gets popped instead.
export function dropHistoryEntry() {
  window.__convoIgnoreNextPop = true;
  window.__convoBackPending = true;
  const settle = () => {
    window.__convoBackPending = false;
    window.removeEventListener("popstate", settle);
    (window.__convoAfterBack || []).splice(0).forEach((fn) => fn());
  };
  window.addEventListener("popstate", settle);
  window.history.back();
  // if no popstate ever arrives, do not block later pushes forever
  setTimeout(() => { if (window.__convoBackPending) settle(); }, 500);
}

export function afterHistorySettles(fn) {
  if (!window.__convoBackPending) { fn(); return () => {}; }
  const queue = (window.__convoAfterBack ||= []);
  queue.push(fn);
  return () => {
    const at = queue.indexOf(fn);
    if (at >= 0) queue.splice(at, 1);
  };
}

// While a dialog is open, the phone's Back button closes it (the top-most one, if several are open) instead of
// leaving the chat or asking to close the app. Closing a dialog another way removes its history entry.
export default function useBackToClose(isOpen, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") return;
    const stack = (window.__convoDialogStack ||= []);
    const me = {};
    stack.push(me);
    const depth = stack.length;
    window.__convoModalDepth = depth;
    // wait for any history.back() still on its way (a layer closed a moment ago), or it would pop this new entry
    let pushed = false;
    let cancelled = false;
    const cancelWait = afterHistorySettles(() => {
      if (cancelled) return;
      pushed = true;
      window.history.pushState({ ...(window.history.state || {}), dialogDepth: depth }, "", window.location.href);
    });
    const onPop = () => {
      if (stack[stack.length - 1] === me) closeRef.current?.();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      cancelled = true;
      cancelWait();
      window.removeEventListener("popstate", onPop);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      window.__convoModalDepth = stack.length;
      // closed with a button (or after saving): drop our own history entry without the app reacting to it
      if (pushed && window.history.state?.dialogDepth === depth) dropHistoryEntry();
    };
  }, [isOpen]);
}
