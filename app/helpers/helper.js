import mongoose from "mongoose";
import { io } from "socket.io-client";
import { connectionStr } from "../lib/db";
export const mongoDB_connect = async () => {
  if (!connectionStr) {
    throw new Error("Set MONGODB_URI or DB_DATABASE, DB_USERNAME, and DB_PASSWORD.");
  }
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!mongooseConnection) {
    mongooseConnection = mongoose
      // each serverless instance keeps its own pool; small pools keep many instances under the database's connection limit
      .connect(connectionStr, {
        maxPoolSize: Number(process.env.MONGODB_POOL_SIZE) || 10,
        maxIdleTimeMS: 60000,
        serverSelectionTimeoutMS: 10000,
      })
      .catch((error) => {
        mongooseConnection = null;
        throw error;
      });
  }
  return mongooseConnection;
};

let mongooseConnection;

export const auth = () => {
  if (typeof window === "undefined") return "";
  try {
    return JSON.parse(window.localStorage.getItem("auth-profile") || '""');
  } catch (error) {
    console.error("Unable to read the signed-in profile:", error);
    return "";
  }
};

export const isAuth = () => {
  return Boolean(auth()?._id);
};

export const setAuthProfile = (user) => {
  if (typeof window !== "undefined") {
    window.localStorage.setItem("auth-profile", JSON.stringify(user));
  }
};

export const clearAuthProfile = () => {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("auth-profile");
    // the saved copies of the chat and call lists belong to the signed-out person
    try {
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith("convo-cache-"))
        .forEach((key) => window.localStorage.removeItem(key));
    } catch {
      // storage unavailable: nothing to clear
    }
  }
};

