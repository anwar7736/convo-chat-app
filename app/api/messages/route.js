import { mongoDB_connect } from "@/app/helpers/helper";
import { getSessionUserId } from "@/app/lib/session";
import { messageSchema } from "@/app/models/messageModel";
import { messageLogSchema } from "@/app/models/messageLogModel";
import { callLogSchema } from "@/app/models/callLogModel";
import { groupMemberSchema } from "@/app/models/groupMemberModel";
import { groupSchema } from "@/app/models/groupModel";
import { userSchema } from "@/app/models/userModel";
import { sendPushNotification } from "@/app/lib/pushNotifications";
import { createHmac } from "crypto";
import mongoose from "mongoose";
import { NextResponse, after } from "next/server";
import { callLogConversationMatch, viewCallLog } from "@/app/lib/callLogs";
import { getUnreadNotificationCounts } from "@/app/lib/unreadNotificationCounts";

const objectIdPattern = /^[a-f\d]{24}$/i;

export async function GET(request) {
  const sessionUserId = await getSessionUserId(request);
  const query = request.nextUrl.searchParams;
  const requestedAuthId = query.get("auth_id");
  const refId = query.get("ref_id");
  const isGroup = query.get("is_group") === "1";
  if (!sessionUserId || (requestedAuthId && requestedAuthId !== sessionUserId)) {
    return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });
  }
  if (!refId || !objectIdPattern.test(refId)) {
    return NextResponse.json({ success: false, data: [], message: "A valid conversation is required." }, { status: 400 });
  }

  await mongoDB_connect();
  const currentUserId = new mongoose.Types.ObjectId(sessionUserId);
  const referenceId = new mongoose.Types.ObjectId(refId);
  let match;
  let unreadLogs;
  const markRead = query.get("mark_read") !== "0";
  const allMessages = query.get("all") === "1";
  const requestedOffset = Number(query.get("offset") || 0);
  // `limit` (1-500): how many of the newest messages to return; the app opens a chat with a small window and asks for
  // more as the person scrolls up, so opening a chat is fast. Without it the old 200 applies.
  const requestedLimit = Number(query.get("limit"));
  const messageLimit = allMessages
    ? 500
    : Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 500 ? requestedLimit : 200;
  const messageOffset = allMessages && Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;
  // Marking messages read does not hold up reading them: the update runs alongside the rest, and the messages in the
  // answer are shown as read exactly as if it had finished first (it is awaited before the answer is sent).
  let markReadDone = Promise.resolve();
  if (isGroup) {
    const [membership, found] = await Promise.all([
      groupMemberSchema.exists({ group_id: referenceId, user_id: currentUserId, status: 1 }),
      markRead ? messageLogSchema.find({
        group_id: referenceId,
        receiver_id: currentUserId,
        status: 0,
      }).select("message_id sender_id").limit(200).lean() : [],
    ]);
    if (!membership) return NextResponse.json({ success: false, message: "You are not a member of this group." }, { status: 403 });
    unreadLogs = found;
    if (markRead) markReadDone = messageLogSchema.updateMany(
      { group_id: referenceId, receiver_id: currentUserId, status: 0 },
      { $set: { status: 1 } }
    );
    match = { group_id: referenceId, receiver_id: currentUserId };
  } else {
    unreadLogs = markRead ? await messageLogSchema.find({
      sender_id: referenceId,
      receiver_id: currentUserId,
      group_id: { $exists: false },
      status: 0,
    }).select("message_id sender_id").sort({ createdAt: -1 }).limit(200).lean() : [];
    if (markRead) markReadDone = messageLogSchema.updateMany(
      { sender_id: referenceId, receiver_id: currentUserId, group_id: { $exists: false }, status: 0 },
      { $set: { status: 1 } }
    );
    match = {
      $and: [
        { $or: [{ group_id: null }, { group_id: { $exists: false } }] },
        { $or: [
          { sender_id: currentUserId, receiver_id: referenceId },
          { sender_id: referenceId, receiver_id: currentUserId },
        ] },
      ],
    };
  }

  const messagePipeline = [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    ...(messageOffset ? [{ $skip: messageOffset }] : []),
    { $limit: messageLimit },
    { $lookup: { from: "messages", localField: "message_id", foreignField: "_id", as: "message" } },
    { $unwind: "$message" },
    // who has seen the message: only the receipts that count (seen, by someone other than you and the sender) come
    // back from the database, instead of every receipt of every message
    {
      $lookup: {
        from: "message_logs",
        let: { mid: "$message_id", sid: "$sender_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$message_id", "$$mid"] },
                  { $eq: ["$status", 1] },
                  { $ne: ["$receiver_id", currentUserId] },
                  { $ne: ["$receiver_id", "$$sid"] },
                ],
              },
            },
          },
          { $project: { _id: 0, receiver_id: 1 } },
        ],
        as: "message_receipts",
      },
    },
    { $addFields: { seen_by_ids: "$message_receipts.receiver_id" } },
    {
      $project: {
        _id: 1,
        message_id: 1,
        status: 1,
        seen_by_ids: 1,
        group_id: 1,
        sender_id: 1,
        receiver_id: 1,
        "message._id": 1,
        "message.sender_id": 1,
        "message.message": 1,
        "message.type": 1,
        "message.attachmentUrl": 1,
        "message.attachmentName": 1,
        "message.mimeType": 1,
        "message.durationSeconds": 1,
        "message.reply_to": 1,
        "message.reactions": 1,
        "message.createdAt": 1,
        "message.editedAt": 1,
        "message.deletedForEveryone": 1,
        "message.hiddenFor": 1,
      },
    },
    { $sort: { "message.createdAt": 1, "message._id": 1 } },
  ];
  const [data, callLogs] = await Promise.all([
    messageLogSchema.aggregate(messagePipeline),
    !isGroup && referenceId.equals(currentUserId) ? [] : callLogSchema.find({
      participants: currentUserId,
      ...callLogConversationMatch(currentUserId, referenceId, isGroup),
      deletedFor: { $ne: currentUserId },
      deletedForEveryone: { $ne: true },
    })
      .select("callId callerId conversationId participants isGroup isVideo status startedAt answeredAt endedAt durationSeconds")
      .sort({ startedAt: -1 })
      .limit(100)
      .lean(),
  ]);

  await markReadDone;
  if (markRead) {
    // the read-marking ran alongside the query: show your own unread messages as read, as if it had finished first
    for (const item of data) {
      if (item.status === 0 && String(item.receiver_id) === sessionUserId) item.status = 1;
    }
  }

  const visibleData = data.filter((item) =>
    item.status !== 2 &&
    !(item.message?.hiddenFor || []).some((id) => String(id) === sessionUserId)
  );
  // names and photos of everyone shown (senders, receivers, who saw it, who reacted) in one query, plus the group
  const memberIds = new Set();
  for (const item of visibleData) {
    memberIds.add(String(item.sender_id));
    memberIds.add(String(item.receiver_id));
    for (const id of item.seen_by_ids || []) memberIds.add(String(id));
    for (const reaction of item.message?.reactions || []) memberIds.add(String(reaction.user_id));
  }
  const [memberProfiles, groupDoc] = await Promise.all([
    memberIds.size
      ? userSchema.find({ _id: { $in: [...memberIds].map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("name photo").lean()
      : [],
    isGroup && visibleData.length
      ? groupSchema.findById(referenceId).select("name photo short_desc").lean()
      : null,
  ]);
  const profilesById = new Map(memberProfiles.map((profile) => [String(profile._id), profile]));
  const personOf = (id) => {
    const profile = profilesById.get(String(id));
    return profile ? { _id: profile._id, name: profile.name, photo: profile.photo } : null;
  };
  // an entry whose sender or receiver no longer exists is left out (as the joined lookup did before)
  const enrichedData = visibleData.filter((item) => personOf(item.sender_id) && personOf(item.receiver_id)).map((item) => {
    const seenBy = (item.seen_by_ids || [])
      .map((id) => profilesById.get(String(id)))
      .filter(Boolean)
      .map((profile) => ({ _id: String(profile._id), name: profile.name, photo: profile.photo }));
    const reactions = (item.message?.reactions || []).map((reaction) => {
      const profile = profilesById.get(String(reaction.user_id));
      return {
        user_id: String(reaction.user_id),
        emoji: reaction.emoji,
        ...(profile ? { name: profile.name, photo: profile.photo } : {}),
      };
    });
    return {
      ...item,
      sender: personOf(item.sender_id),
      receiver: personOf(item.receiver_id),
      ...(item.group_id && groupDoc
        ? { group: { _id: groupDoc._id, name: groupDoc.name, photo: groupDoc.photo, short_desc: groupDoc.short_desc } }
        : {}),
      seen_by: seenBy,
      message: { ...item.message, reactions, hiddenFor: undefined },
      seen_by_ids: undefined,
      sender_id: undefined,
      receiver_id: undefined,
      group_id: undefined,
    };
  });

  // a reply whose original message is older than this window still shows what it answers
  const loadedMessageIds = new Set(enrichedData.map((item) => String(item.message_id)));
  const missingParentIds = [...new Set(enrichedData
    .map((item) => item.message?.reply_to)
    .filter((id) => id && !loadedMessageIds.has(String(id)))
    .map(String))];
  if (missingParentIds.length) {
    const parents = await messageSchema.find({ _id: { $in: missingParentIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("sender_id message attachmentName deletedForEveryone").lean();
    const parentSenders = await userSchema.find({ _id: { $in: parents.map((parent) => parent.sender_id).filter(Boolean) } })
      .select("name").lean();
    const senderNames = new Map(parentSenders.map((person) => [String(person._id), person.name]));
    const previews = new Map(parents.map((parent) => [String(parent._id), {
      sender_id: String(parent.sender_id),
      sender_name: senderNames.get(String(parent.sender_id)) || "",
      text: parent.deletedForEveryone ? "" : parent.message || parent.attachmentName || "",
    }]));
    for (const item of enrichedData) {
      const preview = previews.get(String(item.message?.reply_to));
      if (preview) item.message = { ...item.message, reply_preview: preview };
    }
  }

  const unreadBySender = new Map();
  for (const log of unreadLogs || []) {
    const senderId = String(log.sender_id);
    if (senderId === sessionUserId) continue;
    const ids = unreadBySender.get(senderId) || [];
    ids.push(String(log.message_id));
    unreadBySender.set(senderId, ids);
  }
  const actor = unreadBySender.size
    ? await userSchema.findById(currentUserId).select("name photo").lean()
    : null;
  const secret = process.env.AUTH_SECRET ||
    (process.env.NODE_ENV !== "production" && "local-development-only-secret-change-before-deploy");
  const issuedAt = Date.now();
  const seenEvents = secret && actor
    ? [...unreadBySender.entries()].map(([senderId, messageIds]) => {
      const event = {
        actor_id: sessionUserId,
        actor_name: actor.name || "Someone",
        actor_photo: actor.photo || "",
        message_ids: messageIds,
        recipient_ids: [senderId],
      };
      const signature = createHmac("sha256", secret)
        .update(JSON.stringify({ event, issuedAt }))
        .digest("base64url");
      return { ...event, issuedAt, signature };
    })
    : [];

  return NextResponse.json({
    success: true,
    data: enrichedData,
    call_logs: callLogs.map((log) => viewCallLog(log, sessionUserId)),
    seen_events: seenEvents,
    has_more: data.length === messageLimit,
  });
}

export async function POST(request) {
  const sessionUserId = await getSessionUserId(request);
  if (!sessionUserId) return NextResponse.json({ success: false, message: "Unauthorized." }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid request body." }, { status: 400 });
  }
  const { receiver_id, is_group, attachmentUrl, attachmentName, mimeType, type } = body;
  const durationSeconds = Number(body.durationSeconds);
  const replyTo = typeof body.reply_to === "string" && objectIdPattern.test(body.reply_to)
    ? new mongoose.Types.ObjectId(body.reply_to)
    : null;
  const text = typeof body.message === "string" ? body.message.trim() : "";
  const isGroup = is_group === 1 || is_group === true;
  if (!receiver_id || !objectIdPattern.test(receiver_id) || (!text && !attachmentUrl) || text.length > 5000) {
    return NextResponse.json({ success: false, message: "A valid recipient and message are required." }, { status: 400 });
  }
  if (attachmentUrl && !new RegExp(`^/api/attachments/${sessionUserId}_[a-f0-9-]+\\.(jpg|png|gif|webp|webm|ogg|mp3|m4a|mp4|mov|pdf)$`, "i").test(attachmentUrl)) {
    return NextResponse.json({ success: false, message: "Invalid attachment." }, { status: 400 });
  }
  const allowedTypes = ["text", "image", "audio", "video", "file"];
  if (type && !allowedTypes.includes(type)) {
    return NextResponse.json({ success: false, message: "Invalid message type." }, { status: 400 });
  }
  if (
    type === "audio" &&
    body.durationSeconds != null &&
    (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 7200)
  ) {
    return NextResponse.json({ success: false, message: "Invalid audio duration." }, { status: 400 });
  }

  await mongoDB_connect();
  const senderId = new mongoose.Types.ObjectId(sessionUserId);
  const receiverId = new mongoose.Types.ObjectId(receiver_id);
  if (attachmentUrl && await messageSchema.exists({ attachmentUrl })) {
    return NextResponse.json({ success: false, message: "This attachment has already been sent." }, { status: 409 });
  }
  if (isGroup) {
    const member = await groupMemberSchema.exists({ group_id: receiverId, user_id: senderId, status: 1 });
    if (!member) return NextResponse.json({ success: false, message: "You are not a member of this group." }, { status: 403 });
    if (replyTo && !(await messageLogSchema.exists({ message_id: replyTo, group_id: receiverId, receiver_id: senderId }))) {
      return NextResponse.json({ success: false, message: "The message you are replying to is unavailable." }, { status: 400 });
    }
  } else if (senderId.equals(receiverId)) {
    // a note to yourself, like WhatsApp: nothing to block-check
  } else {
    const [senderProfile, receiverProfile] = await Promise.all([
      userSchema.findById(senderId).select("blockedUsers").lean(),
      userSchema.findOne({ _id: receiverId, status: 1 }).select("blockedUsers").lean(),
    ]);
    if (!receiverProfile) {
      return NextResponse.json({ success: false, message: "Recipient not found." }, { status: 404 });
    }
    const blockedBySender = (senderProfile?.blockedUsers || []).some((id) => String(id) === String(receiverId));
    const blockedByReceiver = (receiverProfile.blockedUsers || []).some((id) => String(id) === String(senderId));
    if (blockedBySender || blockedByReceiver) {
      return NextResponse.json({
        success: false,
        message: blockedBySender ? "Unblock this contact before sending messages." : "This contact has blocked you.",
      }, { status: 403 });
    }
  }
  if (!isGroup && replyTo && !(await messageLogSchema.exists({
      message_id: replyTo,
      $or: [
        { sender_id: senderId, receiver_id: receiverId },
        { sender_id: receiverId, receiver_id: senderId },
      ],
      group_id: { $exists: false },
    }))) {
    return NextResponse.json({ success: false, message: "The message you are replying to is unavailable." }, { status: 400 });
  }

  const message = await messageSchema.create({
    sender_id: senderId,
    ...(isGroup ? { group_id: receiverId } : {}),
    message: text,
    type: type || (attachmentUrl ? "file" : "text"),
    attachmentUrl,
    attachmentName: typeof attachmentName === "string" ? attachmentName.slice(0, 180) : undefined,
    mimeType: typeof mimeType === "string" ? mimeType.slice(0, 100) : undefined,
    ...(type === "audio" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds: Math.round(durationSeconds) }
      : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  let logs;
  let recipientIds;
  if (isGroup) {
    const members = await groupMemberSchema.find({ group_id: receiverId, status: 1 }).select("user_id").lean();
    logs = members.map(({ user_id }) => ({
      message_id: message._id,
      group_id: receiverId,
      sender_id: senderId,
      receiver_id: user_id,
      status: senderId.equals(user_id) ? 1 : 0,
    }));
    if (logs.length) await messageLogSchema.insertMany(logs, { ordered: true });
    // the socket server sends the real-time notice (ids only) to these members alone
    recipientIds = members.map(({ user_id }) => String(user_id)).filter((id) => id !== sessionUserId);
  } else {
    await messageLogSchema.create({
      message_id: message._id,
      sender_id: senderId,
      receiver_id: receiverId,
      ...(senderId.equals(receiverId) ? { status: 1 } : {}),
    });
  }

  // Notification like WhatsApp: "<sender>" (or "<sender> @ <group>") with the text; tapping it opens that chat.
  // For a direct message the chat to open on the receiver's phone is the SENDER's (receiver_id is the receiver).
  after(async () => {
  const candidatePushRecipients = (isGroup ? recipientIds : [receiver_id]).filter((id) => id !== sessionUserId);
  const mutedUsers = candidatePushRecipients.length
    ? await userSchema.find({
      _id: { $in: candidatePushRecipients.map((id) => new mongoose.Types.ObjectId(id)) },
      mutedConversations: receiverId,
    }).distinct("_id")
    : [];
  const mutedUserIds = new Set(mutedUsers.map(String));
  const pushRecipients = candidatePushRecipients.filter((id) => !mutedUserIds.has(id));
  const unreadByUser = await getUnreadNotificationCounts(pushRecipients);
  const notificationBody = text || (type === "image" ? "📷 Photo" : type === "audio" ? "🎤 Voice message" : type === "video" ? "🎥 Video" : "📎 Attachment");
  const ticketId = isGroup ? receiver_id : sessionUserId;
  const [senderInfo, groupInfo] = await Promise.all([
    userSchema.findById(senderId).select("name").lean(),
    isGroup ? groupSchema.findById(receiverId).select("name").lean() : null,
  ]).catch(() => [null, null]);
  const senderName = senderInfo?.name || "New message";
  // in a direct chat each person sees the nickname they gave the sender, as in the app
  const nicknameBy = new Map();
  if (!isGroup && pushRecipients.length) {
    const holders = await userSchema.find({ _id: { $in: pushRecipients.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("nicknames").lean().catch(() => []);
    for (const holder of holders) {
      const map = holder.nicknames instanceof Map ? Object.fromEntries(holder.nicknames) : holder.nicknames || {};
      if (map[sessionUserId]) nicknameBy.set(String(holder._id), String(map[sessionUserId]));
    }
  }
  await sendPushNotification(pushRecipients, (recipientId) => ({
    title: isGroup ? `${senderName} @ ${groupInfo?.name || "Group"}` : nicknameBy.get(recipientId) || senderName,
    body: notificationBody.slice(0, 180),
    url: `/?ticket=${encodeURIComponent(ticketId)}&is_group=${isGroup ? "1" : "0"}`,
    // one notification per chat, like WhatsApp: new messages join it (the service worker stacks them)
    tag: `chat-${ticketId}`,
    ticket: String(ticketId),
    isGroup: isGroup ? 1 : 0,
    badge: unreadByUser.get(recipientId) || 0,
    socketUrl: process.env.NEXT_PUBLIC_SOCKET_URL || "",
    messageId: String(message._id),
  })).catch((error) => console.error("Unable to prepare a Web Push notification:", error));
  });

  return NextResponse.json({
    success: true,
    data: {
      sender_id: sessionUserId,
      receiver_id,
      is_group: isGroup ? 1 : 0,
      ...(isGroup ? { recipient_ids: recipientIds } : {}),
    },
  });
}

export async function PUT() {
  return NextResponse.json({ success: false, message: "This operation is not supported." }, { status: 405 });
}
