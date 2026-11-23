import { createHmac } from "crypto";
import mongoose from "mongoose";
import { NextResponse, after } from "next/server";
import { sendPushNotification } from "@/app/lib/pushNotifications";
import { callLogConversationMatch, viewCallLog } from "@/app/lib/callLogs";
import { mongoDB_connect } from "@/app/helpers/helper";
import { getSessionUserId } from "@/app/lib/session";
import { callLogSchema } from "@/app/models/callLogModel";
import { groupMemberSchema } from "@/app/models/groupMemberModel";
import { userSchema } from "@/app/models/userModel";

const objectIdPattern = /^[a-f\d]{24}$/i;
const CALL_PING_TIMEOUT_MS = 3 * 60 * 1000; // background tabs may only tick about once a minute
const callIdPattern = /^[a-f\d-]{36}$/i;

function createCallLogEvent(log, actorId) {
  const secret = process.env.AUTH_SECRET ||
    (process.env.NODE_ENV !== "production" && "local-development-only-secret-change-before-deploy");
  if (!secret) throw new Error("Realtime call history is not configured.");
  const event = {
    actor_id: actorId,
    callId: log.callId,
    conversation_id: String(log.conversationId),
    is_group: Boolean(log.isGroup),
    recipient_ids: log.participants.map(String),
  };
  const issuedAt = Date.now();
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify({ event, issuedAt }))
    .digest("base64url");
  return { ...event, issuedAt, signature };
}

export async function GET(request) {
  const userId = await getSessionUserId(request);
  if (!userId) return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  const searchParams = request.nextUrl.searchParams;
  const conversationId = searchParams.get("conversation_id");
  const isGroup = searchParams.get("is_group");
  if (conversationId && !objectIdPattern.test(conversationId)) {
    return NextResponse.json({ success: false, message: "Invalid conversation." }, { status: 400 });
  }
  if (isGroup !== null && !["0", "1"].includes(isGroup)) {
    return NextResponse.json({ success: false, message: "Invalid conversation type." }, { status: 400 });
  }
  await mongoDB_connect();
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const query = {
    participants: userObjectId,
    deletedFor: { $ne: userObjectId },
    deletedForEveryone: { $ne: true },
  };
  if (conversationId && isGroup !== null) {
    // a direct chat shows every call between the two people, whoever started it
    Object.assign(query, callLogConversationMatch(userObjectId, new mongoose.Types.ObjectId(conversationId), isGroup === "1"));
  } else {
    if (conversationId) query.conversationId = new mongoose.Types.ObjectId(conversationId);
    if (isGroup !== null) query.isGroup = isGroup === "1";
  }
  // an answered call nobody has pinged for a while was cut off (app closed, phone off): close it now
  const staleBefore = new Date(Date.now() - CALL_PING_TIMEOUT_MS);
  await callLogSchema.updateMany(
    {
      participants: userObjectId,
      status: "answered",
      endedAt: { $exists: false },
      answeredAt: { $lt: staleBefore },
      $or: [{ lastPingAt: { $lt: staleBefore } }, { lastPingAt: { $exists: false } }],
    },
    [{
      $set: {
        status: "ended",
        endedAt: { $ifNull: ["$lastPingAt", "$answeredAt"] },
        durationSeconds: {
          $max: [0, { $floor: { $divide: [{ $subtract: [{ $ifNull: ["$lastPingAt", "$answeredAt"] }, "$answeredAt"] }, 1000] } }],
        },
      },
    }]
  );
  const readResult = await callLogSchema.updateMany(
    {
      ...query,
      callerId: { $ne: userObjectId },
      status: "no-answer",
      readBy: { $ne: userObjectId },
    },
    { $addToSet: { readBy: userObjectId } }
  );
  const data = await callLogSchema.find(query).sort({ startedAt: -1 }).limit(conversationId ? 100 : 50).lean();
  const withNames = searchParams.get("with_names") === "1";
  let enriched = data.map((log) => viewCallLog(log, userId));
  if (withNames && !conversationId) {
    // attach name/photo/nickname for the conversation partner (direct) or group
    const directIds = [...new Set(
      enriched.filter((l) => !l.isGroup).map((l) => String(l.conversationId)).filter(Boolean)
    )];
    const groupIds = [...new Set(
      enriched.filter((l) => l.isGroup).map((l) => String(l.conversationId)).filter(Boolean)
    )];
    const [users, groups] = await Promise.all([
      directIds.length
        ? userSchema.find({ _id: { $in: directIds } }).select("name nickname photo email phone").lean()
        : Promise.resolve([]),
      groupIds.length
        ? (await import("@/app/models/groupModel")).groupSchema
            .find({ _id: { $in: groupIds } }).select("name photo").lean()
        : Promise.resolve([]),
    ]);
    const userMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
    const groupMap = Object.fromEntries(groups.map((g) => [String(g._id), g]));
    enriched = enriched.map((log) => {
      const info = log.isGroup ? groupMap[String(log.conversationId)] : userMap[String(log.conversationId)];
      return info ? { ...log, name: info.nickname || info.name, photo: info.photo, nickname: info.nickname, email: info.email, phone: info.phone } : log;
    });
  }
  return NextResponse.json({
    success: true,
    data: enriched,
    callsMarkedRead: readResult.modifiedCount > 0,
  });
}

