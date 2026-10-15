import type { FirebaseApp } from "firebase/app";
import type { User } from "firebase/auth";

interface PushTask {
  id: string;
  title: string;
  completed: boolean;
  deadline: string;
  deadlineTime?: string;
  reminderMinutesBefore?: number;
}

interface PushHabit {
  id: string;
  name: string;
  reminderTime?: string;
  completedDates: string[];
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export const firebasePushConfigured = Object.values(firebaseConfig).every(Boolean) && Boolean(vapidKey);
let appPromise: Promise<FirebaseApp> | null = null;
const reminderSyncs = new Map<string, Promise<void>>();

function firebaseApp() {
  if (!firebasePushConfigured) {
    throw new Error("Background push is not configured. Add the Firebase web configuration and VAPID key, then rebuild the app.");
  }
  appPromise ??= import("firebase/app").then(({ getApp, getApps, initializeApp }) =>
    getApps().length ? getApp() : initializeApp(firebaseConfig));
  return appPromise;
}

export function subscribeToPushUser(onChange: (user: User | null) => void) {
  if (!firebasePushConfigured) return () => {};
  let active = true;
  let unsubscribe = () => {};
  void Promise.all([firebaseApp(), import("firebase/auth")]).then(([app, auth]) => {
    if (!active) return;
    unsubscribe = auth.onAuthStateChanged(auth.getAuth(app), onChange, error => {
      console.error("TaskFlow could not restore the Firebase push account.", error);
    });
  }).catch(error => {
    console.error("TaskFlow could not initialize the Firebase push account.", error);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}

export async function signInForPush() {
  const [{ getAuth, signInAnonymously }, app] = await Promise.all([import("firebase/auth"), firebaseApp()]);
  const auth = getAuth(app);
  if (auth.currentUser) return auth.currentUser;
  const credential = await signInAnonymously(auth);
  return credential.user;
}

async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support service workers required for background push.");
  }
  return navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

export async function subscribeDeviceForPush(user: User) {
  if (Notification.permission !== "granted") {
    throw new Error("Allow notifications in your browser before enabling background push.");
  }
  const [messaging, firestore, app] = await Promise.all([
    import("firebase/messaging"),
    import("firebase/firestore"),
    firebaseApp(),
  ]);
  if (!(await messaging.isSupported())) {
    throw new Error("This browser does not support Firebase background push.");
  }

  const registration = await serviceWorkerRegistration();
  const token = await messaging.getToken(messaging.getMessaging(app), {
    vapidKey,
    serviceWorkerRegistration: registration,
  });
  if (!token) {
    throw new Error("Firebase did not return a push subscription token. Check the Firebase Cloud Messaging configuration.");
  }

  await firestore.setDoc(firestore.doc(firestore.getFirestore(app), "users", user.uid), {
    pushToken: token,
    pushEnabled: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appUrl: new URL(import.meta.env.BASE_URL, window.location.origin).toString(),
    updatedAt: firestore.serverTimestamp(),
  }, { merge: true });
}

function taskReminderDocument(task: PushTask) {
  const deadlineKey = `${task.deadline}T${task.deadlineTime || "23:59"}`;
  const deadline = new Date(`${deadlineKey}:00`);
  return {
    title: task.title,
    completed: task.completed,
    deadlineKey,
    deadlineAt: Number.isNaN(deadline.getTime()) ? null : deadline.toISOString(),
    reminderMinutesBefore: task.reminderMinutesBefore ?? 30,
  };
}

async function replaceCollection(
  userId: string,
  collectionName: "tasks" | "habits",
  documents: Array<{ id: string; data: Record<string, unknown> }>,
) {
  const [firestore, app] = await Promise.all([import("firebase/firestore"), firebaseApp()]);
  const db = firestore.getFirestore(app);
  const collectionRef = firestore.collection(db, "users", userId, collectionName);
  const current = await firestore.getDocs(collectionRef);
  const currentIds = new Set(documents.map(document => document.id));
  const operations: Array<{ kind: "set" | "delete"; ref: ReturnType<typeof firestore.doc>; data?: Record<string, unknown> }> = [
    ...documents.map(document => ({
      kind: "set" as const,
      ref: firestore.doc(collectionRef, document.id),
      data: document.data,
    })),
    ...current.docs.filter(snapshot => !currentIds.has(snapshot.id)).map(snapshot => ({
      kind: "delete" as const,
      ref: snapshot.ref,
    })),
  ];

  for (let offset = 0; offset < operations.length; offset += 400) {
    const batch = firestore.writeBatch(db);
    for (const operation of operations.slice(offset, offset + 400)) {
      if (operation.kind === "set") batch.set(operation.ref, operation.data!, { merge: true });
      else batch.delete(operation.ref);
    }
    await batch.commit();
  }
}

async function writeReminderData(user: User, tasks: PushTask[], habits: PushHabit[]) {
  const [firestore, app] = await Promise.all([import("firebase/firestore"), firebaseApp()]);
  const db = firestore.getFirestore(app);
  await firestore.setDoc(firestore.doc(db, "users", user.uid), {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appUrl: new URL(import.meta.env.BASE_URL, window.location.origin).toString(),
    updatedAt: firestore.serverTimestamp(),
  }, { merge: true });
  await Promise.all([
    replaceCollection(user.uid, "tasks", tasks.map(task => ({
      id: task.id,
      data: taskReminderDocument(task),
    }))),
    replaceCollection(user.uid, "habits", habits.map(habit => ({
      id: habit.id,
      data: {
        name: habit.name,
        reminderTime: habit.reminderTime || "22:00",
        completedDates: habit.completedDates,
      },
    }))),
  ]);
}

export function syncReminderData(user: User, tasks: PushTask[], habits: PushHabit[]) {
  const previous = reminderSyncs.get(user.uid) ?? Promise.resolve();
  const write = () => writeReminderData(user, tasks, habits);
  const next = previous.then(write, write);
  reminderSyncs.set(user.uid, next);
  void next.then(
    () => { if (reminderSyncs.get(user.uid) === next) reminderSyncs.delete(user.uid); },
    () => { if (reminderSyncs.get(user.uid) === next) reminderSyncs.delete(user.uid); },
  );
  return next;
}
