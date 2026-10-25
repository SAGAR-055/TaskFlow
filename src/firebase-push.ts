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
export const firebaseAuthConfigured = Object.values(firebaseConfig).every(Boolean);
let appPromise: Promise<FirebaseApp> | null = null;
const reminderSyncs = new Map<string, Promise<void>>();
const accountSyncs = new Map<string, Promise<void>>();

function firebaseApp() {
  if (!firebaseAuthConfigured) {
    throw new Error("Firebase is not configured. Add the Firebase web configuration, then rebuild the app.");
  }
  appPromise ??= import("firebase/app").then(({ getApp, getApps, initializeApp }) =>
    getApps().length ? getApp() : initializeApp(firebaseConfig));
  return appPromise;
}

export function subscribeToPushUser(onChange: (user: User | null) => void) {
  if (!firebaseAuthConfigured) return () => {};
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

export async function signInWithGoogle() {
  const [{ getAuth, GoogleAuthProvider, linkWithPopup, signInWithPopup }, app] = await Promise.all([
    import("firebase/auth"),
    firebaseApp(),
  ]);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  if (auth.currentUser?.isAnonymous) {
    try {
      return (await linkWithPopup(auth.currentUser, provider)).user;
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "auth/credential-already-in-use"
      ) {
        throw error;
      }
    }
  }

  if (auth.currentUser) return auth.currentUser;
  return (await signInWithPopup(auth, provider)).user;
}

export async function signOutFromFirebase() {
  const [{ getAuth }, app] = await Promise.all([import("firebase/auth"), firebaseApp()]);
  await getAuth(app).signOut();
}

export async function syncAccountData<Task extends { id: string }, Habit extends { id: string }>(
  user: User,
  tasks: Task[],
  habits: Habit[],
  isTask: (value: unknown) => value is Task,
  isHabit: (value: unknown) => value is Habit,
) {
  const [firestore, app] = await Promise.all([import("firebase/firestore"), firebaseApp()]);
  const db = firestore.getFirestore(app);

  async function mergeCollection<T extends { id: string }>(
    collectionName: "tasks" | "habits",
    local: T[],
    isValid: (value: unknown) => value is T,
  ) {
    const collectionRef = firestore.collection(db, "users", user.uid, collectionName);
    const current = await firestore.getDocs(collectionRef);
    const merged = new Map<string, T>();
    for (const value of local) merged.set(value.id, value);
    for (const snapshot of current.docs) {
      const value = { ...snapshot.data(), id: snapshot.id };
      if (!isValid(value)) {
        console.error(`TaskFlow ignored invalid account ${collectionName} data.`, snapshot.id);
        continue;
      }
      if (!merged.has(value.id)) merged.set(value.id, value);
    }
    const documents = [...merged.values()];
    await replaceCollection(user.uid, collectionName, documents.map(value => ({ id: value.id, data: value })));
    return documents;
  }

  const [mergedTasks, mergedHabits] = await Promise.all([
    mergeCollection("tasks", tasks, isTask),
    mergeCollection("habits", habits, isHabit),
  ]);
  return { tasks: mergedTasks, habits: mergedHabits };
}

export async function saveAccountData<Task extends { id: string }, Habit extends { id: string }>(
  user: User,
  tasks: Task[],
  habits: Habit[],
) {
  const previous = accountSyncs.get(user.uid) ?? Promise.resolve();
  const write = () => Promise.all([
    replaceCollection(user.uid, "tasks", tasks.map(value => ({ id: value.id, data: value }))),
    replaceCollection(user.uid, "habits", habits.map(value => ({ id: value.id, data: value }))),
  ]).then(() => {});
  const next = previous.then(write, write);
  accountSyncs.set(user.uid, next);
  void next.then(
    () => { if (accountSyncs.get(user.uid) === next) accountSyncs.delete(user.uid); },
    () => { if (accountSyncs.get(user.uid) === next) accountSyncs.delete(user.uid); },
  );
  await next;
}

export function subscribeToAccountData<T extends { id: string }>(
  user: User,
  collectionName: "tasks" | "habits",
  isValid: (value: unknown) => value is T,
  onChange: (values: T[]) => void,
  onError: (error: Error) => void,
) {
  let active = true;
  let unsubscribe = () => {};
  void Promise.all([firebaseApp(), import("firebase/firestore")]).then(([app, firestore]) => {
    if (!active) return;
    const collectionRef = firestore.collection(firestore.getFirestore(app), "users", user.uid, collectionName);
    unsubscribe = firestore.onSnapshot(collectionRef, snapshot => {
      onChange(snapshot.docs.flatMap(document => {
        const value = { ...document.data(), id: document.id };
          if (isValid(value)) return [value];
          console.error(`TaskFlow ignored invalid synced ${collectionName} data.`, document.id);
          return [];
      }));
    }, error => onError(error));
  }).catch(error => {
    if (active) onError(error instanceof Error ? error : new Error("Could not subscribe to account data."));
  });
  return () => {
    active = false;
    unsubscribe();
  };
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