export async function DELETE(request) {
  const userId = await getSessionUserId(request);
  if (!userId) return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request body." }, { status: 400 });
  }
  const callId = String(body?.callId || "");
  const mode = body?.mode;
  if (!callIdPattern.test(callId) || !["for-me", "everyone"].includes(mode)) {
    return NextResponse.json({ success: false, message: "Invalid call log deletion." }, { status: 400 });
  }

  await mongoDB_connect();
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const log = await callLogSchema.findOne({
    callId,
    participants: userObjectId,
    deletedFor: { $ne: userObjectId },
    deletedForEveryone: { $ne: true },
  }).select("callerId conversationId isGroup participants");
  if (!log) return NextResponse.json({ success: false, message: "Call log not found." }, { status: 404 });

  if (mode === "everyone" && !log.callerId.equals(userObjectId)) {
    return NextResponse.json({ success: false, message: "Only the caller can delete this call log for everyone." }, { status: 403 });
  }
  const secret = process.env.AUTH_SECRET ||
    (process.env.NODE_ENV !== "production" && "local-development-only-secret-change-before-deploy");
  if (!secret) {
    return NextResponse.json({ success: false, message: "Realtime call log deletion is not configured." }, { status: 500 });
  }
  if (mode === "everyone") {
    await callLogSchema.updateOne(
      { _id: log._id, deletedForEveryone: { $ne: true } },
      { $set: { deletedForEveryone: true } }
    );
  } else {
    await callLogSchema.updateOne(
      { _id: log._id },
      { $addToSet: { deletedFor: userObjectId } }
    );
  }

  const event = {
    actor_id: userId,
    callId,
    conversation_id: String(log.conversationId),
    is_group: Boolean(log.isGroup),
    recipient_ids: mode === "everyone" ? log.participants.map(String) : [userId],
  };
  const issuedAt = Date.now();
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify({ event, issuedAt }))
    .digest("base64url");
  return NextResponse.json({ success: true, socket_event: { ...event, issuedAt, signature } });
}

