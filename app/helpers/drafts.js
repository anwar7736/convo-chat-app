// Unsent message text, kept per conversation in this browser (per signed-in person), like WhatsApp's "Draft:".
const STORAGE_KEY = "chat-drafts";

export const draftKey = (authId, conversation) =>
  authId && conversation?._id
    ? `${authId}:${Number(conversation.is_group) === 1 ? 1 : 0}:${conversation._id}`
    : "";

function readAll() {
  if (typeof window === "undefined") return {};
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

export const getDraft = (key) => (key ? String(readAll()[key] || "") : "");

export const getAllDrafts = () => readAll();

export function setDraft(key, text) {
  if (!key || typeof window === "undefined") return;
  const all = readAll();
  const value = String(text || "");
  if (value.trim()) {
    if (all[key] === value) return;
    all[key] = value;
  } else {
    if (!(key in all)) return;
    delete all[key];
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    return; // storage full or blocked: the draft is simply not kept
  }
  window.dispatchEvent(new Event("chat:drafts-changed"));
}
