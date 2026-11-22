import { useEffect, useRef } from "react";

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
    window.history.pushState({ ...(window.history.state || {}), dialogDepth: depth }, "", window.location.href);
    const onPop = () => {
      if (stack[stack.length - 1] === me) closeRef.current?.();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const at = stack.indexOf(me);
      if (at >= 0) stack.splice(at, 1);
      window.__convoModalDepth = stack.length;
      // closed with a button (or after saving): drop our own history entry without the app reacting to it
      if (window.history.state?.dialogDepth === depth) {
        window.__convoIgnoreNextPop = true;
        window.history.back();
      }
    };
  }, [isOpen]);
}
