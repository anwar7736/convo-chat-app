"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaVideo } from "react-icons/fa";
import { FiArrowLeft, FiBluetooth, FiCheck, FiMic, FiMicOff, FiPhone, FiPhoneOff, FiRefreshCw, FiSmartphone, FiVideo, FiVideoOff, FiVolume2 } from "react-icons/fi";
import { MdAddIcCall } from "react-icons/md";
import { toast } from "sonner";
import { UserListContext } from "../contexts/UserListContext";
import { getImageURL, socket_connection } from "../helpers/helper";

const socket = socket_connection();
const END_SCREEN_MS = 1800; // how long "Line busy", "Call ended 01:23" … stay on screen

const formatTime = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

/* ---------- ringtones (generated once, no audio files needed) ---------- */

// a mono 16-bit WAV of tone segments: [frequencies[], seconds] ([] = silence)
function makeToneUrl(segments, sampleRate = 16000) {
  const total = segments.reduce((sum, [, seconds]) => sum + Math.round(seconds * sampleRate), 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + total * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const [freqs, seconds] of segments) {
    const count = Math.round(seconds * sampleRate);
    for (let i = 0; i < count; i += 1) {
      let value = 0;
      if (freqs.length) {
        const t = i / sampleRate;
        const fade = Math.min(1, i / 400, (count - i) / 400); // no clicks at the edges
        value = freqs.reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0) / freqs.length * 0.35 * fade;
      }
      view.setInt16(offset, value * 32767, true);
      offset += 2;
    }
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

// A marimba-style ringtone in the spirit of the iPhone's (an original melody, not Apple's recording):
// each note is a struck wooden bar — a fast attack, a ringing fundamental and short-lived bright overtones.
function makeMarimbaUrl(notes, totalSeconds, sampleRate = 22050) {
  const total = Math.round(totalSeconds * sampleRate);
  const mix = new Float32Array(total);
  const nyquist = sampleRate / 2;
  for (const [freq, start] of notes) {
    const from = Math.round(start * sampleRate);
    const length = Math.min(total - from, Math.round(0.9 * sampleRate));
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate;
      const attack = 1 - Math.exp(-t / 0.003);
      let value = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.28);
      if (freq * 4 < nyquist * 0.9) value += 0.35 * Math.sin(2 * Math.PI * freq * 4 * t) * Math.exp(-t / 0.06);
      if (freq * 9.9 < nyquist * 0.9) value += 0.12 * Math.sin(2 * Math.PI * freq * 9.9 * t) * Math.exp(-t / 0.02);
      mix[from + i] += value * attack;
    }
  }
  let peak = 0;
  for (const sample of mix) peak = Math.max(peak, Math.abs(sample));
  const gain = peak ? 0.8 / peak : 0;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + total * 2, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, total * 2, true);
  mix.forEach((sample, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample * gain)) * 32767, true));
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

// rising and falling arpeggios (E major, then F# minor), played twice, then a short pause — about 4.4 s per loop
function marimbaRing() {
  const E5 = 659.26, Gs5 = 830.61, B5 = 987.77, E6 = 1318.51, Fs5 = 739.99, A5 = 880, Cs6 = 1108.73, Fs6 = 1479.98;
  const phrase = [E5, Gs5, B5, E6, B5, Gs5, Fs5, A5, Cs6, Fs6, Cs6, A5];
  const step = 0.14;
  const notes = [...phrase, ...phrase].map((freq, i) => [freq, i * step]);
  return makeMarimbaUrl(notes, phrase.length * 2 * step + 1.05);
}

let tones = null;
function getTones() {
  if (!tones && typeof window !== "undefined") {
    tones = {
      // incoming: marimba ringtone, looped while the call rings
      ring: marimbaRing(),
      // outgoing ringback, the classic "tuuut … tuuut"
      ringback: makeToneUrl([[[440, 480], 1.2], [[], 2.4]]),
      // busy / ended: three short beeps
      busy: makeToneUrl([[[480, 620], 0.25], [[], 0.25], [[480, 620], 0.25], [[], 0.25], [[480, 620], 0.25], [[], 0.1]]),
    };
  }
  return tones;
}

function useTone(kind, playing, loop = true) {
  useEffect(() => {
    if (!playing || !kind) return;
    const audio = new Audio(getTones()[kind]);
    audio.loop = loop;
    let plays = 0;
    const playTwice = () => {
      plays += 1;
      if (kind === "ring" && plays < 2) audio.play().catch(() => {});
    };
    if (kind === "ring") audio.addEventListener("ended", playTwice);
    audio.play().catch(() => {}); // browsers may refuse sound before the first tap; vibration/notification still work
    return () => {
      audio.removeEventListener("ended", playTwice);
      audio.pause();
      audio.src = "";
    };
  }, [kind, playing, loop]);
}

