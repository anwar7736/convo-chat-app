import mongoose from "mongoose";
import { callLogSchema } from "@/app/models/callLogModel";
import { messageLogSchema } from "@/app/models/messageLogModel";

export async function getUnreadNotificationCounts(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter((id) => mongoose.isValidObjectId(id)))];
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const [unreadMessages, unreadCalls] = await Promise.all([
    messageLogSchema.aggregate([
      { $match: { receiver_id: { $in: objectIds }, status: 0 } },
      { $group: { _id: "$receiver_id", count: { $sum: 1 } } },
    ]),
    callLogSchema.aggregate([
      {
        $match: {
          participants: { $in: objectIds },
          status: "no-answer",
          deletedForEveryone: { $ne: true },
        },
      },
      { $unwind: "$participants" },
      { $match: { participants: { $in: objectIds } } },
      {
        $match: {
          $expr: {
            $and: [
              { $ne: ["$callerId", "$participants"] },
              { $eq: [{ $in: ["$participants", { $ifNull: ["$readBy", []] }] }, false] },
              { $eq: [{ $in: ["$participants", { $ifNull: ["$deletedFor", []] }] }, false] },
            ],
          },
        },
      },
      { $group: { _id: "$participants", count: { $sum: 1 } } },
    ]),
  ]);

  for (const item of [...unreadMessages, ...unreadCalls]) {
    const id = String(item._id);
    counts.set(id, (counts.get(id) || 0) + item.count);
  }
  return counts;
}
