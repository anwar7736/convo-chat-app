"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FiPhone, FiPhoneIncoming, FiPhoneMissed, FiPhoneOutgoing, FiSearch, FiVideo, FiX } from "react-icons/fi";
import { AuthContext } from "../contexts/AuthContext";
import { UserContext } from "../contexts/UserContext";
import { MessageContext } from "../contexts/MessageContext";
import { UserListContext } from "../contexts/UserListContext";
import { getImageURL, loadConversationTimeline } from "../helpers/helper";
import { toast } from "sonner";

// Format startedAt into "Today, 5:14 AM" / "Yesterday, 10:39 PM" / "Mon, 5:14 AM"
function callDateLabel(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.floor((dayStart(now) - dayStart(date)) / 86400000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (daysAgo === 0) return `Today, ${time}`;
  if (daysAgo === 1) return `Yesterday, ${time}`;
  if (daysAgo < 7) return `${date.toLocaleDateString([], { weekday: "short" })}, ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export default function CallsTab({ setConversationLoading, onOpenConversation }) {
  const { user: authUser } = useContext(AuthContext);
  const { setUser } = useContext(UserContext);
  const { setMessages, setCallLogs } = useContext(MessageContext);
  const { setUsers } = useContext(UserListContext);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(10);
  const requestIdRef = useRef(0);
  const sentinelRef = useRef(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/calls/history?with_names=1");
      const result = await res.json();
      if (result.success) setLogs(result.data || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // refresh when a call ends / starts
  useEffect(() => {
    const onRefresh = () => fetchLogs();
    window.addEventListener("chat:refresh-call-logs", onRefresh);
    return () => window.removeEventListener("chat:refresh-call-logs", onRefresh);
  }, [fetchLogs]);

  // reset visible count when search changes
  useEffect(() => { setVisibleCount(10); }, [search]);

  // infinite scroll sentinel
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((n) => n + 10);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, logs.length, search]);

  // group consecutive calls with the same person into one row (count badge)
  const grouped = (() => {
    const filtered = search.trim()
      ? logs.filter((log) => {
          const q = search.trim().toLowerCase();
          return (log.name || "").toLowerCase().includes(q) ||
            (log.nickname || "").toLowerCase().includes(q) ||
            (log.email || "").toLowerCase().includes(q) ||
            (log.phone || "").toLowerCase().includes(q);
        })
      : logs;
    const result = [];
    for (const log of filtered) {
      const prev = result[result.length - 1];
      const sameConvo = prev && String(prev.conversationId) === String(log.conversationId) &&
        prev.isVideo === log.isVideo &&
        (String(prev.callerId) === String(authUser?._id)) === (String(log.callerId) === String(authUser?._id));
      if (sameConvo) {
        prev._count = (prev._count || 1) + 1;
      } else {
        result.push({ ...log, _count: 1 });
      }
    }
    return result;
  })();

  const openConversation = async (log) => {
    // find the conversation ticket from the users list, same as Users.jsx getMessages()
    const reqId = ++requestIdRef.current;
    setConversationLoading(true);
    try {
      const res = await fetch(`/api/users?auth_id=${authUser._id}`);
      const result = await res.json();
      if (!result.success) throw new Error(result.message || "Cannot load conversations.");
      const ticket = result.data.find(
        (item) => String(item._id) === String(log.conversationId) &&
          Number(item.is_group) === Number(log.isGroup ? 1 : 0)
      );
      if (!ticket) throw new Error("Conversation not found.");
      if (reqId !== requestIdRef.current) return ticket; // superseded
      onOpenConversation?.();
      setMessages([]);
      setCallLogs([]);
      setUser(ticket);
      setUsers((current) => current.map((item) =>
        item?._id === ticket._id ? { ...item, pending: 0 } : item
      ));
      const timeline = await loadConversationTimeline(ticket);
      if (reqId === requestIdRef.current) {
        setMessages(timeline.messages);
        setCallLogs(timeline.callLogs);
      }
      return ticket;
    } catch (error) {
      if (reqId === requestIdRef.current) toast.error(error.message || "Unable to open conversation.");
      return null;
    } finally {
      if (reqId === requestIdRef.current) setConversationLoading(false);
    }
  };

  const startCall = async (log, isVideo) => {
    window.__convoSkipAutofocusUntil = Date.now() + 5000; // calling from the log: no keyboard
    // the call screen opens at once with this person; their chat opens alongside, not before
    window.dispatchEvent(new CustomEvent("chat:call-log-action", {
      detail: {
        isVideo,
        target: {
          _id: log.conversationId,
          name: log.name,
          nickname: log.nickname || "",
          photo: log.photo,
          is_group: log.isGroup ? 1 : 0,
        },
      },
    }));
    openConversation(log).then(() => window.dispatchEvent(new Event("chat:refresh-call-logs")));
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-1 pt-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-3 px-2 py-1 opacity-40 animate-pulse">
            <div className="h-12 w-12 shrink-0 rounded-full bg-[#263248]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-28 rounded bg-[#263248]" />
              <div className="h-2.5 w-20 rounded bg-[#263248]" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search */}
      <div className="px-4 pt-4 pb-3">
        <div className="relative">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-[#728099]" size={15} />
          <input
            type="text"
            className="form-control"
            style={{ paddingLeft: "2.25rem", paddingRight: search ? "2rem" : undefined }}
            placeholder="Search calls"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-[#728099]" onClick={() => setSearch("")}>
              <FiX size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {grouped.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[#91a0b7]">
            {search ? "No calls found." : "No recent calls."}
          </p>
        ) : (
          grouped.slice(0, visibleCount).map((log) => {
            const outgoing = String(log.callerId) === String(authUser?._id);
            const isMissed = log.status === "no-answer" && !outgoing;
            const CallIcon = isMissed ? FiPhoneMissed : log.isVideo ? FiVideo : outgoing ? FiPhoneOutgoing : FiPhoneIncoming;
            const iconColor = isMissed ? "text-rose-400" : "text-green-400";
            const nameColor = isMissed ? "text-rose-400" : "text-white";
            const label = log.isVideo ? "Video" : "Voice";
            const dirLabel = outgoing ? "Outgoing" : isMissed ? "Missed" : "Incoming";
            const count = log._count > 1 ? ` (${log._count})` : "";

            return (
              <div
                key={log.callId}
                className="calls-tab-row group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-[#1a2235] cursor-pointer"
                onClick={() => openConversation(log)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openConversation(log); }}
              >
                {/* Avatar */}
                <img
                  src={getImageURL(log.photo)}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full object-cover border border-[#263248]"
                />

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm font-semibold ${nameColor}`}>
                    {log.nickname || log.name || "Unknown"}{count}
                  </p>
                  <p className={`flex items-center gap-1 text-xs ${iconColor}`}>
                    <CallIcon size={12} aria-label={dirLabel} />
                    {callDateLabel(log.startedAt)}
                  </p>
                </div>

                {/* Call button */}
                <button
                  type="button"
                  className="calls-tab-call-btn shrink-0 rounded-full p-2 text-[#91a0b7] hover:bg-[#263248] hover:text-indigo-300"
                  aria-label={`${label} call`}
                  title={`${label} call`}
                  onClick={(e) => { e.stopPropagation(); startCall(log, log.isVideo); }}
                >
                  {log.isVideo ? <FiVideo size={18} /> : <FiPhone size={18} />}
                </button>
              </div>
            );
          })
        )}
        {visibleCount < grouped.length && (
          <div ref={sentinelRef} className="h-2" />
        )}
      </div>
    </div>
  );
}
