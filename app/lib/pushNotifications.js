import { sendNotification, setVapidDetails } from "web-push";
import mongoose from "mongoose";
import { pushSubscriptionSchema } from "@/app/models/pushSubscriptionModel";
import { userSchema } from "@/app/models/userModel";

let vapidConfigured = false;
let missingVapidWarningLogged = false;

// recipient id -> the nickname that recipient gave `subjectId` (only those who gave one)
export async function nicknamesGivenTo(recipientIds, subjectId) {
  const result = new Map();
  if (!recipientIds.length) return result;
  const holders = await userSchema.find({ _id: { $in: recipientIds.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("nicknames").lean().catch(() => []);
  for (const holder of holders) {
    const map = holder.nicknames instanceof Map ? Object.fromEntries(holder.nicknames) : holder.nicknames || {};
    if (map[subjectId]) result.set(String(holder._id), String(map[subjectId]));
  }
  return result;
}

export function getVapidPublicKey() {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
}

function configureWebPush() {
  const publicKey = getVapidPublicKey();
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  if (!vapidConfigured) {
    setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", publicKey, privateKey);
    vapidConfigured = true;
  }
  return true;
}

export async function sendPushNotification(userIds, payload) {
  if (!configureWebPush()) {
    if (!missingVapidWarningLogged) {
      console.warn("Web Push is disabled: configure NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
      missingVapidWarningLogged = true;
    }
    return;
  }

  const subscriptions = await pushSubscriptionSchema.find({ user_id: { $in: userIds } }).lean();
  await Promise.all(subscriptions.map(async ({ _id, user_id, endpoint, subscription }) => {
    try {
      const notification = typeof payload === "function" ? payload(String(user_id)) : payload;
      await sendNotification(subscription, JSON.stringify(notification));
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await pushSubscriptionSchema.deleteOne({ _id });
      } else {
        console.error("Unable to deliver a Web Push notification:", error);
      }
    }
  }));
}