// last good copy of a list (chats, calls), shown at once while the fresh one loads
export const readListCache = (name, userId) => {
  try {
    const raw = window.localStorage.getItem(`convo-cache-${name}-${userId}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
export const writeListCache = (name, userId, list) => {
  try {
    window.localStorage.setItem(`convo-cache-${name}-${userId}`, JSON.stringify(list));
  } catch {
    // storage full or unavailable: the app just loads normally next time
  }
};

export const causer_id = () => {
  return isAuth() ? auth()?._id : null;
};

export const dateFormat = (date) => {
  if (date) {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } else return "";
};

export const dateTimeFormat = (date) => {
  if (date) {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } else return "";
};

export const activityFormat = (date, now = Date.now()) => {
  const timestamp = date ? new Date(date).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (minutes < 1) return "Active just now";
  if (minutes === 1) return "Active a minute ago";
  if (minutes < 60) return `Active ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "Active an hour ago";
  if (hours < 24) return `Active ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Active a day ago";
  if (days < 365) return `Active ${days} days ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "Active a year ago" : `Active ${years} years ago`;
};

const playGeneratedReminder = () => {
  if (typeof window === "undefined") return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  try {
    const context = new AudioContext();
    const play = () => {
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.connect(context.destination);
      // a bright two-note "ding-dong" like a chat app: a bell-like tone (fundamental + overtones) that rings out
      const notes = [{ frequency: 988, start: 0 }, { frequency: 1319, start: 0.17 }];
      const partials = [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.35 }, { ratio: 3, level: 0.12 }];
      for (const note of notes) {
        const start = context.currentTime + note.start;
        for (const { ratio, level } of partials) {
          const oscillator = context.createOscillator();
          const partialGain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = note.frequency * ratio;
          oscillator.connect(partialGain);
          partialGain.connect(gain);
          partialGain.gain.setValueAtTime(0.0001, start);
          partialGain.gain.exponentialRampToValueAtTime(0.5 * level, start + 0.012);
          partialGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
          oscillator.start(start);
          oscillator.stop(start + 0.52);
        }
      }
      gain.gain.setValueAtTime(1, context.currentTime);
      window.setTimeout(() => context.close().catch(() => {}), 900);
    };
    if (context.state === "suspended") {
      context.resume().then(play).catch((error) => {
        console.warn("Unable to play the message reminder sound:", error);
        context.close().catch(() => {});
      });
    } else {
      play();
    }
  } catch (error) {
    console.warn("Unable to play the message reminder sound:", error);
  }
};

let socketInstance;

export const socket_connection = () => {
  if (socketInstance) return socketInstance;
  socketInstance = io(
    process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3002",
    {
      transports: ["websocket", "polling"],
      autoConnect: false,
      auth: (callback) => {
        fetch("/api/socket-token", { cache: "no-store" })
          .then(async (response) => {
            const result = await response.json();
            if (!response.ok || !result.success || !result.token) {
              throw new Error(result.message || "Unable to authenticate the real-time connection.");
            }
            callback({ token: result.token });
          })
          .catch((error) => {
            console.error("Unable to authenticate the real-time connection:", error);
            callback({ token: "" });
          });
      },
    }
  );
  return socketInstance;
};

// photos uploaded by the app are stored in the database (random uuid names, see app/lib/profileImage.js)
const storedPhoto = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.(jpg|png|webp)$/i;

export const getImageURL = (imageName, type = null) => {
  if (imageName && !type && storedPhoto.test(imageName)) {
    return `/api/photos/${imageName}`;
  } else if (imageName) {
    return `.${type ? "/public" : ""}/images/users/${imageName}`;
  } else if (!imageName && !type) {
    return `./images/default.svg`;
  } else {
    return null;
  }
};

// A chat opens with its newest few messages (fast, like WhatsApp); scrolling up asks for more. The number loaded per
// chat is remembered, so every later refresh of that chat (new message, seen, delete) returns the same window and
// never throws away older messages already shown.
const FIRST_MESSAGE_WINDOW = 60;
const OLDER_MESSAGE_STEP = 100;
const messageWindows = new Map(); // "isGroup:id" -> { limit, hasMore }
const windowKey = (data) => `${Number(data?.is_group) === 1 ? 1 : 0}:${data?._id}`;

export const conversationHistoryState = (data) => ({
  hasMore: Boolean(messageWindows.get(windowKey(data))?.hasMore),
});

// the next, bigger window for this chat (call, then reload the timeline)
export const growConversationWindow = (data) => {
  const key = windowKey(data);
  const current = messageWindows.get(key) || { limit: FIRST_MESSAGE_WINDOW, hasMore: false };
  messageWindows.set(key, { ...current, limit: Math.min(500, current.limit + OLDER_MESSAGE_STEP) });
};

export const loadConversationTimeline = async (data) => {
  const key = windowKey(data);
  const limit = messageWindows.get(key)?.limit || FIRST_MESSAGE_WINDOW;
  const response = await fetch(
    `api/messages?auth_id=${auth()?._id}&ref_id=${data?._id}&is_group=${
      data?.is_group
    }&limit=${limit}`
  );
  const res = await response.json();
  if (!response.ok || !res.success) {
    throw new Error(res.message || "Unable to load messages.");
  }
  const activeSocket = socket_connection();
  for (const event of res.seen_events || []) {
    activeSocket.emit("messages-seen", event);
  }
  messageWindows.set(key, { limit, hasMore: Boolean(res.has_more) });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat:history-state", { detail: { key, hasMore: Boolean(res.has_more) } }));
  }
  return {
    messages: res.data,
    callLogs: Array.isArray(res.call_logs) ? res.call_logs : [],
  };
};

export const loadMessages = async (data) =>
  (await loadConversationTimeline(data)).messages;

// The tune is the file public/sounds/message.mp3: replace that file to change the sound.
// When it cannot be loaded or played, the generated tune above plays instead.
export const playMessageReminder = () => {
  if (typeof window === "undefined") return;
  try {
    const audio = new Audio("/sounds/message.mp3");
    audio.volume = 1;
    audio.addEventListener("error", playGeneratedReminder, { once: true });
    audio.play().catch((error) => {
      if (error?.name !== "NotAllowedError") playGeneratedReminder();
    });
  } catch {
    playGeneratedReminder();
  }
};