export async function POST(request) {
  const userId = await getSessionUserId(request);
  if (!userId) return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request body." }, { status: 400 });
  }
  const action = body?.action;
  const callId = String(body?.callId || "");
  if (!callIdPattern.test(callId) || !["start", "answered", "ended", "no-answer", "declined", "upgrade-video", "ping"].includes(action)) {
    return NextResponse.json({ success: false, message: "Invalid call log update." }, { status: 400 });
  }

  await mongoDB_connect();
  const userObjectId = new mongoose.Types.ObjectId(userId);
  if (action === "start") {
    const conversationId = String(body.conversationId || "");
    const isGroup = Boolean(body.isGroup);
    if (body.callerId !== userId || !objectIdPattern.test(conversationId) || !Array.isArray(body.participants)) {
      return NextResponse.json({ success: false, message: "Invalid call participants." }, { status: 400 });
    }
    const conversationObjectId = new mongoose.Types.ObjectId(conversationId);
    let allowedParticipants;
    if (isGroup) {
      if (!(await groupMemberSchema.exists({ group_id: conversationObjectId, user_id: userObjectId, status: 1 }))) {
        return NextResponse.json({ success: false, message: "You are not a member of this group." }, { status: 403 });
      }
      allowedParticipants = (await groupMemberSchema.find({ group_id: conversationObjectId, status: 1 }).distinct("user_id")).map(String);
    } else {
      if (conversationId === userId || !(await userSchema.exists({ _id: conversationObjectId, status: 1 }))) {
        return NextResponse.json({ success: false, message: "Conversation partner not found." }, { status: 404 });
      }
      allowedParticipants = [userId, conversationId];
    }
    const participants = [...new Set(body.participants.map(String))];
    if (!participants.includes(userId) || participants.length > 8 || participants.some((id) => !allowedParticipants.includes(id))) {
      return NextResponse.json({ success: false, message: "Invalid call participants." }, { status: 400 });
    }
    const log = await callLogSchema.findOneAndUpdate(
      { callId, callerId: userObjectId },
      {
        $setOnInsert: {
          callId,
          callerId: userObjectId,
          conversationId: conversationObjectId,
          isGroup,
          isVideo: Boolean(body.isVideo),
          participants: participants.map((id) => new mongoose.Types.ObjectId(id)),
          status: "ringing",
          startedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
    after(async () => {
      try {
        const targets = participants.filter((id) => id !== userId);
        if (!targets.length) return;
        const muted = new Set((await userSchema.find({
          _id: { $in: targets.map((id) => new mongoose.Types.ObjectId(id)) },
          mutedConversations: conversationObjectId,
        }).distinct("_id")).map(String));
        const recipients = targets.filter((id) => !muted.has(id));
        if (!recipients.length) return;
        const caller = await userSchema.findById(userId).select("name").lean();
        const ticketId = isGroup ? conversationId : userId;
        await sendPushNotification(recipients, () => ({
          title: `Incoming ${body.isVideo ? "Video" : "Voice"} Call`,
          body: caller?.name || "Someone is calling you",
          url: `/?ticket=${ticketId}&is_group=${isGroup ? "1" : "0"}`,
          tag: `incoming-${callId}`,
        }));
      } catch (error) {
        console.error("Unable to send an incoming-call notification:", error);
      }
    });
    return NextResponse.json({ success: true, socket_event: createCallLogEvent(log, userId) });
  }

  const log = await callLogSchema.findOne({ callId, participants: userObjectId });
  if (!log) return NextResponse.json({ success: false, message: "Call not found." }, { status: 404 });
  if (action === "ping") {
    // an answered call is still running: the person's app says so every few seconds
    await callLogSchema.updateOne(
      { callId, participants: userObjectId, endedAt: { $exists: false }, status: "answered" },
      { $set: { lastPingAt: new Date() } }
    );
    return NextResponse.json({ success: true });
  }
  if (action === "upgrade-video") {
    await callLogSchema.updateOne(
      { callId, participants: userObjectId, deletedForEveryone: { $ne: true } },
      { $set: { isVideo: true } }
    );
    const updatedLog = await callLogSchema.findOne({ callId, participants: userObjectId }).select("callerId conversationId isGroup participants").lean();
    if (updatedLog) {
      const socketEvent = createCallLogEvent(updatedLog, userId);
      return NextResponse.json({ success: true, socket_event: socketEvent });
    }
    return NextResponse.json({ success: true });
  }

    if (action === "answered") {
    if (log.endedAt) {
      return NextResponse.json({ success: true, socket_event: createCallLogEvent(log, userId) });
    }
    log.status = "answered";
    if (!log.answeredAt) log.answeredAt = new Date();
  } else {
    if (log.endedAt) return NextResponse.json({ success: true });
    log.status = action;
    log.endedAt = new Date();
    log.durationSeconds = log.answeredAt
      ? Math.max(0, Math.floor((log.endedAt.getTime() - log.answeredAt.getTime()) / 1000))
      : 0;
  }
  await log.save();
  return NextResponse.json({ success: true, socket_event: createCallLogEvent(log, userId) });
}