export default function CallControls({ conversation, currentUser, showButtons = true, blocked = false }) {
  const { users } = useContext(UserListContext) || {};
  const [incoming, setIncoming] = useState(null);
  const [call, setCall] = useState(null);
  const [ended, setEnded] = useState(null); // { title, subtitle, name, photo } shown briefly after a call
  const [remoteStreams, setRemoteStreams] = useState({});
  const [busy, setBusy] = useState(false);
  const [socketConnected, setSocketConnected] = useState(socket.connected);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const incomingRef = useRef(null);
  const startCallRef = useRef(null);
  const peersRef = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());
  const callRef = useRef(null);
  const callSetupRef = useRef(null);
  const endTimerRef = useRef(null);
  const iceServersRef = useRef([
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
    { urls: "stun:stun.cloudflare.com:3478" },
  ]);
  const iceServersLoadedAtRef = useRef(0);
  const iceServersRequestRef = useRef(null);
  const currentUserIdRef = useRef(currentUser?._id);
  currentUserIdRef.current = currentUser?._id;
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [facingMode, setFacingMode] = useState("user");
  const [localVideoExpanded, setLocalVideoExpanded] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [callMinimized, setCallMinimized] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [remoteMedia, setRemoteMedia] = useState({});
  // call diagnostics: shown under the status when a call stays on "Connecting…" (to see where it stops)
  const diagRef = useRef(null);
  const [, setDiagTick] = useState(0);
  const diag = (update) => {
    if (!diagRef.current) return;
    update(diagRef.current);
    setDiagTick((tick) => tick + 1);
  };
  const [audioDevices, setAudioDevices] = useState([]);
  const [audioInputId, setAudioInputId] = useState("");
  const [audioOutputId, setAudioOutputId] = useState("");
  const [audioRoute, setAudioRoute] = useState("speaker");
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const audioMenuRef = useRef(null);
  const [portalRoot, setPortalRoot] = useState(null);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  const personFor = useCallback((id) => (Array.isArray(users)
    ? users.find((item) => String(item?._id) === String(id))
    : null), [users]);

  const loadIceServers = useCallback(async () => {
    if (Date.now() - iceServersLoadedAtRef.current < 30 * 60 * 1000) return;
    if (iceServersRequestRef.current) return iceServersRequestRef.current;
    const request = (async () => {
      try {
        const response = await fetch("/api/calls/ice-servers");
        const result = await response.json();
        if (response.ok && result.success && Array.isArray(result.iceServers) && result.iceServers.length) {
          iceServersRef.current = result.iceServers;
          iceServersLoadedAtRef.current = Date.now();
        }
      } catch {
        // keep the public STUN default
      }
    })();
    iceServersRequestRef.current = request;
    try {
      await request;
    } finally {
      if (iceServersRequestRef.current === request) iceServersRequestRef.current = null;
    }
  }, []);

  const showEnded = useCallback((title, subtitle, info, tone = false) => {
    clearTimeout(endTimerRef.current);
    setEnded({ title, subtitle, ...info, tone });
    endTimerRef.current = setTimeout(() => setEnded(null), END_SCREEN_MS);
  }, []);

  const stopCall = useCallback((notify = true) => {
    const active = callRef.current;
    const setup = callSetupRef.current;
    if (setup?.callId === active?.callId) {
      setup.cancel();
      callSetupRef.current = null;
    }
    if (notify && active?.inviteSent) {
      socket.emit("call:end", { callId: active.callId });
      updateCallLog(active.callId, "ended");
    }
    for (const peer of peersRef.current.values()) peer.close();
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    callRef.current = null;
    setCall(null);
    setBusy(false);
    setRemoteStreams({});
    setMuted(false);
    setCameraOff(false);
    setControlsHidden(false);
    setFacingMode("user");
    setLocalVideoExpanded(false);
    setCallMinimized(false);
    setRemoteMedia({});
  }, []);

  const updateCallLog = async (callId, action, details) => {
    try {
      const response = await fetch("/api/calls/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, action, ...details }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.message || "Unable to update call history.");
      if (result.socket_event) socket.emit("call-log-updated", result.socket_event);
      window.dispatchEvent(new Event("chat:refresh-call-logs"));
      return true;
    } catch (error) {
      console.error("Unable to save call history:", error);
      toast.error(error.message || "Unable to save call history.");
      return false;
    }
  };

  const loadCallHistory = useCallback(() => {
    window.dispatchEvent(new Event("chat:refresh-call-logs"));
  }, []);

  // when the partner updates their profile or the user updates a nickname, reflect it live in the call screen
  useEffect(() => {
    const onUserUpdated = (event) => {
      const updated = event.detail;
      if (!updated?._id || !callRef.current) return;
      const active = callRef.current;
      const isPartner = !active.isGroup && (
        String(active.conversationId) === String(updated._id) ||
        (!active.isCaller && String(active.callerId) === String(updated._id))
      );
      if (!isPartner) return;
      const patch = {};
      if (updated.name) patch.conversationName = updated.nickname || updated.name;
      if (updated.photo !== undefined) patch.photo = updated.photo;
      if (!Object.keys(patch).length) return;
      const next = { ...active, ...patch };
      callRef.current = next;
      setCall(next);
    };
    window.addEventListener("chat:user-updated", onUserUpdated);
    return () => window.removeEventListener("chat:user-updated", onUserUpdated);
  }, []);

  useEffect(() => {
    if (!call) return;
    let active = true;
    const refreshDevices = async () => {
      try {
        const devices = await navigator.mediaDevices?.enumerateDevices?.();
        if (active && devices) {
          setAudioDevices(devices.filter((device) => device.kind === "audioinput" || device.kind === "audiooutput"));
        }
      } catch (error) {
        console.error("Unable to enumerate audio devices:", error);
      }
    };
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [call]);

  useEffect(() => {
    if (!audioMenuOpen) return;
    const closeOnOutsidePointer = (event) => {
      if (event.target instanceof Node && !audioMenuRef.current?.contains(event.target)) {
        setAudioMenuOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setAudioMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [audioMenuOpen]);

  const changeAudioInput = async (deviceId) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      const nextTrack = fresh.getAudioTracks()[0];
      nextTrack.enabled = !muted;
      for (const peer of peersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "audio");
        await sender?.replaceTrack(nextTrack);
      }
      const oldTrack = stream.getAudioTracks()[0];
      if (oldTrack) {
        stream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      stream.addTrack(nextTrack);
      setAudioInputId(deviceId);
    } catch (error) {
      toast.error(error.message || "Unable to switch microphone.");
    }
  };

  const changeAudioOutput = async (deviceId) => {
    const elements = [...document.querySelectorAll(".call-screen audio, .call-screen video")]
      .filter((element) => !element.muted);
    const supportedElements = elements.filter((element) => typeof element.setSinkId === "function");
    if (elements.length && !supportedElements.length) {
      return false;
    }
    for (const element of elements) {
      if (typeof element.setSinkId !== "function") continue;
      try {
        await element.setSinkId(deviceId);
      } catch (error) {
        toast.error(error.message || "Unable to switch audio output.");
        return false;
      }
    }
    setAudioOutputId(deviceId);
    return true;
  };

  const changeAudioRoute = async (route) => {
    const outputs = audioDevices.filter((device) => device.kind === "audiooutput");
    const matches = {
      speaker: /speaker|loudspeaker/i,
      earpiece: /earpiece|receiver|phone/i,
      bluetooth: /bluetooth|headset|headphone/i,
    };
    let device = outputs.find((item) => matches[route].test(item.label || ""));
    if (route === "speaker") {
      device = device || outputs.find((item) => item.deviceId === "default") || outputs[0];
    }

    if (!device && route === "bluetooth" && navigator.mediaDevices?.selectAudioOutput) {
      try {
        device = await navigator.mediaDevices.selectAudioOutput();
      } catch (error) {
        if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
          toast.error(error.message || "Unable to choose a Bluetooth audio device.");
        }
        return;
      }
    }

    if (device) {
      const applied = await changeAudioOutput(device.deviceId);
      if (!applied) {
        toast.info("This browser does not support selecting call audio output. Change it in your device audio settings.");
        return;
      }
    } else if (route !== "speaker") {
      toast.info(`${route === "earpiece" ? "Earpiece" : "Bluetooth"} routing is not available in this browser. Use your device audio controls.`);
      return;
    } else if (outputs.length) {
      toast.info("This browser controls call audio through your device audio settings.");
      return;
    }

    // the microphone follows the chosen route: a Bluetooth headset mic for Bluetooth, the phone's own mic otherwise
    const inputs = audioDevices.filter((item) => item.kind === "audioinput");
    const btInput = inputs.find((item) => /bluetooth|headset|headphone/i.test(item.label || ""));
    const wantedInput = route === "bluetooth" ? btInput?.deviceId : (inputs.find((item) => !/bluetooth|headset|headphone/i.test(item.label || "")) || {}).deviceId;
    if ((wantedInput || "") !== audioInputId && (route !== "bluetooth" || btInput)) {
      await changeAudioInput(wantedInput || "");
    }

    setAudioRoute(route);
    setAudioMenuOpen(false);
  };

  useEffect(() => {
    if (!audioOutputId) return;
    const applyOutputToNewElements = async () => {
      const elements = [...document.querySelectorAll(".call-screen audio, .call-screen video")]
        .filter((element) => !element.muted);
      for (const element of elements) {
        if (typeof element.setSinkId !== "function" || element.sinkId === audioOutputId) continue;
        try {
          await element.setSinkId(audioOutputId);
        } catch (error) {
          console.error("Unable to apply selected call audio output:", error);
        }
      }
    };
    applyOutputToNewElements();
  }, [audioOutputId, call, remoteStreams]);

  const removePeer = useCallback((peerId) => {
    peersRef.current.get(peerId)?.close();
    peersRef.current.delete(peerId);
    pendingCandidatesRef.current.delete(peerId);
    setRemoteStreams((streams) => {
      const next = { ...streams };
      delete next[peerId];
      return next;
    });
  }, []);

  const makePeer = useCallback((peerId, callId) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;
    const peer = new RTCPeerConnection({ iceServers: iceServersRef.current, iceCandidatePoolSize: 2 });
    // plain addTrack, as in the version that worked: changing sender parameters before the call is
    // negotiated is handled differently by Safari/iPhone and can leave the call silent
    localStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current));
    diagRef.current = {
      sock: socket.id, offer: "-", answer: "-", local: { host: 0, srflx: 0, relay: 0, prflx: 0 }, remote: 0,
      ice: peer.iceConnectionState, gather: peer.iceGatheringState, conn: peer.connectionState, err: "",
      tracks: (localStreamRef.current?.getTracks() || []).map((t) => t.kind[0] + (t.readyState === "live" ? "" : "!")).join(""),
      servers: (iceServersRef.current || []).map((s) => [].concat(s.urls).map((u) => u.split(":")[0]).join("+")).join(","),
    };
    peer.addEventListener("icegatheringstatechange", () => diag((d) => { d.gather = peer.iceGatheringState; }));
    peer.addEventListener("iceconnectionstatechange", () => diag((d) => { d.ice = peer.iceConnectionState; }));
    peer.addEventListener("connectionstatechange", () => diag((d) => { d.conn = peer.connectionState; }));
    peer.addEventListener("icecandidateerror", (event) => diag((d) => { d.err = `ice ${event.errorCode} ${(event.url || "").split(":")[0]}`; }));
    peer.onicecandidate = (event) => {
      if (event.candidate?.type) diag((d) => { d.local[event.candidate.type] = (d.local[event.candidate.type] || 0) + 1; });
      if (event.candidate) {
        socket.emit("call:signal", { callId, to: peerId, signal: { candidate: event.candidate.toJSON() } });
      }
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) setRemoteStreams((streams) => ({ ...streams, [peerId]: stream }));
      // the other side turned its camera on in a voice call: this side becomes a video call too
      const active = callRef.current;
      if (event.track.kind === "video" && active && active.callId === callId && !active.isVideo) {
        const next = { ...active, isVideo: true };
        callRef.current = next;
        setCall(next);
        if (!localStreamRef.current?.getVideoTracks().length) {
          setCameraOff(true);
          socket.emit("call:media-status", {
            callId,
            muted: !localStreamRef.current?.getAudioTracks()[0]?.enabled,
            cameraOff: true,
          });
        }
      }
    };
    let restarts = 0;
    let disconnectTimer = null;
    peer.onconnectionstatechange = async () => {
      if (peer.connectionState === "connected") {
        clearTimeout(disconnectTimer);
        const active = callRef.current;
        if (active && active.callId === callId && !active.mediaConnected) {
          const next = { ...active, status: "connected", mediaConnected: true, connectedAt: active.connectedAt || Date.now() };
          callRef.current = next;
          setCall(next);
        }
      }
      if (peer.connectionState === "disconnected") {
        // a short network blip: give it 3 s, then ask for a fresh route
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(async () => {
          if (peer.connectionState !== "disconnected" || currentUserIdRef.current >= peerId) return;
          try {
            const offer = await peer.createOffer({ iceRestart: true });
            await peer.setLocalDescription(offer);
            socket.emit("call:signal", { callId, to: peerId, signal: { description: peer.localDescription.toJSON() } });
          } catch {}
        }, 3000);
      }
      // a dropped network (Wi-Fi to mobile data, a short outage): the side that made the offer
      // asks for a fresh route a couple of times before giving the participant up
      if (peer.connectionState === "failed" && restarts < 10 && currentUserIdRef.current < peerId) {
        restarts += 1;
        try {
          peer.restartIce?.();
          const offer = await peer.createOffer({ iceRestart: true });
          await peer.setLocalDescription(offer);
          socket.emit("call:signal", { callId, to: peerId, signal: { description: peer.localDescription.toJSON() } });
          return;
        } catch {
          // fall through and drop the participant
        }
      }
      if (peer.connectionState === "connected") restarts = 0;
      if (peer.connectionState === "closed" || (peer.connectionState === "failed" && restarts >= 10)) {
        removePeer(peerId);
      }
    };
    peersRef.current.set(peerId, peer);
    return peer;
  }, [removePeer]);

  const enableCameraInAudioCall = async () => {
    if (!callRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;
      const wasVideo = Boolean(callRef.current.isVideo);
      localStreamRef.current.addTrack(videoTrack);
      // the other side only receives the new video after a fresh offer/answer round
      for (const [peerId, peer] of peersRef.current.entries()) {
        peer.addTrack(videoTrack, localStreamRef.current);
        if (peer.signalingState !== "stable") continue;
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.emit("call:signal", { callId: callRef.current.callId, to: peerId, signal: { description: peer.localDescription.toJSON() } });
        } catch (error) {
          console.error("Unable to share the camera:", error);
        }
      }
      setCameraOff(false);
      const upgraded = { ...callRef.current, isVideo: true };
      callRef.current = upgraded;
      setCall(upgraded);
      socket.emit("call:media-status", { callId: upgraded.callId, muted, cameraOff: false });
      if (!wasVideo) await updateCallLog(upgraded.callId, "upgrade-video");
    } catch (error) {
      toast.error("Could not turn camera on: " + (error.message || "unknown error"));
    }
  };

  const toggleTrack = (kind) => {
    const tracks = kind === "audio" ? localStreamRef.current?.getAudioTracks() : localStreamRef.current?.getVideoTracks();
    if (!tracks?.length) {
      // no camera shared yet (voice call, or the other side started the video): turn it on and renegotiate
      if (kind === "video" && callRef.current) enableCameraInAudioCall();
      return;
    }
    const enabled = !tracks[0].enabled;
    tracks.forEach((track) => { track.enabled = enabled; });
    if (kind === "audio") setMuted(!enabled);
    else setCameraOff(!enabled);
    const active = callRef.current;
    if (active) {
      const nextMuted = kind === "audio" ? !enabled : muted;
      const nextCameraOff = kind === "video" ? !enabled : cameraOff;
      socket.emit("call:media-status", { callId: active.callId, muted: nextMuted, cameraOff: nextCameraOff });
    }
  };

  // front <-> back camera during a video call
  const flipCamera = async () => {
    const stream = localStreamRef.current;
    const oldTrack = stream?.getVideoTracks()[0];
    if (!oldTrack) return;
    const nextMode = facingMode === "user" ? "environment" : "user";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextMode } });
      const newTrack = fresh.getVideoTracks()[0];
      newTrack.enabled = oldTrack.enabled;
      for (const peer of peersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        await sender?.replaceTrack(newTrack);
      }
      stream.removeTrack(oldTrack);
      oldTrack.stop();
      stream.addTrack(newTrack);
      setFacingMode(nextMode);
      const element = document.getElementById("local-call-stream");
      if (element) element.srcObject = stream;
    } catch {
      toast.error("This device has no other camera.");
    }
  };

  const flushCandidates = useCallback(async (peerId, peer) => {
    const queued = pendingCandidatesRef.current.get(peerId) || [];
    pendingCandidatesRef.current.delete(peerId);
    for (const candidate of queued) {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }, []);

  const openMedia = async (video) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio and video calls need a secure (https) connection.");
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(audioInputId ? { deviceId: { exact: audioInputId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (error) {
      if (error?.name === "NotAllowedError") {
        throw new Error(video ? "Allow camera and microphone access to make video calls." : "Allow microphone access to make calls.");
      }
      if (error?.name === "NotFoundError") throw new Error(video ? "No camera or microphone was found." : "No microphone was found.");
      if (error?.name === "NotReadableError") throw new Error("The camera or microphone is being used by another app.");
      throw error;
    }
  };

  const notifyMissed = useCallback((active, recipients) => {
    if (!active?.isCaller || !recipients?.length) return;
    return fetch("/api/calls/missed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: active.conversationId,
        is_group: active.isGroup ? 1 : 0,
        is_video: active.isVideo,
        recipient_ids: recipients,
      }),
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to send a missed-call notification.");
      }
    }).catch((error) => {
      console.error("Unable to send a missed-call notification:", error);
    });
  }, []);

  const startCall = async (video) => {
    window.dispatchEvent(new Event("chat:scroll-bottom")); // same as pressing the scroll-to-bottom arrow
    if (!conversation?._id || !currentUser?._id || busy || callRef.current || incomingRef.current) return;
    if (blocked) {
      toast.error("Unblock this contact before calling.");
      return;
    }
    if (!socket.connected) {
      toast.error("Not connected. Check your internet connection and try again.");
      return;
    }
    const activeCall = {
      callId: crypto.randomUUID(),
      isVideo: video,
      isCaller: true,
      callerId: currentUser._id,
      callerName: currentUser.name,
      conversationId: conversation._id,
      conversationName: conversation.nickname || conversation.name,
      photo: conversation.photo,
      isGroup: conversation.is_group === 1,
      recipients: [],
      status: "connecting",
      startedAt: Date.now(),
    };
    callRef.current = activeCall;
    setCall(activeCall);
    setBusy(true);
    const iceServersReady = loadIceServers();
    let callSetup = null;
    try {
      const accessResponse = await fetch("/api/conversations/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversation._id,
          peer_id: conversation._id,
          is_group: conversation.is_group === 1,
        }),
      });
      const accessResult = await accessResponse.json().catch(() => ({}));
      if (!accessResponse.ok || !accessResult.success || !accessResult.allowed) {
        throw new Error(accessResult.message || "This conversation cannot receive calls.");
      }
      if (callRef.current?.callId !== activeCall.callId) return;

      let recipients;
      if (conversation.is_group === 1) {
        const response = await fetch(`/api/group?id=${conversation._id}`);
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || "Unable to load group members.");
        recipients = result.data.members.map((member) => String(member.user_id)).filter((id) => id !== currentUser._id);
      } else {
        recipients = [String(conversation._id)];
      }
      if (callRef.current?.callId !== activeCall.callId) return;
      if (!recipients.length) throw new Error("There are no other people to call.");
      if (recipients.length > 7) throw new Error("Group calls currently support up to 8 participants.");

      callSetup = {
        callId: activeCall.callId,
        cancelled: false,
        logSaved: false,
        logPromise: null,
        cancel() {
          this.cancelled = true;
          if (this.logSaved) {
            this.logSaved = false;
            void updateCallLog(this.callId, "ended");
          }
        },
      };
      callSetupRef.current = callSetup;
      callSetup.logPromise = updateCallLog(callSetup.callId, "start", {
        callerId: activeCall.callerId,
        conversationId: activeCall.conversationId,
        isGroup: activeCall.isGroup,
        isVideo: activeCall.isVideo,
        participants: [activeCall.callerId, ...recipients],
      }).then(async (saved) => {
        callSetup.logSaved = saved;
        if (callSetup.cancelled && saved) {
          callSetup.logSaved = false;
          await updateCallLog(callSetup.callId, "ended");
          return false;
        }
        return saved;
      });

      const stream = await openMedia(video);
      if (callRef.current?.callId !== activeCall.callId) {
        stream.getTracks().forEach((track) => track.stop());
        await callSetup.logPromise;
        return;
      }
      localStreamRef.current = stream;
      await Promise.all([iceServersReady, callSetup.logPromise]);
      if (callRef.current?.callId !== activeCall.callId) {
        stream.getTracks().forEach((track) => track.stop());
        if (localStreamRef.current === stream) localStreamRef.current = null;
        return;
      }
      const callingCall = {
        ...activeCall,
        recipients,
        status: "calling",
      };
      callRef.current = callingCall;
      setCall(callingCall);
      const invitedCall = { ...callingCall, inviteSent: true };
      callRef.current = invitedCall;
      setCall(invitedCall);
      if (callSetupRef.current === callSetup) callSetupRef.current = null;
      socket.emit("call:invite", {
        callId: invitedCall.callId,
        isVideo: invitedCall.isVideo,
        callerName: invitedCall.callerName,
        conversationName: invitedCall.conversationName,
        conversationId: invitedCall.conversationId,
        isGroup: invitedCall.isGroup,
        recipients,
      });
    } catch (error) {
      if (callSetup) {
        callSetup.cancel();
        await callSetup.logPromise;
        if (callSetupRef.current === callSetup) callSetupRef.current = null;
      }
      if (callRef.current?.callId === activeCall.callId) {
        toast.error(error.message || "Unable to start the call.");
        stopCall(false);
      }
    } finally {
      setBusy(false);
    }
  };
  startCallRef.current = startCall;

  useEffect(() => {
    const onCallLogAction = (event) => {
      const { callId, isVideo } = event.detail || {};
      const activeCall = callRef.current;
      if (activeCall) {
        if (activeCall.callId === callId) setCallMinimized(false);
        else toast.info("End the current call before starting another.");
        return;
      }
      if (incomingRef.current) {
        toast.info("Answer or decline the incoming call before calling back.");
        return;
      }
      if (conversation?._id) startCallRef.current?.(Boolean(isVideo));
    };
    window.addEventListener("chat:call-log-action", onCallLogAction);
    return () => window.removeEventListener("chat:call-log-action", onCallLogAction);
  }, [conversation?._id]);

  const acceptCall = async () => {
    if (!incoming || busy || callRef.current) return;
    const acceptingCall = incoming;
    setBusy(true);
    try {
      const stream = await openMedia(acceptingCall.isVideo);
      if (incomingRef.current?.callId !== acceptingCall.callId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await loadIceServers();
      if (incomingRef.current?.callId !== acceptingCall.callId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      localStreamRef.current = stream;
      const caller = personFor(acceptingCall.callerId);
      const activeCall = {
        ...acceptingCall,
        isCaller: false,
        photo: caller?.photo,
        status: "connecting",
        startedAt: Date.now(),
        connectedAt: Date.now(),
        inviteSent: true,
      };
      callRef.current = activeCall;
      setCall(activeCall);
      incomingRef.current = null;
      setIncoming(null);
      socket.emit("call:accept", { callId: acceptingCall.callId, callerId: acceptingCall.callerId });
    } catch (error) {
      if (incomingRef.current?.callId !== acceptingCall.callId) return;
      toast.error(error.message || "Unable to join the call.");
      socket.emit("call:reject", { callId: acceptingCall.callId, callerId: acceptingCall.callerId });
      incomingRef.current = null;
      setIncoming(null);
    } finally {
      setBusy(false);
    }
  };

  const declineCall = () => {
    if (!incoming) return;
    socket.emit("call:reject", { callId: incoming.callId, callerId: incoming.callerId });
    incomingRef.current = null;
    setIncoming(null);
  };

  const hangUp = () => {
    const active = callRef.current;
    if (!active) return;
    const connectedFor = active.connectedAt ? Math.floor((Date.now() - active.connectedAt) / 1000) : null;
    stopCall();
    loadCallHistory();
    showEnded(connectedFor != null ? "Call ended" : "Call cancelled", connectedFor != null ? formatTime(connectedFor) : "", {
      name: active.isGroup || active.isCaller ? active.conversationName : active.callerName,
      photo: active.photo,
    });
  };

  /* ---------- sounds & vibration ---------- */
  // the call rings until someone answers, declines or the caller cancels (like WhatsApp/Messenger)
  useTone("ring", Boolean(incoming));
  useTone("ringback", call?.status === "ringing");
  useTone("busy", Boolean(ended?.tone), false);

  // the phone vibrates for as long as it rings
  useEffect(() => {
    if (!incoming || !navigator.vibrate) return;
    navigator.vibrate([400, 200, 400]);
    const interval = setInterval(() => navigator.vibrate([400, 200, 400]), 2600);
    return () => {
      clearInterval(interval);
      navigator.vibrate(0);
    };
  }, [incoming]);

  // a ringing call while the app is in the background: a system notification, like WhatsApp
  useEffect(() => {
    if (!incoming || document.visibilityState === "visible") return;
    if (!("serviceWorker" in navigator) || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const tag = `incoming-${incoming.callId}`;
    navigator.serviceWorker.ready.then((registration) => registration.showNotification(
      `Incoming ${incoming.isVideo ? "video" : "voice"} call`,
      {
        body: incoming.conversationName && incoming.conversationName !== incoming.callerName
          ? `${incoming.callerName} @ ${incoming.conversationName}`
          : incoming.callerName,
        icon: "/icons/icon.svg",
        silent: false,
        tag,
        requireInteraction: true,
        vibrate: [400, 200, 400, 200, 400],
        data: { url: "/" },
      }
    )).catch(() => {});
    return () => {
      navigator.serviceWorker.ready
        .then((registration) => registration.getNotifications({ tag }))
        .then((list) => list.forEach((item) => item.close()))
        .catch(() => {});
    };
  }, [incoming]);

  const notificationCallId = call?.callId;
  useEffect(() => {
    if (!notificationCallId || !("serviceWorker" in navigator) || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let active = true;
    let syncing = false;
    const tag = `active-call-${notificationCallId}`;
    const syncCallNotification = async () => {
      if (!active || syncing) return;
      syncing = true;
      try {
        const registration = await navigator.serviceWorker.ready;
        if (!active) return;
        const existing = await registration.getNotifications({ tag });
        if (!active) return;
        if (document.visibilityState === "visible") {
          existing.forEach((notification) => notification.close());
          return;
        }
        const activeCall = callRef.current;
        if (!activeCall || activeCall.callId !== notificationCallId) return;
        const name = activeCall.isGroup || activeCall.isCaller ? activeCall.conversationName : activeCall.callerName;
        const status = activeCall.connectedAt
          ? formatTime(Math.floor((Date.now() - activeCall.connectedAt) / 1000))
          : activeCall.status === "ringing" ? "Ringing" : activeCall.status === "connecting" ? "Connecting" : "Calling";
        await registration.showNotification(name || "Call in progress", {
          body: `${activeCall.isVideo ? "Video" : "Voice"} call · ${status}`,
          icon: "/icons/icon.svg",
          badge: "/icons/icon.svg",
          silent: true,
          tag,
          requireInteraction: true,
          timestamp: Date.now(),
          data: { url: "/" },
        });
      } catch (error) {
        console.error("Unable to show the ongoing call notification:", error);
      } finally {
        syncing = false;
      }
    };
    const closeCallNotification = () => {
      navigator.serviceWorker.ready
        .then((registration) => registration.getNotifications({ tag }))
        .then((notifications) => notifications.forEach((notification) => notification.close()))
        .catch((error) => console.error("Unable to close the ongoing call notification:", error));
    };
    syncCallNotification();
    document.addEventListener("visibilitychange", syncCallNotification);
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState !== "visible") syncCallNotification();
    }, 1000);
    return () => {
      active = false;
      clearInterval(refreshInterval);
      document.removeEventListener("visibilitychange", syncCallNotification);
      closeCallNotification();
    };
  }, [notificationCallId]);

  /* ---------- timer: calling / ringing / in call ---------- */
  useEffect(() => {
    const timerStartedAt = call?.connectedAt;
    if (!timerStartedAt) {
      setElapsedSeconds(0);
      return;
    }
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - timerStartedAt) / 1000));
    updateElapsed();
    const timer = setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [call?.connectedAt, call?.startedAt, incoming?.startedAt]);

  /* ---------- socket events ---------- */
  useEffect(() => {
    // a fresh route for one person (after a network switch): only the lower id makes the offer, as at the start
    const restartPeer = async (peerId) => {
      const peer = peersRef.current.get(peerId);
      const active = callRef.current;
      if (!peer || !active || currentUserIdRef.current >= peerId) return;
      try {
        peer.restartIce?.();
        const offer = await peer.createOffer({ iceRestart: true });
        await peer.setLocalDescription(offer);
        socket.emit("call:signal", { callId: active.callId, to: peerId, signal: { description: peer.localDescription.toJSON() } });
      } catch (error) {
        console.error("Unable to re-route the call:", error);
      }
    };
    // back on a new socket (Wi-Fi to mobile data): take the seat in the call again
    const onConnect = () => {
      setSocketConnected(true);
      const active = callRef.current;
      if (active) socket.emit("call:rejoin", { callId: active.callId });
    };
    const onRejoinOk = ({ callId }) => {
      if (callRef.current?.callId !== callId) return;
      for (const peerId of peersRef.current.keys()) restartPeer(peerId);
    };
    const onRejoined = ({ callId, userId }) => {
      if (callRef.current?.callId === callId) restartPeer(userId);
    };
    // the phone switched networks: do not wait for the old connection to time out, reconnect now
    const onNetworkChange = () => {
      if (callRef.current) socket.io?.engine?.close();
    };
    let lastNetworkType = navigator.connection?.type;
    const onConnectionChange = () => {
      const type = navigator.connection?.type;
      if (type === lastNetworkType) return; // only a real switch (wifi / cellular), not a speed change
      lastNetworkType = type;
      onNetworkChange();
    };
    const onDisconnect = () => setSocketConnected(false);
    const onCallLogUpdated = () => loadCallHistory();
    const onInvite = async (invite) => {
      if (callRef.current || incomingRef.current) {
        socket.emit("call:reject", { callId: invite.callId, callerId: invite.callerId });
        return;
      }
      loadIceServers();
      const pendingIncoming = { ...invite, startedAt: Date.now() };
      incomingRef.current = pendingIncoming;
      try {
        const response = await fetch("/api/conversations/access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: invite.conversationId,
            peer_id: invite.callerId,
            is_group: invite.isGroup,
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (incomingRef.current?.callId !== invite.callId) return;
        if (!response.ok || !result.success || !result.allowed || callRef.current) {
          socket.emit("call:reject", { callId: invite.callId, callerId: invite.callerId });
          incomingRef.current = null;
          return;
        }
      } catch (error) {
        console.error("Unable to verify incoming call access:", error);
        socket.emit("call:reject", { callId: invite.callId, callerId: invite.callerId });
        if (incomingRef.current?.callId === invite.callId) incomingRef.current = null;
        return;
      }
      if (incomingRef.current?.callId !== invite.callId) return;
      const incomingCall = pendingIncoming;
      incomingRef.current = incomingCall;
      setIncoming(incomingCall);
      loadCallHistory();
    };
    const onParticipant = async ({ callId, userId }) => {
      const active = callRef.current;
      if (!active || active.callId !== callId || userId === currentUserIdRef.current) return;
      if (!active.connectedAt) {
        const connectedCall = { ...active, status: "connected", connectedAt: Date.now() };
        callRef.current = connectedCall;
        setCall(connectedCall);
      }
      const peer = makePeer(userId, callId);
      if (currentUserIdRef.current < userId) {
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          socket.emit("call:signal", { callId, to: userId, signal: { description: peer.localDescription.toJSON() } });
          diag((d) => { d.offer = "sent"; });
        } catch (error) {
          diag((d) => { d.err = `offer: ${error?.message || error}`; });
          toast.error("Unable to connect a call participant.");
        }
      }
    };
    const onSignal = async ({ callId, from, signal }) => {
      if (callRef.current?.callId !== callId || !signal) return;
      try {
        const peer = makePeer(from, callId);
        if (signal.candidate) {
          diag((d) => { d.remote += 1; });
          if (peer.remoteDescription) {
            await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            pendingCandidatesRef.current.set(from, [...(pendingCandidatesRef.current.get(from) || []), signal.candidate]);
          }
          return;
        }
        if (signal.description?.type === "offer") {
          diag((d) => { d.offer = "recv"; });
          // both sides turned a camera on at the same moment: the higher id steps back, the other keeps its offer
          if (peer.signalingState !== "stable") {
            if (currentUserIdRef.current < from) return;
            await peer.setLocalDescription({ type: "rollback" });
          }
          await peer.setRemoteDescription(new RTCSessionDescription(signal.description));
          await flushCandidates(from, peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("call:signal", { callId, to: from, signal: { description: peer.localDescription.toJSON() } });
          diag((d) => { d.answer = "sent"; });
        } else if (signal.description?.type === "answer") {
          diag((d) => { d.answer = "recv"; });
          await peer.setRemoteDescription(new RTCSessionDescription(signal.description));
          await flushCandidates(from, peer);
        }
      } catch (error) {
        diag((d) => { d.err = `signal: ${error?.message || error}`; });
        toast.error("Unable to establish this call connection.");
      }
    };
    const endInfo = (active) => ({
      name: active.isGroup || active.isCaller
        ? active.conversationName
        : personFor(active.callerId)?.nickname || active.callerName,
      photo: active.photo,
    });
    const onEnded = ({ callId, reason }) => {
      const active = callRef.current;
      if (active?.callId === callId) {
        const connectedFor = active.connectedAt ? Math.floor((Date.now() - active.connectedAt) / 1000) : null;
        const update = updateCallLog(callId, reason === "no-answer" ? "no-answer" : reason === "declined" ? "declined" : "ended");
        if (reason === "no-answer" && active.isCaller) {
          void update.then((saved) => saved && notifyMissed(active, active.recipients));
        }
        loadCallHistory();
        stopCall(false);
        if (reason === "no-answer") showEnded("No answer", "", endInfo(active), true);
        else if (reason === "declined") showEnded("Call declined", "", endInfo(active), true);
        else showEnded("Call ended", connectedFor != null ? formatTime(connectedFor) : "", endInfo(active));
      }
      const missedIncoming = incomingRef.current;
      if (missedIncoming?.callId === callId) {
        updateCallLog(callId, reason === "no-answer" ? "no-answer" : "declined");
        loadCallHistory();
        incomingRef.current = null;
        setIncoming(null);
        if (reason !== "answered-elsewhere" && reason !== "declined-elsewhere") {
          const missedCallerName = personFor(missedIncoming.callerId)?.nickname || missedIncoming.callerName || "someone";
          toast.info(`Missed call from ${missedCallerName}.`);
          showEnded("Missed call", "", {
            name: missedCallerName,
            photo: personFor(missedIncoming.callerId)?.photo,
          }, true);
        }
      }
    };
    const onLeft = ({ callId, userId }) => {
      if (callRef.current?.callId === callId) removePeer(userId);
    };
    const onRejected = ({ callId }) => {
      // in a one-to-one call the call:end that follows says it was declined
      if (callRef.current?.callId === callId && callRef.current.isGroup) toast.info("A participant declined the call.");
    };
    const onRinging = ({ callId }) => {
      if (callRef.current?.callId !== callId || callRef.current.connectedAt) return;
      const ringingCall = { ...callRef.current, status: "ringing" };
      callRef.current = ringingCall;
      setCall(ringingCall);
    };
    const onAccepted = ({ callId }) => {
      if (callRef.current?.callId !== callId || callRef.current.connectedAt) return;
      const connectedCall = { ...callRef.current, status: "connected", connectedAt: Date.now() };
      callRef.current = connectedCall;
      setCall(connectedCall);
      updateCallLog(callId, "answered");
      loadCallHistory();
    };
    const onMediaStatus = ({ callId, userId, muted: peerMuted, cameraOff: peerCameraOff }) => {
      if (callRef.current?.callId !== callId || userId === currentUserIdRef.current) return;
      setRemoteMedia((current) => ({ ...current, [userId]: { muted: peerMuted, cameraOff: peerCameraOff } }));
    };
    const onBusy = ({ callId, userId }) => {
      const active = callRef.current;
      if (active?.callId !== callId) return;
      if (userId === currentUserIdRef.current) {
        updateCallLog(active.callId, "ended");
        loadCallHistory();
        stopCall(false);
        showEnded("You are on another call", "", endInfo(active), true);
        return;
      }
      if (active.isGroup) toast.info(`${personFor(userId)?.nickname || personFor(userId)?.name || "A participant"} is on another call.`);
      // one-to-one: call:unavailable with reason "busy" follows
    };
    const onUnavailable = ({ callId, reason }) => {
      const active = callRef.current;
      if (active?.callId !== callId) return;
      const update = updateCallLog(callId, reason === "busy" ? "declined" : "no-answer");
      loadCallHistory();
      stopCall(false);
      if (reason === "busy") {
        showEnded("Line busy", active.isGroup ? "Everyone is on another call" : "On another call", endInfo(active), true);
      } else {
        void update.then((saved) => saved && notifyMissed(active, active.recipients));
        showEnded(active.isGroup ? "Nobody is available" : "Unavailable", "They are offline. We let them know you called.", endInfo(active), true);
      }
    };

    socket.on("call:invite", onInvite);
    socket.on("call-log-updated", onCallLogUpdated);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("call:rejoin-ok", onRejoinOk);
    socket.on("call:rejoined", onRejoined);
    window.addEventListener("online", onNetworkChange);
    navigator.connection?.addEventListener?.("change", onConnectionChange);
    socket.on("call:participant", onParticipant);
    socket.on("call:signal", onSignal);
    socket.on("call:end", onEnded);
    socket.on("call:left", onLeft);
    socket.on("call:rejected", onRejected);
    socket.on("call:ringing", onRinging);
    socket.on("call:accepted", onAccepted);
    socket.on("call:busy", onBusy);
    socket.on("call:unavailable", onUnavailable);
    socket.on("call:media-status", onMediaStatus);
    return () => {
      socket.off("call:invite", onInvite);
      socket.off("call-log-updated", onCallLogUpdated);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("call:rejoin-ok", onRejoinOk);
      socket.off("call:rejoined", onRejoined);
      window.removeEventListener("online", onNetworkChange);
      navigator.connection?.removeEventListener?.("change", onConnectionChange);
      socket.off("call:participant", onParticipant);
      socket.off("call:signal", onSignal);
      socket.off("call:end", onEnded);
      socket.off("call:left", onLeft);
      socket.off("call:rejected", onRejected);
      socket.off("call:ringing", onRinging);
      socket.off("call:accepted", onAccepted);
      socket.off("call:busy", onBusy);
      socket.off("call:unavailable", onUnavailable);
      socket.off("call:media-status", onMediaStatus);
    };
  }, [flushCandidates, makePeer, notifyMissed, personFor, removePeer, showEnded, stopCall, loadCallHistory]);

  // leaving the page (sign out, closing the tab) hangs up
  useEffect(() => () => {
    clearTimeout(endTimerRef.current);
    stopCall();
  }, [stopCall]);

  useEffect(() => {
    const element = localVideoRef.current;
    const stream = localStreamRef.current;
    if (!call?.isVideo || !element || !stream) return;
    element.srcObject = cameraOff ? null : stream;
    const resumePlayback = () => {
      if (cameraOff || callMinimized || document.visibilityState === "hidden") return;
      element.play().catch((error) => {
        if (error?.name !== "NotAllowedError") console.error("Unable to resume local call video:", error);
      });
    };
    resumePlayback();
    document.addEventListener("visibilitychange", resumePlayback);
    window.addEventListener("pageshow", resumePlayback);
    return () => {
      document.removeEventListener("visibilitychange", resumePlayback);
      window.removeEventListener("pageshow", resumePlayback);
    };
  }, [call, callMinimized, facingMode, cameraOff]);

  // the conversation list shows "In call" next to this person/group while the call runs
  useEffect(() => {
    const detail = call
      ? {
        peerId: String(call.isGroup || call.isCaller ? call.conversationId : call.callerId),
        isGroup: Boolean(call.isGroup),
        isVideo: Boolean(call.isVideo),
      }
      : null;
    window.__convoLiveCall = detail;
    window.dispatchEvent(new CustomEvent("chat:call-state", { detail }));
  }, [call?.callId, call?.isVideo, call?.isGroup, call?.isCaller, call?.conversationId, call?.callerId]);

  const remoteEntries = Object.entries(remoteStreams);
  const statusText = call
    ? call.mediaConnected
      ? formatTime(elapsedSeconds)
      : `${call.status === "ringing" ? "Ringing" : call.status === "connecting" || call.status === "connected" ? "Connecting" : "Calling"}…`
    : "";
  const callName = call
    ? call.isGroup || call.isCaller
      ? call.conversationName
      : personFor(call.callerId)?.nickname || call.callerName
    : "";
  const incomingPerson = incoming ? personFor(incoming.callerId) : null;
  const incomingName = incomingPerson?.nickname || incoming?.callerName;
  const showVideoStage = call?.isVideo && remoteEntries.length > 0;
  const toggleVideoLayout = () => setLocalVideoExpanded((expanded) => !expanded);

  // The phone Back button on the call screen does what the on-screen ← does: back to the chat, call keeps going
  const callScreenOpen = Boolean(call) && !callMinimized;
  useEffect(() => {
    if (!callScreenOpen) return;
    window.history.pushState({ ...(window.history.state || {}), callScreen: true }, "", window.location.href);
    const onPop = () => {
      setAudioMenuOpen(false);
      setCallMinimized(true);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // closed another way (on-screen ←, call ended): drop our history entry without the app reacting to it
      if (window.history.state?.callScreen) {
        window.__convoIgnoreNextPop = true;
        window.history.back();
      }
    };
  }, [callScreenOpen]);
  // when the full call screen goes away (minimized, ended, phone Back) the chat list goes to the bottom
  const callScreenWasOpenRef = useRef(false);
  useEffect(() => {
    if (callScreenOpen) { callScreenWasOpenRef.current = true; return; }
    if (!callScreenWasOpenRef.current) return;
    callScreenWasOpenRef.current = false;
    window.dispatchEvent(new Event("chat:scroll-bottom"));
  }, [callScreenOpen]);
  // the small "call in progress" bar can be dragged anywhere on screen (a tap still presses its buttons)
  const [selfViewOffset, setSelfViewOffset] = useState({ x: 0, y: 0 });
  const selfViewDragRef = useRef(null);
  const suppressSelfViewClickRef = useRef(false);
  useEffect(() => {
    if (!call) setSelfViewOffset({ x: 0, y: 0 });
  }, [call]);

  // self-view small card is draggable (same as mini bar)
  useEffect(() => {
    if (!call?.isVideo || callMinimized) return;
    const onMove = (event) => {
      const drag = selfViewDragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      event.preventDefault();
      const margin = 8;
      const clampedX = Math.min(window.innerWidth - margin - drag.rect.right, Math.max(margin - drag.rect.left, dx));
      const clampedY = Math.min(window.innerHeight - margin - drag.rect.bottom, Math.max(margin - drag.rect.top, dy));
      setSelfViewOffset({ x: drag.base.x + clampedX, y: drag.base.y + clampedY });
    };
    const onUp = () => {
      if (selfViewDragRef.current?.moved) suppressSelfViewClickRef.current = true;
      selfViewDragRef.current = null;
    };
    const onResize = () => setSelfViewOffset({ x: 0, y: 0 });
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, [call?.isVideo, callMinimized]);

  const minimizeCallScreen = () => {
    setAudioMenuOpen(false);
    setControlsHidden(false);
    setCallMinimized(true);
  };
  // only the small card swaps the videos (like WhatsApp); a tap on the big full-screen video does nothing
  const swapProps = (isSmallCard, label) => isSmallCard
    ? {
      role: "button",
      tabIndex: 0,
      "aria-label": label,
      title: "Swap video cards",
      onClick: (event) => {
        event.stopPropagation();
        toggleVideoLayout();
      },
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleVideoLayout();
        }
      },
    }
    : {};

  return (
    <>
      {showButtons && (
        <button
          type="button"
          className="rounded-xl p-3 text-indigo-300 hover:bg-[#263248] disabled:opacity-40"
          title={socketConnected ? "Voice call" : "Connecting…"}
          aria-label="Start voice call"
          disabled={busy || Boolean(call || incoming) || blocked}
          onClick={() => startCall(false)}
        >
          <MdAddIcCall size={20} />
        </button>
      )}
      {showButtons && (
        <button
          type="button"
          className="rounded-xl p-3 text-indigo-300 hover:bg-[#263248] disabled:opacity-40"
          title={socketConnected ? "Video call" : "Connecting…"}
          aria-label="Start video call"
          disabled={busy || Boolean(call || incoming) || blocked}
          onClick={() => startCall(true)}
        >
          <FaVideo size={18} />
        </button>
      )}

      {portalRoot && createPortal(
        <>
          {incoming && (
            <div className="call-screen call-overlay" role="dialog" aria-modal="true" aria-label="Incoming call">
              <div className="call-hero">
                <p className="call-kind">{incoming.isVideo ? "Incoming video call" : "Incoming voice call"}</p>
                <div className="call-avatar is-ringing">
                  <img src={getImageURL(incomingPerson?.photo)} alt="" />
                </div>
                <h2 className="call-name">{incomingName}</h2>
                {incoming.conversationName && incoming.conversationName !== incomingName && (
                  <p className="call-sub">{incoming.conversationName}</p>
                )}
                <p className="call-status">Ringing…</p>
              </div>
              <div className="call-actions is-incoming">
                <div className="call-action">
                  <button type="button" className="call-round is-end" onClick={declineCall} aria-label="Decline">
                    <FiPhoneOff />
                  </button>
                  <span>Decline</span>
                </div>
                <div className="call-action">
                  <button type="button" className="call-round is-accept" onClick={acceptCall} disabled={busy} aria-label="Accept">
                    {incoming.isVideo ? <FiVideo /> : <FiPhone />}
                  </button>
                  <span>Accept</span>
                </div>
              </div>
            </div>
          )}

          {call && (
            <div
              data-call-screen-open={callMinimized ? undefined : "true"}
              className={`call-screen call-overlay ${showVideoStage ? "has-video" : ""} ${callMinimized ? "is-minimized" : ""} ${localVideoExpanded ? "is-local-video-expanded" : ""} ${controlsHidden ? "is-controls-hidden" : ""}`}
              onClick={(event) => {
                if (callMinimized || event.target.closest("button,input,select,label,a,[role=button],[role=menuitem]")) return;
                setControlsHidden((h) => !h);
                setAudioMenuOpen(false);
              }}
              role={callMinimized ? "region" : "dialog"}
              aria-modal={!callMinimized}
              aria-label={callMinimized ? "Call in progress" : "Call"}
            >
              {/* exactly one sound source per person: the visible video plays it (as in the version that
                  worked); a plain audio element only when there is no visible video (voice call, camera off, minimized) */}
              <div className="call-audio-layer" aria-hidden="true">
                {remoteEntries
                  .filter(([id]) => !(showVideoStage && !callMinimized && !remoteMedia[id]?.cameraOff))
                  .map(([id, stream]) => <RemoteAudio key={id} stream={stream} />)}
              </div>
              {showVideoStage && (
                <div
                  className={`call-stage ${remoteEntries.length > 1 ? "is-grid" : ""} ${localVideoExpanded ? "is-inset" : ""}`}
                  {...swapProps(localVideoExpanded, "Show partner video full screen")}
                >
                  {remoteEntries.map(([id, stream]) => (
                    <CallVideo
                      key={id}
                      stream={stream}
                      label={personFor(id)?.nickname || personFor(id)?.name || (String(id) === String(conversation?._id) ? conversation.nickname || conversation.name : "Participant")}
                      photo={personFor(id)?.photo}
                      muted={remoteMedia[id]?.muted}
                      cameraOff={remoteMedia[id]?.cameraOff}
                      minimized={callMinimized}
                    />
                  ))}
                </div>
              )}
              {call.isVideo && (
                <video
                  id="local-call-stream"
                  ref={localVideoRef}
                  className={`call-self-view ${facingMode === "user" && !cameraOff ? "is-mirrored" : ""} ${cameraOff ? "is-off" : ""} ${localVideoExpanded ? "is-expanded" : ""}`}
                  style={{
                    ...(!localVideoExpanded ? { translate: `${selfViewOffset.x}px ${selfViewOffset.y}px` } : {}),
                    // camera off: the card shows your profile picture instead of a black frame
                    ...(cameraOff ? { background: `#111827 url(${getImageURL(currentUser?.photo)}) center / ${localVideoExpanded ? "contain" : "cover"} no-repeat` } : {}),
                  }}
                  onPointerDown={(event) => {
                    if (localVideoExpanded) return;
                    selfViewDragRef.current = { startX: event.clientX, startY: event.clientY, base: selfViewOffset, rect: event.currentTarget.getBoundingClientRect(), moved: false };
                  }}
                  onClickCapture={(event) => {
                    if (!suppressSelfViewClickRef.current) return;
                    suppressSelfViewClickRef.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  {...swapProps(!localVideoExpanded, "Show your video full screen")}
                  autoPlay
                  playsInline
                  muted
                />
              )}

              {callMinimized ? (
                <div className="call-mini-bar">
                  <button type="button" className="call-mini-main" onClick={() => setCallMinimized(false)} aria-label={`Return to ${callName || "call"}`}>
                    <span className="call-mini-pulse" />
                    <span className="call-mini-text">{callName || "Call"} · {statusText}</span>
                  </button>
                  <button
                    type="button"
                    className={`call-mini-mute ${muted ? "is-muted" : ""}`}
                    onClick={() => toggleTrack("audio")}
                    aria-label={muted ? "Unmute call" : "Mute call"}
                    aria-pressed={muted}
                  >
                    {muted ? <FiMicOff /> : <FiMic />}
                  </button>
                  <button type="button" className="call-mini-end" onClick={hangUp} aria-label="End call">
                    <FiPhoneOff />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="call-minimize-button"
                    onClick={minimizeCallScreen}
                    aria-label="Back to conversation"
                    title="Back to conversation"
                  >
                    <FiArrowLeft />
                  </button>

                  <div className={`call-hero ${showVideoStage ? "is-compact" : ""}`}>
                    <p className="call-kind">{call.isVideo ? "Video call" : "Voice call"}{call.isGroup ? ` · ${remoteEntries.length + 1} in call` : ""}</p>
                    {!showVideoStage && (
                      <div className={`call-avatar ${call.connectedAt ? "" : "is-ringing"}`}>
                        <img src={getImageURL(call.photo)} alt="" />
                      </div>
                    )}
                    <h2 className="call-name">{callName || "Call"}</h2>
                    <p className="call-status">{statusText}</p>
                    {(() => {
                      // who muted their microphone: shown under the name in voice AND video calls (in a video call
                      // the tile badge sat behind the control bar)
                      const mutedIds = Object.entries(remoteMedia).filter(([, state]) => state.muted).map(([id]) => id);
                      if (!mutedIds.length) return null;
                      const text = call.isGroup
                        ? `${mutedIds.map((id) => personFor(id)?.nickname || personFor(id)?.name || "Someone").join(", ")} muted`
                        : "Muted";
                      return <p className="call-muted-pill"><FiMicOff aria-hidden="true" /> {text}</p>;
                    })()}
                    {call.connectedAt && !call.mediaConnected && <p className="call-sub">Connecting audio…</p>}
                    {call.connectedAt && !call.mediaConnected && elapsedSeconds >= 5 && (
                      <p className="call-debug">
                        {diagRef.current
                          ? `ice ${diagRef.current.ice} · conn ${diagRef.current.conn} · gather ${diagRef.current.gather} · me h${diagRef.current.local.host}/s${diagRef.current.local.srflx}/r${diagRef.current.local.relay} · them ${diagRef.current.remote} · offer ${diagRef.current.offer} · answer ${diagRef.current.answer} · tracks ${diagRef.current.tracks} · ${diagRef.current.servers}${socket.id !== diagRef.current.sock ? " · SOCKET CHANGED" : ""}${socket.connected ? "" : " · SOCKET OFFLINE"}${diagRef.current.err ? " · " + diagRef.current.err : ""}`
                          : `no peer yet · socket ${socket.connected ? "on" : "OFF"}`}
                      </p>
                    )}
                  </div>

                  <div className={`call-actions ${call.isVideo ? "is-video" : ""}`}>
                    <div className="call-action call-audio-action" ref={audioMenuRef}>
                      <button
                        type="button"
                        className={`call-round ${audioMenuOpen || audioRoute !== "speaker" ? "is-on" : ""}`}
                        onClick={() => setAudioMenuOpen((open) => !open)}
                        aria-label="Choose audio output"
                        aria-expanded={audioMenuOpen}
                        aria-haspopup="menu"
                        title="Audio output"
                      >
                        {audioRoute === "bluetooth" ? <FiBluetooth /> : audioRoute === "earpiece" ? <FiSmartphone /> : <FiVolume2 />}
                      </button>
                      <span>Audio</span>
                      {audioMenuOpen && (
                        <div className="call-audio-menu" role="menu" aria-label="Audio output">
                          {[
                            { id: "speaker", label: "Speaker", icon: FiVolume2 },
                            { id: "earpiece", label: "Earpiece", icon: FiSmartphone },
                            { id: "bluetooth", label: "Bluetooth", icon: FiBluetooth },
                          ].filter(({ id }) => {
                            if (id === "speaker" || audioRoute === id) return true;
                            const outputs = audioDevices.filter((device) => device.kind === "audiooutput");
                            const pattern = id === "earpiece" ? /earpiece|receiver|phone/i : /bluetooth|headset|headphone/i;
                            return outputs.some((device) => pattern.test(device.label || "")) ||
                              (id === "bluetooth" && typeof navigator.mediaDevices?.selectAudioOutput === "function");
                          }).map(({ id, label, icon: Icon }) => (
                            <button
                              key={id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={audioRoute === id}
                              className={audioRoute === id ? "is-selected" : ""}
                              onClick={() => changeAudioRoute(id)}
                            >
                              <Icon />
                              <span>{label}</span>
                              {audioRoute === id && <FiCheck className="call-audio-check" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="call-action">
                        <button type="button" className={`call-round ${call.isVideo && !cameraOff ? "" : "is-on"}`} aria-pressed={!call.isVideo || cameraOff} onClick={() => toggleTrack("video")} aria-label={call.isVideo && !cameraOff ? "Turn camera off" : "Turn camera on"}>
                          {call.isVideo && !cameraOff ? <FiVideo /> : <FiVideoOff />}
                        </button>
                        <span>Camera</span>
                      </div>
                    <div className="call-action">
                      <button type="button" className={`call-round ${muted ? "is-on" : ""}`} aria-pressed={muted} onClick={() => toggleTrack("audio")} aria-label={muted ? "Unmute" : "Mute"}>
                        {muted ? <FiMicOff /> : <FiMic />}
                      </button>
                      <span>{muted ? "Unmute" : "Mute"}</span>
                    </div>
                    {call.isVideo && !cameraOff && (
                      <div className="call-action">
                        <button type="button" className="call-round" onClick={flipCamera} aria-label="Switch camera">
                          <FiRefreshCw />
                        </button>
                        <span>Flip</span>
                      </div>
                    )}
                    <div className="call-action">
                      <button type="button" className="call-round is-end" onClick={hangUp} aria-label="End call">
                        <FiPhoneOff />
                      </button>
                      <span>End</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {ended && !call && !incoming && (
            <div className="call-screen call-overlay is-ended" role="status" onClick={() => setEnded(null)}>
              <div className="call-hero">
                <div className="call-avatar">
                  <img src={getImageURL(ended.photo)} alt="" />
                </div>
                <h2 className="call-name">{ended.name || "Call"}</h2>
                <p className="call-status is-ended">{ended.title}</p>
                {ended.subtitle && <p className="call-sub">{ended.subtitle}</p>}
              </div>
            </div>
          )}
        </>,
        portalRoot
      )}
    </>
  );
}

function CallVideo({ stream, label, photo, muted, cameraOff, minimized }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream || null;
    const resumePlayback = () => {
      if (!stream || minimized || document.visibilityState === "hidden") return;
      video.play().catch((error) => {
        if (error?.name !== "NotAllowedError") console.error("Unable to resume remote call video:", error);
      });
    };
    const videoTracks = stream?.getVideoTracks() || [];
    video.addEventListener("loadedmetadata", resumePlayback);
    videoTracks.forEach((track) => track.addEventListener("unmute", resumePlayback));
    document.addEventListener("visibilitychange", resumePlayback);
    window.addEventListener("pageshow", resumePlayback);
    resumePlayback();
    return () => {
      video.removeEventListener("loadedmetadata", resumePlayback);
      videoTracks.forEach((track) => track.removeEventListener("unmute", resumePlayback));
      document.removeEventListener("visibilitychange", resumePlayback);
      window.removeEventListener("pageshow", resumePlayback);
    };
  }, [stream, minimized, cameraOff]);
  return (
    <div className={`call-tile ${cameraOff ? "is-camera-off" : ""}`}>
      {cameraOff ? (
        <div className="call-camera-off-content">
          <div className="call-avatar is-ringing">
            <img src={getImageURL(photo)} alt="" />
          </div>
          <strong>{label}</strong>
          {muted && <span>Muted</span>}
        </div>
      ) : (
        <>
          {/* minimized: the audio element plays this person instead, so the video stays silent (no echo) */}
          <video ref={videoRef} autoPlay playsInline muted={minimized} />
          <span>{label}</span>
          {muted && <span className="call-tile-muted">Muted</span>}
        </>
      )}
    </div>
  );
}

function RemoteAudio({ stream }) {
  const audioRef = useRef(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = stream || null;
    const resumePlayback = () => {
      if (!stream || document.visibilityState === "hidden") return;
      audio.play().catch((error) => {
        if (error?.name === "NotAllowedError") {
          // the browser blocked sound: play on the next tap anywhere
          const unlock = () => { audio.play().catch(() => {}); };
          document.addEventListener("pointerdown", unlock, { once: true, capture: true });
        } else if (error?.name !== "AbortError") console.error("Unable to resume call audio:", error);
      });
    };
    audio.addEventListener("canplay", resumePlayback);
    document.addEventListener("visibilitychange", resumePlayback);
    window.addEventListener("pageshow", resumePlayback);
    resumePlayback();
    return () => {
      audio.removeEventListener("canplay", resumePlayback);
      document.removeEventListener("visibilitychange", resumePlayback);
      window.removeEventListener("pageshow", resumePlayback);
    };
  }, [stream]);
  return <audio ref={audioRef} autoPlay playsInline />;
}
