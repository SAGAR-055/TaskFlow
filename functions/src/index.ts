import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const db = getFirestore();
const claimTimeoutMs = 5 * 60_000;

interface PushMessage {
  id: string;
  kind: "task-reminder" | "overdue" | "habit-reminder" | "daily-planning";
  title: string;
  body: string;
  url: string;
  createdAt: string;
}

interface UserData {
  pushEnabled?: boolean;
  pushToken?: string;
  timezone?: string;
  appUrl?: string;
}

function localDateTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

async function claimNotification(reference: FirebaseFirestore.DocumentReference, key: string, now: Timestamp) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    const data = snapshot.data();
    if (!data) return false;
    if (data.lastPushKey === key) return false;

    const claimedAt = data.pushClaimedAt as Timestamp | undefined;
    if (data.pushClaimedKey === key && claimedAt && now.toMillis() - claimedAt.toMillis() < claimTimeoutMs) {
      return false;
    }

    transaction.update(reference, { pushClaimedKey: key, pushClaimedAt: now });
    return true;
  });
}

async function sendClaimedNotification(
  reference: FirebaseFirestore.DocumentReference,
  token: string,
  notification: PushMessage,
  now: Timestamp,
) {
  const claimed = await claimNotification(reference, notification.id, now);
  if (!claimed) return;

  try {
    await getMessaging().send({
      token,
      data: Object.fromEntries(Object.entries(notification).map(([key, value]) => [key, String(value)])),
      webpush: { headers: { Urgency: "high", TTL: "86400" } },
    });
    await reference.update({
      lastPushKey: notification.id,
      pushClaimedKey: FieldValue.delete(),
      pushClaimedAt: FieldValue.delete(),
    });
  } catch (error) {
    await reference.update({
      pushClaimedKey: FieldValue.delete(),
      pushClaimedAt: FieldValue.delete(),
    });
    throw error;
  }
}

function makeNotification(
  user: UserData,
  id: string,
  kind: PushMessage["kind"],
  title: string,
  body: string,
  now: Date,
): PushMessage {
  return {
    id,
    kind,
    title,
    body,
    url: user.appUrl || "/",
    createdAt: now.toISOString(),
  };
}

function isInvalidPushTokenError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "messaging/registration-token-not-registered" || error.code === "messaging/invalid-registration-token");
}

async function deliverNotification(
  reference: FirebaseFirestore.DocumentReference,
  token: string,
  notification: PushMessage,
  now: Timestamp,
) {
  try {
    await sendClaimedNotification(reference, token, notification, now);
  } catch (error) {
    logger.error("TaskFlow could not deliver a scheduled push notification.", {
      notificationId: notification.id,
      error,
    });
    if (isInvalidPushTokenError(error)) throw error;
  }
}

async function sendTaskNotifications(
  user: UserData,
  token: string,
  taskSnapshot: FirebaseFirestore.QuerySnapshot,
  now: Date,
) {
  for (const taskDocument of taskSnapshot.docs) {
    const task = taskDocument.data();
    if (task.completed || typeof task.deadlineAt !== "string") continue;
    const deadline = new Date(task.deadlineAt);
    if (Number.isNaN(deadline.getTime())) continue;
    const deadlineKey = typeof task.deadlineKey === "string" ? task.deadlineKey : task.deadlineAt;
    const leadMinutes = typeof task.reminderMinutesBefore === "number" ? task.reminderMinutesBefore : 30;

    if (deadline <= now) {
      const id = `overdue:${taskDocument.id}:${deadlineKey}`;
      await deliverNotification(
        taskDocument.ref,
        token,
        makeNotification(user, id, "overdue", "Task overdue", `“${task.title}” passed its deadline without being completed.`, now),
        Timestamp.fromDate(now),
      );
      continue;
    }

    const reminderAt = new Date(deadline.getTime() - leadMinutes * 60_000);
    if (reminderAt > now) continue;
    const leadText = leadMinutes === 1440
      ? "in 1 day"
      : leadMinutes >= 60
        ? `in ${leadMinutes / 60} hour${leadMinutes === 60 ? "" : "s"}`
        : `in ${leadMinutes} minutes`;
    const id = `task-reminder:${taskDocument.id}:${deadlineKey}:${leadMinutes}`;
    await deliverNotification(
      taskDocument.ref,
      token,
      makeNotification(user, id, "task-reminder", "Task deadline coming up", `“${task.title}” is due ${leadText}.`, now),
      Timestamp.fromDate(now),
    );
  }
}

async function sendHabitNotifications(
  user: UserData,
  token: string,
  habitSnapshot: FirebaseFirestore.QuerySnapshot,
  date: string,
  time: string,
  now: Date,
) {
  for (const habitDocument of habitSnapshot.docs) {
    const habit = habitDocument.data();
    const reminderTime = typeof habit.reminderTime === "string" ? habit.reminderTime : "22:00";
    const completedDates = Array.isArray(habit.completedDates) ? habit.completedDates : [];
    if (time < reminderTime || completedDates.includes(date)) continue;

    const id = `habit-reminder:${habitDocument.id}:${date}`;
    await deliverNotification(
      habitDocument.ref,
      token,
      makeNotification(user, id, "habit-reminder", "Habit reminder", `Time to complete “${habit.name}”.`, now),
      Timestamp.fromDate(now),
    );
  }
}

export const sendScheduledPushNotifications = onSchedule({ schedule: "every 1 minutes", region: "asia-south1" }, async () => {
  const now = new Date();
  const nowTimestamp = Timestamp.fromDate(now);
  const users = await db.collection("users").where("pushEnabled", "==", true).get();

  for (const userDocument of users.docs) {
    const user = userDocument.data() as UserData;
    if (!user.pushToken) {
      logger.error("TaskFlow push is enabled but this user has no FCM token.", { userId: userDocument.id });
      continue;
    }

    try {
      const timezone = user.timezone || "UTC";
      const local = localDateTime(now, timezone);
      const [tasks, habits] = await Promise.all([
        userDocument.ref.collection("tasks").get(),
        userDocument.ref.collection("habits").get(),
      ]);

      await sendTaskNotifications(user, user.pushToken, tasks, now);
      await sendHabitNotifications(user, user.pushToken, habits, local.date, local.time, now);
      if (local.time >= "09:00") {
        await deliverNotification(
          userDocument.ref,
          user.pushToken,
          makeNotification(user, `daily-planning:${local.date}`, "daily-planning", "Plan your day", "Take a moment to add the tasks you want to get done today.", now),
          nowTimestamp,
        );
      }
    } catch (error) {
      logger.error("TaskFlow could not deliver a scheduled push notification.", {
        userId: userDocument.id,
        error,
      });
      if (isInvalidPushTokenError(error)) {
        await userDocument.ref.update({ pushEnabled: false, pushToken: FieldValue.delete() });
      }
    }
  }
});
