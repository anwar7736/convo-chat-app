import { mongoDB_connect } from "@/app/helpers/helper";
import { userSchema } from "@/app/models/userModel";
import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { groupMemberSchema } from "@/app/models/groupMemberModel";
import { messageLogSchema } from "@/app/models/messageLogModel";
import { messageSchema } from "@/app/models/messageModel";
import { callLogSchema } from "@/app/models/callLogModel";
import { getSessionUserId } from "@/app/lib/session";
import { getUnreadNotificationCounts } from "@/app/lib/unreadNotificationCounts";

export async function GET(request) {
    const userId = await getSessionUserId(request);
    const queryParams = request.nextUrl.searchParams;
    const auth_id = queryParams.get('auth_id');
    const search = (queryParams.get('search') || '').trim().slice(0, 100);
    if (!userId || (auth_id && auth_id !== userId)) {
        return NextResponse.json({ success: false, message: 'Unauthorized.' }, { status: 401 });
    }
    await mongoDB_connect();
    const unreadCounts = await getUnreadNotificationCounts([userId]);
    const authObjectId = new mongoose.Types.ObjectId(userId);
    const currentUser = await userSchema.findById(authObjectId)
        .select("nicknames archivedConversations blockedUsers")
        .lean();
    const nicknames = currentUser?.nicknames instanceof Map
        ? Object.fromEntries(currentUser.nicknames)
        : currentUser?.nicknames || {};
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nicknameMatchIds = search
        ? Object.entries(nicknames)
            .filter(([id, nick]) => mongoose.isValidObjectId(id) && String(nick || '').toLowerCase().includes(search.toLowerCase()))
            .map(([id]) => new mongoose.Types.ObjectId(id))
        : [];
    // People you have chatted with (with no search the list shows only them), and the groups you belong to: these
    // are worked out first so the heavy lookups below only touch your own conversations, not every user and group
    const directConversations = await messageLogSchema.aggregate([
        {
            $match: {
                group_id: null,
                $or: [
                    { sender_id: authObjectId },
                    { receiver_id: authObjectId },
                ],
            },
        },
        {
            $group: {
                _id: {
                    $cond: [
                        { $eq: ["$sender_id", authObjectId] },
                        "$receiver_id",
                        "$sender_id",
                    ],
                },
                last_activity: { $max: "$createdAt" },
            },
        },
    ]);
    const myGroupIds = await groupMemberSchema.find({ user_id: authObjectId, status: 1 }).distinct("group_id");
    const userMatch = {
        $or: [
            { name: { $regex: new RegExp(escapedSearch, 'i') } },
            { email: { $regex: new RegExp(escapedSearch, 'i') } },
            { phone: { $regex: new RegExp(escapedSearch, 'i') } },
            ...(nicknameMatchIds.length ? [{ _id: { $in: nicknameMatchIds } }] : []),
        ],
    };
    // with a search every user can match (and the old per-user activity is used to order strangers); without one only
    // people with a chat are listed, and their unread count is all that is needed from the messages
    const userStages = search ? [
        { $match: userMatch },
        {
            $lookup: {
                from: "message_logs",
                localField: "_id",
                foreignField: "sender_id",
                as: "message_logs"
            }
        },
        {
            $addFields: {
                last_activity: {
                    $max: "$message_logs.createdAt" // Find the most recent activity
                },
                pending: {
                    $size: {
                        $filter: {
                            input: "$message_logs",
                            as: "log",
                            cond: {
                                $and: [
                                    {
                                        $or: [
                                            { $eq: ["$$log.group_id", null] },
                                            { $not: { $ifNull: ["$$log.group_id", false] } }
                                        ]
                                    },
                                    { $eq: ["$$log.status", 0] },
                                    { $eq: ["$$log.receiver_id", authObjectId] }
                                ]
                            }
                        }
                    }
                },
                is_group: 0,
                total_members: 0
            }
        },
    ] : [
        { $match: { $and: [userMatch, { _id: { $in: directConversations.map((item) => item._id) } }] } },
        {
            $lookup: {
                from: "message_logs",
                let: { uid: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$sender_id", "$$uid"] },
                                    { $eq: ["$receiver_id", authObjectId] },
                                    { $eq: ["$status", 0] },
                                    { $eq: [{ $ifNull: ["$group_id", null] }, null] },
                                ],
                            },
                        },
                    },
                    { $count: "n" },
                ],
                as: "pending_count",
            },
        },
        {
            $addFields: {
                last_activity: null,
                pending: { $ifNull: [{ $arrayElemAt: ["$pending_count.n", 0] }, 0] },
                is_group: 0,
                total_members: 0,
            },
        },
    ];
    let data = await userSchema.aggregate([
        // User Query
        ...userStages,
        {
            $project: {
                _id: 1,
                name: 1,
                photo: 1,
                lastSeenAt: 1,
                pending: 1,
                last_activity: 1,
                is_group: 1,
                total_members: 1
            }
        },
        // Union with Group Query
        {
            $unionWith: {
                coll: "groups", // Replace with your actual group collection name
                pipeline: [
                    { $match: { _id: { $in: myGroupIds } } },
                    {
                        $lookup: {
                            from: "group_members",
                            localField: "_id",
                            foreignField: "group_id",
                            as: "members"
                        }
                    },
                    {
                        $match: {
                            members: {
                                $elemMatch: {
                                    user_id: authObjectId,
                                    status: 1 // Active member
                                }
                            }
                        }
                    },
                    // Add a stage to count the total group members
                    {
                        $addFields: {
                            total_members: {
                                $size: {
                                    $filter: {
                                        input: "$members",
                                        as: "member",
                                        cond: { $eq: ["$$member.status", 1] }
                                    }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            member_ids: {
                                $map: {
                                    input: { $filter: { input: "$members", as: "member", cond: { $eq: ["$$member.status", 1] } } },
                                    as: "member",
                                    in: "$$member.user_id"
                                }
                            }
                        }
                    },
            
                    {
                        // the group's newest activity and your unread count, worked out inside the database instead of
                        // loading every member's copy of every message into memory
                        $lookup: {
                            from: "message_logs",
                            let: { gid: "$_id" },
                            pipeline: [
                                { $match: { $expr: { $eq: ["$group_id", "$$gid"] } } },
                                {
                                    $group: {
                                        _id: null,
                                        last_activity: { $max: "$createdAt" },
                                        pending: {
                                            $sum: {
                                                $cond: [
                                                    { $and: [{ $eq: ["$status", 0] }, { $eq: ["$receiver_id", authObjectId] }] },
                                                    1,
                                                    0,
                                                ],
                                            },
                                        },
                                    },
                                },
                            ],
                            as: "log_summary"
                        }
                    },
                    {
                        $addFields: {
                            last_activity: { $ifNull: [{ $arrayElemAt: ["$log_summary.last_activity", 0] }, null] },
                            pending: { $ifNull: [{ $arrayElemAt: ["$log_summary.pending", 0] }, 0] },
                            is_group: 1 // Flag for group
                        }
                    },
                    {
                        $match: {
                            name: { $regex: new RegExp(escapedSearch, 'i') }
                        }
                    },
                    {
                        $project: {
                            _id: 1,
                            name: 1,
                            photo: 1,
                            member_ids: 1,
                            pending: 1,
                            last_activity: 1,
                            is_group: 1,
                            total_members: 1
                        }
                    }
                ]
            }
        },
        // Sort combined results by last_activity
        {
            $sort: { last_activity: -1 }
        }
    ]);
    
    const directActivity = new Map(
        directConversations.map((item) => [String(item._id), item.last_activity])
    );
    const conversationKey = (id, isGroup) =>
        `${Number(isGroup) === 1 ? 1 : 0}:${String(id)}`;
    const visibleConversations = data
        .filter((item) =>
            Number(item.is_group) === 1 ||
            directActivity.has(String(item._id)) ||
            Boolean(search)
        );
    // The newest message you can see in each conversation. Only the latest few messages of each chat are read (by
    // index) and checked, instead of looking up every message you have ever had.
    const latestVisibleMessage = async (item) => {
        const isGroup = Number(item.is_group) === 1;
        const logFilter = isGroup
            ? { receiver_id: authObjectId, group_id: item._id }
            : {
                group_id: null,
                $or: [
                    { sender_id: authObjectId, receiver_id: item._id },
                    { sender_id: item._id, receiver_id: authObjectId },
                ],
            };
        const logs = (await messageLogSchema.find(logFilter)
            .sort({ createdAt: -1 })
            .limit(60)
            .select("message_id sender_id group_id status createdAt")
            .lean()).filter((log) => log.status !== 2);
        if (!logs.length) return null;
        const messageDocs = await messageSchema.find({ _id: { $in: logs.map((log) => log.message_id) } })
            .select("message type attachmentName durationSeconds createdAt deletedForEveryone hiddenFor")
            .lean();
        const byId = new Map(messageDocs.map((doc) => [String(doc._id), doc]));
        const candidates = logs
            .map((log) => ({ log, message: byId.get(String(log.message_id)) }))
            .filter(({ message }) => message &&
                message.deletedForEveryone !== true &&
                !(message.hiddenFor || []).some((id) => String(id) === String(authObjectId)))
            .sort((a, b) => (new Date(b.message.createdAt) - new Date(a.message.createdAt)) ||
                String(b.message._id).localeCompare(String(a.message._id)));
        const best = candidates[0];
        if (!best) return null;
        return {
            _id: item._id,
            message_id: best.log.message_id,
            sender_id: best.log.sender_id,
            status: best.log.status,
            createdAt: best.message.createdAt,
            group_id: best.log.group_id,
            text: best.message.message,
            type: best.message.type,
            attachmentName: best.message.attachmentName,
            durationSeconds: best.message.durationSeconds,
        };
    };
    const withMessages = visibleConversations.filter((item) =>
        Number(item.is_group) === 1 || directActivity.has(String(item._id)));
    const recentLogs = [];
    for (let start = 0; start < withMessages.length; start += 20) {
        const batch = await Promise.all(withMessages.slice(start, start + 20).map(latestVisibleMessage));
        recentLogs.push(...batch.filter(Boolean));
    }
    const recentCalls = visibleConversations.length
        ? await callLogSchema.aggregate([
            {
                $match: {
                    participants: authObjectId,
                    deletedFor: { $ne: authObjectId },
                    deletedForEveryone: { $ne: true },
                    // group calls by group id; direct calls by the other person, whoever started the call
                    $or: [
                        { isGroup: true, conversationId: { $in: visibleConversations.filter((item) => Number(item.is_group) === 1).map((item) => item._id) } },
                        { isGroup: false, participants: { $in: visibleConversations.filter((item) => Number(item.is_group) === 0).map((item) => item._id) } },
                    ],
                },
            },
            {
                $addFields: {
                    viewerConversationId: {
                        $cond: [
                            "$isGroup",
                            "$conversationId",
                            { $arrayElemAt: [{ $filter: { input: "$participants", cond: { $ne: ["$$this", authObjectId] } } }, 0] },
                        ],
                    },
                },
            },
            { $sort: { startedAt: -1, _id: -1 } },
            {
                $group: {
                    _id: { conversationId: "$viewerConversationId", isGroup: "$isGroup" },
                    callerId: { $first: "$callerId" },
                    isVideo: { $first: "$isVideo" },
                    status: { $first: "$status" },
                    startedAt: { $first: "$startedAt" },
                },
            },
        ])
        : [];
    const recentCallsByConversation = new Map(recentCalls.map((item) => [
        conversationKey(item._id.conversationId, item._id.isGroup),
        item,
    ]));
    const latestMessageIds = recentLogs
        .filter((item) => item.group_id)
        .map((item) => item.message_id);
    const groupSeenCounts = latestMessageIds.length
        ? await messageLogSchema.aggregate([
            { $match: { message_id: { $in: latestMessageIds }, status: 1 } },
            {
                $group: {
                    _id: "$message_id",
                    count: { $sum: { $cond: [{ $ne: ["$sender_id", "$receiver_id"] }, 1, 0] } },
                },
            },
        ])
        : [];
    const groupSeenByMessage = new Map(groupSeenCounts.map((item) => [String(item._id), item.count]));
    const recentByConversation = new Map(recentLogs.map((item) => [
        conversationKey(item._id, Boolean(item.group_id)),
        item,
    ]));
    const blockedByUsers = visibleConversations.length
        ? await userSchema.find({
            _id: { $in: visibleConversations.filter((item) => Number(item.is_group) === 0).map((item) => item._id) },
            blockedUsers: authObjectId,
        }).select("_id").lean()
        : [];
    const blockedByIds = new Set(blockedByUsers.map((item) => String(item._id)));
    const archivedIds = new Set((currentUser?.archivedConversations || []).map(String));
    const blockedIds = new Set((currentUser?.blockedUsers || []).map(String));
    const directIds = visibleConversations
        .filter((item) => Number(item.is_group) === 0)
        .map((item) => item._id);
    const partnerNicknameDocs = directIds.length
        ? await userSchema.find({ _id: { $in: directIds } }).select("_id nicknames").lean()
        : [];
    const partnerNicknames = new Map(partnerNicknameDocs.map((item) => {
        const names = item.nicknames instanceof Map ? Object.fromEntries(item.nicknames) : item.nicknames || {};
        return [String(item._id), names[String(userId)] || ""];
    }));
    const withNicknames = visibleConversations
        .map((item) => {
            const conversationId = String(item._id);
            const latest = recentByConversation.get(conversationKey(item._id, item.is_group));
            const latestCall = recentCallsByConversation.get(conversationKey(item._id, item.is_group));
            const callIsLatest = latestCall && (
                !latest ||
                new Date(latestCall.startedAt).getTime() >= new Date(latest.createdAt).getTime()
            );
            return {
                ...item,
                ...(Number(item.is_group) === 0 && conversationId === String(userId) ? { name: `${item.name} (You)`, is_self: true } : {}),
                last_activity: callIsLatest
                    ? latestCall.startedAt
                    : latest?.createdAt || directActivity.get(conversationId) || item.last_activity,
                ...(Number(item.is_group) === 0 ? {
                    nickname: nicknames[String(item._id)] || "",
                    partnerNickname: partnerNicknames.get(conversationId) || "",
                } : {}),
                archived: archivedIds.has(String(item._id)),
                blocked: blockedIds.has(String(item._id)),
                blockedByPartner: blockedByIds.has(String(item._id)),
                ...(callIsLatest ? {
                    last_activity_kind: "call",
                    last_call_caller_id: String(latestCall.callerId),
                    last_call_is_video: latestCall.isVideo,
                    last_call_status: latestCall.status,
                    last_message: "",
                } : latest ? {
                    last_activity_kind: "message",
                    last_activity: latest.createdAt,
                    last_message: latest.text || "",
                    last_message_type: latest.type || "text",
                    last_message_attachment: latest.attachmentName || "",
                    last_message_duration_seconds: latest.durationSeconds || 0,
                    last_message_sender_id: String(latest.sender_id),
                    last_message_status: Number(item.is_group) === 1
                        ? (groupSeenByMessage.get(String(latest.message_id)) || 0)
                        : latest.status,
                } : {}),
            };
        }).sort((a, b) => new Date(b.last_activity || 0) - new Date(a.last_activity || 0));
    return NextResponse.json({
        success: true,
        data: withNicknames,
        unread_count: unreadCounts.get(userId) || 0,
    });
}