import { useState, useMemo, useRef, useEffect } from "react";
import type { User } from "firebase/auth";
import {
  firebaseAuthConfigured,
  firebasePushConfigured,
  saveAccountData,
  signInWithGoogle,
  signInForPush,
  signOutFromFirebase,
  subscribeDeviceForPush,
  subscribeToAccountData,
  subscribeToPushUser,
  syncAccountData,
  syncReminderData,
} from "./firebase-push";

type TaskType = "daily" | "weekly" | "monthly" | "yearly";
type Priority = "low" | "medium" | "high";

interface Task {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  deadline: string;
  deadlineTime?: string;
  reminderMinutesBefore?: number;
  hours: number;
  priority: Priority;
  completed: boolean;
  createdAt: string;
}

interface Habit {
  id: string;
  name: string;
  emoji: string;
  color: string;
  completedDates: string[];
  reminderTime?: string;
  createdAt: string;
}

type NotificationKind = "task-reminder" | "overdue" | "habit-reminder" | "daily-planning";

interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

const TYPE_META: Record<TaskType, { label: string; color: string; bg: string; emoji: string }> = {
  daily:   { label: "Daily",   color: "#007AFF", bg: "rgba(0,122,255,0.12)",   emoji: "☀️" },
  weekly:  { label: "Weekly",  color: "#34C759", bg: "rgba(52,199,89,0.12)",   emoji: "📅" },
  monthly: { label: "Monthly", color: "#AF52DE", bg: "rgba(175,82,222,0.12)",  emoji: "🗓️" },
  yearly:  { label: "Yearly",  color: "#FF9500", bg: "rgba(255,149,0,0.12)",   emoji: "🎯" },
};

const PRIORITY_META: Record<Priority, { color: string; bg: string; label: string }> = {
  low:    { color: "#34C759", bg: "rgba(52,199,89,0.12)",   label: "Low" },
  medium: { color: "#FF9500", bg: "rgba(255,149,0,0.12)",   label: "Medium" },
  high:   { color: "#FF3B30", bg: "rgba(255,59,48,0.12)",   label: "High" },
};

function uid() { return Math.random().toString(36).slice(2, 9); }

function daysFromNow(n: number) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}

const TASKS_STORAGE_KEY = "taskflow.tasks";
const HABITS_STORAGE_KEY = "taskflow.habits";
const NOTIFICATIONS_STORAGE_KEY = "taskflow.notifications";
const migratedAccountStorageKey = (uid: string) => `taskflow.migrated.${uid}`;
const accountTasksStorageKey = (uid: string) => `${TASKS_STORAGE_KEY}.${uid}`;
const accountHabitsStorageKey = (uid: string) => `${HABITS_STORAGE_KEY}.${uid}`;
const HABIT_EMOJIS = ["🌱", "📚", "💧", "🏃", "🧘", "🍎", "💤", "📝", "💻", "🎨", "🎸", "☀️", "🙏", "🚶", "🧹", "🧠"];

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isTaskType(value: unknown): value is TaskType {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly";
}

function isPriority(value: unknown): value is Priority {
  return value === "low" || value === "medium" || value === "high";
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return value === "task-reminder" || value === "overdue" || value === "habit-reminder" || value === "daily-planning";
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string"
    && typeof task.title === "string"
    && typeof task.description === "string"
    && isTaskType(task.type)
    && typeof task.deadline === "string"
    && (task.deadlineTime === undefined || typeof task.deadlineTime === "string")
    && (task.reminderMinutesBefore === undefined || typeof task.reminderMinutesBefore === "number")
    && typeof task.hours === "number"
    && isPriority(task.priority)
    && typeof task.completed === "boolean"
    && typeof task.createdAt === "string";
}

function loadTasks(storageKey = TASKS_STORAGE_KEY): Task[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];

    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isTask)) {
      console.error("TaskFlow could not restore tasks because stored data is invalid.");
      return [];
    }

    return parsed;
  } catch (error) {
    console.error("TaskFlow could not restore tasks from local storage.", error);
    return [];
  }
}

function isHabit(value: unknown): value is Habit {
  if (typeof value !== "object" || value === null) return false;
  const habit = value as Record<string, unknown>;
  return typeof habit.id === "string"
    && typeof habit.name === "string"
    && typeof habit.emoji === "string"
    && typeof habit.color === "string"
    && Array.isArray(habit.completedDates)
    && habit.completedDates.every(date => typeof date === "string")
    && (habit.reminderTime === undefined || typeof habit.reminderTime === "string")
    && typeof habit.createdAt === "string";
}

function loadHabits(storageKey = HABITS_STORAGE_KEY): Habit[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isHabit)) {
      console.error("TaskFlow could not restore habits because stored data is invalid.");
      return [];
    }
    return parsed;
  } catch (error) {
    console.error("TaskFlow could not restore habits from local storage.", error);
    return [];
  }
}

function mergeSyncedItems<T extends { id: string }>(current: T[], incoming: T[]) {
  const incomingById = new Map(incoming.map(item => [item.id, item]));
  const merged = current
    .filter(item => incomingById.has(item.id))
    .map(item => incomingById.get(item.id))
    .filter((item): item is T => item !== undefined);
  const currentIds = new Set(current.map(item => item.id));
  for (const item of incoming) {
    if (!currentIds.has(item.id)) merged.push(item);
  }
  return merged.length === current.length
    && merged.every((item, index) =>
      JSON.stringify(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      === JSON.stringify(Object.entries(current[index]).sort(([left], [right]) => left.localeCompare(right))))
    ? current
    : merged;
}

function isAppNotification(value: unknown): value is AppNotification {
  if (typeof value !== "object" || value === null) return false;
  const notification = value as Record<string, unknown>;
  return typeof notification.id === "string"
    && (notification.kind === "task-reminder" || notification.kind === "overdue" || notification.kind === "habit-reminder" || notification.kind === "daily-planning")
    && typeof notification.title === "string"
    && typeof notification.message === "string"
    && typeof notification.createdAt === "string"
    && typeof notification.read === "boolean";
}

function loadNotifications(): AppNotification[] {
  try {
    const stored = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isAppNotification)) {
      console.error("TaskFlow could not restore notifications because stored data is invalid.");
      return [];
    }
    return parsed;
  } catch (error) {
    console.error("TaskFlow could not restore notifications from local storage.", error);
    return [];
  }
}

function dateOffset(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return localDateString(date);
}

function localDateString(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getTaskDeadline(task: Task) {
  return new Date(`${task.deadline}T${task.deadlineTime || "23:59"}:00`);
}

function isTaskOverdue(task: Task, now = new Date()) {
  const deadline = getTaskDeadline(task);
  return !task.completed && !Number.isNaN(deadline.getTime()) && deadline < now;
}

/* ── Habit Modal ── */
function HabitModal({ habit, onClose, onSave }: { habit?: Habit; onClose: () => void; onSave: (habit: Habit) => void }) {
  const [form, setForm] = useState(() => habit
    ? { name: habit.name, emoji: habit.emoji, color: habit.color, reminderTime: habit.reminderTime || "22:00" }
    : { name: "", emoji: "🌱", color: "#34C759", reminderTime: "22:00" });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSave(habit
      ? { ...habit, ...form, emoji: form.emoji.trim() || "🌱", name: form.name.trim() }
      : { id: uid(), ...form, emoji: form.emoji.trim() || "🌱", name: form.name.trim(), completedDates: [], createdAt: new Date().toISOString() });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 animate-in">
        <div className="w-10 h-1 rounded-full mx-auto mb-5 sm:hidden" style={{ background: "rgba(0,0,0,0.15)" }} />
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#34C759" }}>Habit tracker</p>
            <h2 className="text-xl font-semibold" style={{ color: "#1c1c1e", letterSpacing: "-0.4px" }}>{habit ? "Edit Habit" : "New Habit"}</h2>
          </div>
          <button onClick={onClose} className="glass-btn w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ color: "#636366" }}>✕</button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Habit name</label>
            <input type="text" required autoFocus value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Read for 20 minutes"
              className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Icon</label>
              <input type="text" value={form.emoji} onChange={e => setForm(p => ({ ...p, emoji: e.target.value }))} aria-label="Habit icon" placeholder="Choose an emoji"
                className="w-full px-4 py-3 rounded-2xl text-xl text-center border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)" }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Color</label>
              <input type="color" value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                className="w-full h-12 p-1 rounded-2xl border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)" }} />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Daily reminder</label>
            <input type="time" required value={form.reminderTime} onChange={e => setForm(p => ({ ...p, reminderTime: e.target.value }))}
              className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", colorScheme: "light" }} />
            <p className="text-xs mt-1.5" style={{ color: "#8E8E93" }}>We’ll remind you each day until you complete this habit. Defaults to 10:00 PM.</p>
          </div>
          <div className="grid grid-cols-8 gap-2" aria-label="Choose a habit icon">
            {HABIT_EMOJIS.map(emoji => (
              <button key={emoji} type="button" onClick={() => setForm(p => ({ ...p, emoji }))} aria-label={`Use ${emoji} as habit icon`} aria-pressed={form.emoji === emoji}
                className="glass-btn h-10 rounded-xl text-xl" style={{ outline: form.emoji === emoji ? "2px solid #34C759" : "none", outlineOffset: 1 }}>
                {emoji}
              </button>
            ))}
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="glass-btn flex-1 py-3 rounded-2xl text-sm font-medium" style={{ color: "#636366" }}>Cancel</button>
            <button type="submit" className="flex-1 py-3 rounded-2xl text-sm font-semibold transition-all hover:opacity-90 active:scale-95"
              style={{ background: "linear-gradient(135deg, #34C759 0%, #00A86B 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(52,199,89,0.35)" }}>
              {habit ? "Save Changes" : "Add Habit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type View = "tasks" | "habits" | "calendar";
type Tab = TaskType | "all";

/* ── Tilt card wrapper ── */
function TiltCard({ children, className = "", style = {} }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);

  function onMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(600px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) translateY(-2px) scale(1.01)`;
    el.style.boxShadow = `${-x * 10}px ${y * 10 + 8}px 32px rgba(80,80,180,0.13), 0 1px 0 rgba(255,255,255,1) inset`;
  }

  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "perspective(600px) rotateY(0deg) rotateX(0deg) translateY(0) scale(1)";
    el.style.boxShadow = "";
  }

  return (
    <div ref={ref} className={className} style={{ ...style, transition: "transform 0.35s cubic-bezier(.25,.8,.25,1), box-shadow 0.35s ease" }}
      onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
    </div>
  );
}

/* ── Add Task Modal ── */
function AddTaskModal({ onClose, onAdd }: { onClose: () => void; onAdd: (t: Task) => void }) {
  const [form, setForm] = useState({ title: "", description: "", type: "daily" as TaskType, deadline: daysFromNow(0), deadlineTime: "23:59", reminderMinutesBefore: "30", hours: "", priority: "medium" as Priority });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onAdd({ id: uid(), ...form, reminderMinutesBefore: Number(form.reminderMinutesBefore), title: form.title.trim(), description: form.description.trim(), hours: parseFloat(form.hours) || 1, completed: false, createdAt: new Date().toISOString() });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 animate-in" style={{ maxHeight: "92vh", overflowY: "auto" }}>
        <div className="w-10 h-1 rounded-full mx-auto mb-5 sm:hidden" style={{ background: "rgba(0,0,0,0.15)" }} />
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-semibold" style={{ color: "#1c1c1e", letterSpacing: "-0.4px" }}>New Task</h2>
          <button onClick={onClose} className="glass-btn w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ color: "#636366" }}>✕</button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366", letterSpacing: "0.02em" }}>Title</label>
            <input type="text" required value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="What needs to be done?"
              className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", boxShadow: "0 1px 4px rgba(0,0,0,0.05) inset" }} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Description</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Optional details..." rows={2}
              className="w-full px-4 py-3 rounded-2xl text-sm border resize-none" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Type</label>
              <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value as TaskType }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                {(Object.keys(TYPE_META) as TaskType[]).map(k => <option key={k} value={k}>{TYPE_META[k].emoji} {TYPE_META[k].label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Priority</label>
              <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value as Priority }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                <option value="low">🟢 Low</option>
                <option value="medium">🟡 Medium</option>
                <option value="high">🔴 High</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Deadline</label>
              <input type="date" required value={form.deadline} onChange={e => setForm(p => ({ ...p, deadline: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", colorScheme: "light" }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Due time</label>
              <input type="time" required value={form.deadlineTime} onChange={e => setForm(p => ({ ...p, deadlineTime: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", colorScheme: "light" }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Remind me</label>
              <select value={form.reminderMinutesBefore} onChange={e => setForm(p => ({ ...p, reminderMinutesBefore: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                <option value="5">5 minutes before</option>
                <option value="15">15 minutes before</option>
                <option value="30">30 minutes before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Hours Required</label>
              <input type="number" min="0.5" step="0.5" required value={form.hours} onChange={e => setForm(p => ({ ...p, hours: e.target.value }))} placeholder="e.g. 2.5"
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }} />
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="glass-btn flex-1 py-3 rounded-2xl text-sm font-medium" style={{ color: "#636366" }}>Cancel</button>
            <button type="submit" className="flex-1 py-3 rounded-2xl text-sm font-semibold transition-all hover:opacity-90 active:scale-95"
              style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(0,122,255,0.35)" }}>
              Add Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Edit Task Modal ── */
function EditTaskModal({ task, onClose, onSave }: { task: Task; onClose: () => void; onSave: (t: Task) => void }) {
  const [form, setForm] = useState({
    title: task.title,
    description: task.description,
    type: task.type,
    deadline: task.deadline,
    deadlineTime: task.deadlineTime || "23:59",
    reminderMinutesBefore: String(task.reminderMinutesBefore ?? 30),
    hours: String(task.hours),
    priority: task.priority,
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSave({ ...task, ...form, reminderMinutesBefore: Number(form.reminderMinutesBefore), title: form.title.trim(), description: form.description.trim(), hours: parseFloat(form.hours) || 1 });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 animate-in" style={{ maxHeight: "92vh", overflowY: "auto" }}>
        <div className="w-10 h-1 rounded-full mx-auto mb-5 sm:hidden" style={{ background: "rgba(0,0,0,0.15)" }} />
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl flex items-center justify-center text-sm" style={{ background: "rgba(0,122,255,0.12)" }}>✏️</div>
            <h2 className="text-xl font-semibold" style={{ color: "#1c1c1e", letterSpacing: "-0.4px" }}>Edit Task</h2>
          </div>
          <button onClick={onClose} className="glass-btn w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ color: "#636366" }}>✕</button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Title</label>
            <input type="text" required value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", boxShadow: "0 1px 4px rgba(0,0,0,0.05) inset" }} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Description</label>
            <textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2}
              className="w-full px-4 py-3 rounded-2xl text-sm border resize-none" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Type</label>
              <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value as TaskType }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                {(Object.keys(TYPE_META) as TaskType[]).map(k => <option key={k} value={k}>{TYPE_META[k].emoji} {TYPE_META[k].label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Priority</label>
              <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value as Priority }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                <option value="low">🟢 Low</option>
                <option value="medium">🟡 Medium</option>
                <option value="high">🔴 High</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Deadline</label>
              <input type="date" required value={form.deadline} onChange={e => setForm(p => ({ ...p, deadline: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", colorScheme: "light" }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Due time</label>
              <input type="time" required value={form.deadlineTime} onChange={e => setForm(p => ({ ...p, deadlineTime: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", colorScheme: "light" }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Remind me</label>
              <select value={form.reminderMinutesBefore} onChange={e => setForm(p => ({ ...p, reminderMinutesBefore: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }}>
                <option value="5">5 minutes before</option>
                <option value="15">15 minutes before</option>
                <option value="30">30 minutes before</option>
                <option value="60">1 hour before</option>
                <option value="1440">1 day before</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Hours Required</label>
              <input type="number" min="0.5" step="0.5" required value={form.hours} onChange={e => setForm(p => ({ ...p, hours: e.target.value }))}
                className="w-full px-4 py-3 rounded-2xl text-sm border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e" }} />
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="glass-btn flex-1 py-3 rounded-2xl text-sm font-medium" style={{ color: "#636366" }}>Cancel</button>
            <button type="submit" className="flex-1 py-3 rounded-2xl text-sm font-semibold transition-all hover:opacity-90 active:scale-95"
              style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(0,122,255,0.35)" }}>
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Card context menu ── */
function CardMenu({ task, onEdit, onToggle, onDelete, onClose }: {
  task: Task; onEdit: () => void; onToggle: () => void; onDelete: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const items = [
    { icon: "✏️", label: "Edit Task", action: onEdit, color: "#007AFF" },
    { icon: task.completed ? "↩️" : "✅", label: task.completed ? "Mark Incomplete" : "Mark Complete", action: () => { onToggle(); onClose(); }, color: "#34C759" },
    { icon: "🗑️", label: "Delete Task", action: () => { onDelete(); onClose(); }, color: "#FF3B30", danger: true },
  ];

  return (
    <div ref={ref} className="absolute right-0 top-9 z-30 animate-in" style={{ minWidth: 190 }}>
      <div className="glass rounded-2xl overflow-hidden py-1.5" style={{ boxShadow: "0 8px 40px rgba(0,0,0,0.14), 0 1px 0 rgba(255,255,255,0.9) inset" }}>
        {items.map((item, i) => (
          <button key={i} onClick={item.action}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-left transition-colors hover:bg-white/50 active:bg-white/70"
            style={{ color: item.danger ? "#FF3B30" : "#1c1c1e", borderBottom: i < items.length - 1 ? "1px solid rgba(0,0,0,0.05)" : "none" }}>
            <span className="text-base w-5 text-center">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Stats row ── */
function StatsBar({ tasks }: { tasks: Task[] }) {
  const total = tasks.length;
  const done = tasks.filter(t => t.completed).length;
  const hoursLeft = tasks.filter(t => !t.completed).reduce((s, t) => s + t.hours, 0);
  const overdue = tasks.filter(task => isTaskOverdue(task)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const stats = [
    { label: "Total", value: total, icon: "📋", color: "#007AFF" },
    { label: "Done", value: `${pct}%`, icon: "✅", color: "#34C759" },
    { label: "Hrs left", value: `${hoursLeft.toFixed(0)}h`, icon: "⏱️", color: "#FF9500" },
    { label: "Overdue", value: overdue, icon: "⚠️", color: overdue > 0 ? "#FF3B30" : "#8E8E93" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s, i) => (
        <TiltCard key={s.label} className="glass-card rounded-3xl p-4" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xl">{s.icon}</span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: `${s.color}18`, color: s.color }}>{s.label}</span>
          </div>
          <div className="text-3xl font-bold" style={{ color: "#1c1c1e", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
        </TiltCard>
      ))}
    </div>
  );
}

function CalendarStatsBar({ tasks, habits, selectedDay }: { tasks: Task[]; habits: Habit[]; selectedDay: string }) {
  const total = tasks.length + habits.length;
  const completedTasks = tasks.filter(task => task.completed).length;
  const completedHabits = habits.filter(habit => habit.completedDates.includes(selectedDay)).length;
  const done = completedTasks + completedHabits;
  const hoursLeft = tasks.filter(task => !task.completed).reduce((sum, task) => sum + task.hours, 0);
  const overdue = tasks.filter(task => isTaskOverdue(task)).length;
  const stats = [
    { label: "Tasks + habits", value: total, detail: `${tasks.length} tasks · ${habits.length} habits`, icon: "📋", color: "#007AFF" },
    { label: "Done", value: `${total ? Math.round((done / total) * 100) : 0}%`, detail: `${completedTasks} tasks · ${completedHabits} habits`, icon: "✅", color: "#34C759" },
    { label: "Task hrs left", value: `${hoursLeft.toFixed(0)}h`, detail: "For unfinished tasks", icon: "⏱️", color: "#FF9500" },
    { label: "Task overdue", value: overdue, detail: "Unfinished tasks", icon: "⚠️", color: overdue > 0 ? "#FF3B30" : "#8E8E93" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat, index) => (
        <TiltCard key={stat.label} className="glass-card rounded-3xl p-4" style={{ animationDelay: `${index * 60}ms` }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xl">{stat.icon}</span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: `${stat.color}18`, color: stat.color }}>{stat.label}</span>
          </div>
          <div className="text-3xl font-bold" style={{ color: "#1c1c1e", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums" }}>{stat.value}</div>
          <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>{stat.detail}</p>
        </TiltCard>
      ))}
    </div>
  );
}

/* ── Task Card ── */
function TaskCard({ task, onToggle, onDelete, onEdit }: {
  task: Task; onToggle: (id: string) => void; onDelete: (id: string) => void; onEdit: (t: Task) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = isTaskOverdue(task);
  const daysLeft = Math.ceil((new Date(task.deadline).getTime() - new Date(today).getTime()) / 86400000);
  const tm = TYPE_META[task.type];
  const pm = PRIORITY_META[task.priority];

  return (
    <TiltCard
      className="glass-card rounded-3xl p-4 animate-in"
      style={{ borderColor: isOverdue ? "rgba(255,59,48,0.3)" : "rgba(255,255,255,0.9)" }}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <button
          onClick={() => onToggle(task.id)}
          className="mt-0.5 w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center check-anim border-2"
          style={{
            borderColor: task.completed ? "#34C759" : "rgba(0,0,0,0.15)",
            background: task.completed ? "#34C759" : "rgba(255,255,255,0.5)",
            boxShadow: task.completed ? "0 0 12px rgba(52,199,89,0.4)" : "none",
          }}
        >
          {task.completed && (
            <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
              <path d="M1 4.5L4.5 8L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className={`text-sm font-semibold ${task.completed ? "task-done" : ""}`} style={{ color: "#1c1c1e", letterSpacing: "-0.2px" }}>
              {task.title}
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: tm.bg, color: tm.color }}>
              {tm.emoji} {tm.label}
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: pm.bg, color: pm.color }}>
              {pm.label}
            </span>
          </div>
          {task.description && (
            <p className={`text-xs leading-relaxed mb-2 ${task.completed ? "task-done" : ""}`} style={{ color: "#636366" }}>{task.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: isOverdue && !task.completed ? "rgba(255,59,48,0.12)" : "rgba(0,0,0,0.05)", color: isOverdue && !task.completed ? "#FF3B30" : "#8E8E93" }}>
              📅 {isOverdue ? daysLeft === 0 ? "Overdue" : `${Math.abs(daysLeft)}d overdue` : task.completed ? "Completed" : daysLeft === 0 ? "Due today" : `${daysLeft}d left`}
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>
              ⏱ {task.hours}h
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>
              🗓 {task.deadline} · {task.deadlineTime || "23:59"}
            </span>
          </div>
        </div>

        {/* Three-dot menu button */}
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="glass-btn w-7 h-7 rounded-full flex items-center justify-center transition-all"
            style={{ color: "#8E8E93" }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <circle cx="7" cy="2.5" r="1.3" />
              <circle cx="7" cy="7" r="1.3" />
              <circle cx="7" cy="11.5" r="1.3" />
            </svg>
          </button>
          {menuOpen && (
            <CardMenu
              task={task}
              onEdit={() => { onEdit(task); setMenuOpen(false); }}
              onToggle={() => onToggle(task.id)}
              onDelete={() => onDelete(task.id)}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </div>
    </TiltCard>
  );
}

/* ── Habit Tracker ── */
function HabitStats({ habits }: { habits: Habit[] }) {
  const today = dateOffset(0);
  const completedToday = habits.filter(habit => habit.completedDates.includes(today)).length;
  const totalCheckIns = habits.reduce((total, habit) => total + habit.completedDates.length, 0);
  const bestStreak = habits.reduce((best, habit) => Math.max(best, getHabitStreak(habit)), 0);
  const stats = [
    { label: "Habits", value: habits.length, icon: "🌱", color: "#34C759" },
    { label: "Today", value: `${completedToday}/${habits.length}`, icon: "✅", color: "#007AFF" },
    { label: "Check-ins", value: totalCheckIns, icon: "🔥", color: "#FF9500" },
    { label: "Best streak", value: `${bestStreak}d`, icon: "🏆", color: "#AF52DE" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat, index) => (
        <TiltCard key={stat.label} className="glass-card rounded-3xl p-4" style={{ animationDelay: `${index * 60}ms` }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xl">{stat.icon}</span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: `${stat.color}18`, color: stat.color }}>{stat.label}</span>
          </div>
          <div className="text-3xl font-bold" style={{ color: "#1c1c1e", letterSpacing: "-1px", fontVariantNumeric: "tabular-nums" }}>{stat.value}</div>
        </TiltCard>
      ))}
    </div>
  );
}

function getHabitStreak(habit: Habit) {
  const dates = new Set(habit.completedDates);
  let streak = 0;
  for (let offset = 0; dates.has(dateOffset(-offset)); offset += 1) streak += 1;
  return streak;
}

function HabitCard({ habit, onToggle, onDelete, onEdit }: { habit: Habit; onToggle: (id: string) => void; onDelete: (id: string) => void; onEdit: (habit: Habit) => void }) {
  const today = dateOffset(0);
  const completedToday = habit.completedDates.includes(today);
  const streak = getHabitStreak(habit);
  const recentDays = Array.from({ length: 7 }, (_, index) => dateOffset(index - 6));

  return (
    <TiltCard className="glass-card rounded-3xl p-4 animate-in" style={{ borderColor: completedToday ? `${habit.color}55` : "rgba(255,255,255,0.9)" }}>
      <div className="flex items-start gap-3">
        <button onClick={() => onToggle(habit.id)} aria-label={`${completedToday ? "Undo" : "Complete"} ${habit.name}`}
          className="habit-check w-12 h-12 rounded-2xl flex-shrink-0 flex items-center justify-center text-2xl check-anim"
          style={{ background: completedToday ? habit.color : `${habit.color}18`, boxShadow: completedToday ? `0 5px 16px ${habit.color}55` : "none" }}>
          {completedToday ? "✓" : habit.emoji}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className={`text-sm font-semibold ${completedToday ? "habit-complete" : ""}`} style={{ color: "#1c1c1e" }}>{habit.name}</h3>
              {streak > 0 && <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>🔥 {streak} day streak</p>}
              <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>⏰ Daily at {habit.reminderTime || "22:00"}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => onEdit(habit)} className="glass-btn w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ color: "#007AFF" }} aria-label={`Edit ${habit.name}`}>✎</button>
              <button onClick={() => onDelete(habit.id)} className="glass-btn w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ color: "#FF3B30" }} aria-label={`Delete ${habit.name}`}>✕</button>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-3">
            {recentDays.map(day => {
              const done = habit.completedDates.includes(day);
              return <span key={day} title={day} className="habit-day" style={{ background: done ? habit.color : "rgba(0,0,0,0.07)", opacity: done ? 1 : 0.65 }} />;
            })}
            <span className="text-xs ml-1" style={{ color: "#8E8E93" }}>last 7 days</span>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

/* ── Calendar View ── */
function CalendarView({ tasks, habits }: { tasks: Task[]; habits: Habit[] }) {
  const today = new Date();
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string>(today.toISOString().slice(0, 10));

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    tasks.forEach(t => { (map[t.deadline] ||= []).push(t); });
    return map;
  }, [tasks]);

  const habitsByDate = useMemo(() => {
    const map: Record<string, Habit[]> = {};
    habits.forEach(habit => {
      new Set(habit.completedDates).forEach(date => { (map[date] ||= []).push(habit); });
    });
    return map;
  }, [habits]);

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const todayStr = today.toISOString().slice(0, 10);
  const selectedTasks = tasksByDate[selectedDay] || [];
  const completedHabits = habitsByDate[selectedDay] || [];

  return (
    <div className="space-y-4">
      <CalendarStatsBar tasks={tasks} habits={habits} selectedDay={selectedDay} />
      <div className="flex flex-col lg:flex-row gap-4">
      {/* Month grid */}
      <TiltCard className="glass-card rounded-3xl p-5 flex-1">
        <div className="flex items-center justify-between mb-5">
          <button onClick={() => setViewDate(new Date(year, month - 1, 1))} className="glass-btn w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ color: "#007AFF" }}>‹</button>
          <div className="text-center">
            <div className="font-semibold text-base" style={{ color: "#1c1c1e", letterSpacing: "-0.3px" }}>{MONTHS[month]}</div>
            <div className="text-xs" style={{ color: "#8E8E93" }}>{year}</div>
          </div>
          <button onClick={() => setViewDate(new Date(year, month + 1, 1))} className="glass-btn w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ color: "#007AFF" }}>›</button>
        </div>
        <div className="grid grid-cols-7 mb-2">
          {DAYS.map((d, i) => <div key={i} className="text-center text-xs font-medium py-1" style={{ color: "#8E8E93" }}>{d}</div>)}
        </div>
        <div className="space-y-1">
          {rows.map((row, ri) => (
            <div key={ri} className="grid grid-cols-7">
              {row.map((day, ci) => {
                if (!day) return <div key={ci} />;
                const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const dayTasks = tasksByDate[ds] || [];
                const dayHabits = habitsByDate[ds] || [];
                const isToday = ds === todayStr;
                const isSel = ds === selectedDay;
                const markers = [
                  ...[...new Set(dayTasks.map(t => TYPE_META[t.type].color))].map(color => ({ color, isHabit: false })),
                  ...[...new Set(dayHabits.map(habit => habit.color))].map(color => ({ color, isHabit: true })),
                ].slice(0, 3);
                return (
                  <button key={ci} onClick={() => setSelectedDay(ds)}
                    className="relative flex flex-col items-center justify-center aspect-square rounded-full text-xs font-medium transition-all"
                    style={{
                      background: isSel ? "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)" : isToday ? "rgba(0,122,255,0.12)" : "transparent",
                      color: isSel ? "#fff" : isToday ? "#007AFF" : "#1c1c1e",
                      fontWeight: isToday || isSel ? 700 : 400,
                      boxShadow: isSel ? "0 4px 16px rgba(0,122,255,0.35)" : "none",
                      transform: isSel ? "scale(1.08)" : "scale(1)",
                      transition: "all 0.25s cubic-bezier(.34,1.56,.64,1)",
                    }}>
                    {day}
                    {markers.length > 0 && (
                      <div className="absolute bottom-1 flex gap-0.5">
                        {markers.map((marker, i) => (
                          <span key={i} className={`w-1 h-1 ${marker.isHabit ? "rounded-sm" : "rounded-full"}`} style={{ background: isSel ? "rgba(255,255,255,0.8)" : marker.color }} />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </TiltCard>

      {/* Day detail */}
      <div className="glass-card rounded-3xl p-5 w-full lg:w-72" style={{ minHeight: 260 }}>
        <h3 className="font-semibold text-sm mb-3" style={{ color: "#1c1c1e", letterSpacing: "-0.2px" }}>
          {selectedDay === todayStr ? "Today" : new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </h3>
        <section className="mb-4">
          <h4 className="text-xs font-semibold mb-2" style={{ color: "#007AFF" }}>Tasks ({selectedTasks.length})</h4>
          {selectedTasks.length === 0 ? (
            <p className="text-xs py-2" style={{ color: "#8E8E93" }}>No tasks scheduled</p>
          ) : (
            <div className="space-y-2">
              {selectedTasks.map(task => {
                const tm = TYPE_META[task.type];
                return (
                  <div key={task.id} className="rounded-2xl p-3 border" style={{ background: "rgba(255,255,255,0.55)", borderColor: "rgba(255,255,255,0.9)" }}>
                    <div className="flex items-start gap-2">
                      <span className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ background: tm.color }} />
                      <div className="flex-1">
                        <p className={`text-xs font-medium ${task.completed ? "task-done" : ""}`} style={{ color: "#1c1c1e" }}>{task.title}</p>
                        <div className="flex gap-1.5 mt-1 flex-wrap">
                          <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: tm.bg, color: tm.color }}>{tm.label}</span>
                          <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>{task.hours}h</span>
                          <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>Due {task.deadlineTime || "23:59"}</span>
                          {task.completed && <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: "rgba(52,199,89,0.12)", color: "#34C759" }}>✓ done</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section>
          <h4 className="text-xs font-semibold mb-2" style={{ color: "#34C759" }}>Habits ({completedHabits.length}/{habits.length} done)</h4>
          {habits.length === 0 ? (
            <p className="text-xs py-2" style={{ color: "#8E8E93" }}>No habits yet</p>
          ) : (
            <div className="space-y-2">
              {habits.map(habit => {
                const isCompleted = habit.completedDates.includes(selectedDay);
                return (
                  <div key={habit.id} className="rounded-2xl p-3 border flex items-center gap-2" style={{ background: "rgba(255,255,255,0.55)", borderColor: isCompleted ? `${habit.color}66` : "rgba(255,255,255,0.9)" }}>
                    <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: habit.color }} />
                    <span className="text-xs" aria-hidden="true">{habit.emoji}</span>
                    <p className="text-xs font-medium flex-1" style={{ color: "#1c1c1e" }}>{habit.name}</p>
                    <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: isCompleted ? "rgba(52,199,89,0.12)" : "rgba(0,0,0,0.05)", color: isCompleted ? "#34C759" : "#8E8E93" }}>{isCompleted ? "✓ done" : "○ pending"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
    </div>
  );
}

function NotificationCenter({ notifications, permission, pushEnabled, pushConfigured, pushError, onRequestPermission, onMarkRead, onMarkAllRead, onAddTask }: {
  notifications: AppNotification[];
  permission: NotificationPermission | "unsupported";
  pushEnabled: boolean;
  pushConfigured: boolean;
  pushError: string | null;
  onRequestPermission: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onAddTask: () => void;
}) {
  const unreadCount = notifications.filter(notification => !notification.read).length;
  const centerRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: PointerEvent) {
      if (centerRef.current?.open && !centerRef.current.contains(event.target as Node)) {
        centerRef.current.open = false;
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  return (
    <div className="relative">
      <details ref={centerRef} className="group">
        <summary aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`} className="notification-trigger glass-btn relative flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-2xl text-lg" style={{ color: "#007AFF" }}>
          <span aria-hidden="true">🔔</span>
          {unreadCount > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white" style={{ background: "#FF3B30" }}>{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </summary>
        <div className="notification-panel absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold" style={{ color: "#1c1c1e" }}>Notifications</h2>
              <p className="text-xs" style={{ color: "#8E8E93" }}>{unreadCount ? `${unreadCount} unread` : "You're all caught up"}</p>
            </div>
            {unreadCount > 0 && <button onClick={onMarkAllRead} className="text-xs font-semibold" style={{ color: "#007AFF" }}>Mark all read</button>}
          </div>
          {!pushEnabled && (
            <div className="border-b border-black/5 px-4 py-3">
              <p className="text-xs leading-relaxed" style={{ color: "#636366" }}>
                {permission === "unsupported" ? "Browser notifications aren't supported here." : permission === "denied" ? "Browser notifications are blocked. Allow them in your browser settings to receive reminder pop-ups." : !pushConfigured ? "Background push needs Firebase project configuration before it can be enabled." : permission === "granted" ? "Link this device to receive scheduled reminders when TaskFlow is closed." : "Enable background push to receive reminders when TaskFlow is closed."}
              </p>
              {pushConfigured && permission !== "unsupported" && permission !== "denied" && <button onClick={onRequestPermission} className="mt-2 rounded-xl px-3 py-2 text-xs font-semibold text-white" style={{ background: "#007AFF" }}>Enable background push</button>}
            </div>
          )}
          {pushError && <p role="alert" className="border-b border-black/5 px-4 py-2 text-xs" style={{ color: "#FF3B30" }}>{pushError}</p>}
          <p className="border-b border-black/5 px-4 py-2 text-[10px]" style={{ color: "#8E8E93" }}>{pushEnabled ? "Background push is enabled for this device." : "Reminders run while TaskFlow is open until background push is configured."}</p>
          <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <span className="text-3xl" aria-hidden="true">🔔</span>
                <p className="mt-2 text-sm font-medium" style={{ color: "#636366" }}>No notifications yet</p>
                <p className="mt-1 text-xs" style={{ color: "#8E8E93" }}>Task and habit reminders will show up here.</p>
              </div>
            ) : notifications.map(notification => (
              <div key={notification.id} className="flex gap-3 border-b border-black/5 px-4 py-3 last:border-0" style={{ background: notification.read ? "transparent" : "rgba(0,122,255,0.045)" }}>
                <span className="mt-0.5 text-base" aria-hidden="true">
                  {notification.kind === "overdue" ? "⚠️" : notification.kind === "habit-reminder" ? "🌱" : notification.kind === "daily-planning" ? "📝" : "⏰"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold" style={{ color: "#1c1c1e" }}>{notification.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed" style={{ color: "#636366" }}>{notification.message}</p>
                  <p className="mt-1 text-[10px]" style={{ color: "#8E8E93" }}>{new Date(notification.createdAt).toLocaleString()}</p>
                  {notification.kind === "daily-planning" && <button onClick={() => { onMarkRead(notification.id); onAddTask(); }} className="mt-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold" style={{ color: "#007AFF", background: "rgba(0,122,255,0.1)" }}>Add today’s task</button>}
                </div>
                {!notification.read && <button onClick={() => onMarkRead(notification.id)} className="self-start whitespace-nowrap text-[10px] font-semibold" style={{ color: "#007AFF" }}>Mark read</button>}
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

/* ── Main App ── */
export default function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [habits, setHabits] = useState<Habit[]>(loadHabits);
  const [notifications, setNotifications] = useState<AppNotification[]>(loadNotifications);
  const sentNotificationIds = useRef(new Set(notifications.map(notification => notification.id)));
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [accountDataReady, setAccountDataReady] = useState<string | null>(null);
  const [accountDataError, setAccountDataError] = useState<string | null>(null);
  const [authActionError, setAuthActionError] = useState<string | null>(null);
  const [authActionPending, setAuthActionPending] = useState(false);
  const [signInPrompt, setSignInPrompt] = useState<"task" | "habit" | null>(null);
  const activeGoogleUid = useRef<string | null>(null);
  const authLoadGeneration = useRef(0);
  const tasksRef = useRef(tasks);
  const habitsRef = useRef(habits);
  tasksRef.current = tasks;
  habitsRef.current = habits;
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    () => "Notification" in window ? Notification.permission : "unsupported",
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [view, setView] = useState<View>("tasks");
  const [tab, setTab] = useState<Tab>("all");
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed">("all");
  const [showHabitModal, setShowHabitModal] = useState(false);
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);

  useEffect(() => subscribeToPushUser(user => {
    setFirebaseUser(user);
    const isGoogleUser = Boolean(user?.providerData.some(provider => provider.providerId === "google.com"));
    const previousUid = activeGoogleUid.current;

    if (!user || !isGoogleUser) {
      activeGoogleUid.current = null;
      authLoadGeneration.current += 1;
      setAccountDataReady(null);
      setAccountDataError(null);
      if (previousUid) {
        setTasks(loadTasks());
        setHabits(loadHabits());
      }
      return;
    }

    if (previousUid === user.uid) return;
    activeGoogleUid.current = user.uid;
    const generation = ++authLoadGeneration.current;
    setAccountDataReady(null);
    setAccountDataError(null);

    let shouldMigrateLocalData = true;
    try {
      shouldMigrateLocalData = localStorage.getItem(migratedAccountStorageKey(user.uid)) !== "1";
    } catch (error) {
      console.error("TaskFlow could not check account data migration status.", error);
    }
    const migrateFromThisDevice = shouldMigrateLocalData && previousUid === null;
    const localTasks = migrateFromThisDevice ? tasksRef.current : loadTasks(accountTasksStorageKey(user.uid));
    const localHabits = migrateFromThisDevice ? habitsRef.current : loadHabits(accountHabitsStorageKey(user.uid));

    void syncAccountData(user, localTasks, localHabits, isTask, isHabit).then(data => {
      if (generation !== authLoadGeneration.current) return;
      setTasks(data.tasks);
      setHabits(data.habits);
      setAccountDataReady(user.uid);
      try {
        localStorage.setItem(migratedAccountStorageKey(user.uid), "1");
      } catch (error) {
        console.error("TaskFlow could not save account data migration status.", error);
        setAccountDataError("Your data is synced, but this device could not save its sync status.");
      }
    }).catch(error => {
      if (generation !== authLoadGeneration.current) return;
      console.error("TaskFlow could not sync tasks and habits to your Google account.", error);
      setAccountDataError(error instanceof Error ? error.message : "Could not sync your account data.");
    });
  }), []);

  useEffect(() => {
    if (!signInPrompt || !firebaseUser || accountDataReady !== firebaseUser.uid) return;
    const pendingCreation = signInPrompt;
    setSignInPrompt(null);
    if (pendingCreation === "task") setShowModal(true);
    else setShowHabitModal(true);
  }, [signInPrompt, firebaseUser, accountDataReady]);

  useEffect(() => {
    if (!firebaseUser || firebaseUser.isAnonymous || accountDataReady !== firebaseUser.uid) return;
    const unsubscribeTasks = subscribeToAccountData(firebaseUser, "tasks", isTask, incoming => {
      setTasks(current => mergeSyncedItems(current, incoming));
    }, error => {
      console.error("TaskFlow could not receive synced tasks.", error);
      setAccountDataError(error.message);
    });
    const unsubscribeHabits = subscribeToAccountData(firebaseUser, "habits", isHabit, incoming => {
      setHabits(current => mergeSyncedItems(current, incoming));
    }, error => {
      console.error("TaskFlow could not receive synced habits.", error);
      setAccountDataError(error.message);
    });
    return () => {
      unsubscribeTasks();
      unsubscribeHabits();
    };
  }, [firebaseUser, accountDataReady]);

  useEffect(() => {
    if (!firebaseUser) return;
    if (!firebaseUser.isAnonymous && accountDataReady !== firebaseUser.uid) return;
    void syncReminderData(firebaseUser, tasks, habits).catch(error => {
      console.error("TaskFlow could not sync reminder schedules to Firebase.", error);
      setPushError(error instanceof Error ? error.message : "Could not sync reminder schedules to Firebase.");
    });
  }, [firebaseUser, accountDataReady, tasks, habits]);

  useEffect(() => {
    if (!firebaseUser || notificationPermission !== "granted") return;
    let active = true;
    void subscribeDeviceForPush(firebaseUser).then(() => {
      if (active) {
        setPushEnabled(true);
        setPushError(null);
      }
    }).catch(error => {
      console.error("TaskFlow could not restore its background push subscription.", error);
      if (active) setPushError(error instanceof Error ? error.message : "Could not restore the background push subscription.");
    });
    return () => { active = false; };
  }, [firebaseUser, notificationPermission]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    function receivePush(event: MessageEvent<unknown>) {
      if (typeof event.data !== "object" || event.data === null) return;
      const message = event.data as { type?: unknown; notification?: unknown };
      if (message.type !== "taskflow-push" || typeof message.notification !== "object" || message.notification === null) return;
      const data = message.notification as Record<string, unknown>;
      if (
        typeof data.id !== "string"
        || !isNotificationKind(data.kind)
        || typeof data.title !== "string"
        || typeof data.body !== "string"
        || typeof data.createdAt !== "string"
      ) return;
      const notification: AppNotification = {
        id: data.id,
        kind: data.kind,
        title: data.title,
        message: data.body,
        createdAt: data.createdAt,
        read: false,
      };
      if (!isAppNotification(notification) || sentNotificationIds.current.has(notification.id)) return;
      sentNotificationIds.current.add(notification.id);
      setNotifications(previous => [notification, ...previous].slice(0, 200));
    }
    navigator.serviceWorker.addEventListener("message", receivePush);
    return () => navigator.serviceWorker.removeEventListener("message", receivePush);
  }, []);

  useEffect(() => {
    setIsInstalled(window.matchMedia("(display-mode: standalone)").matches);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
    } catch (error) {
      console.error("TaskFlow could not open the native installation prompt.", error);
      setInstallPrompt(null);
    }
  }

  async function handleGoogleSignIn() {
    if (!firebaseAuthConfigured) {
      setAuthActionError("Google sign-in is unavailable because Firebase is not configured.");
      return;
    }
    setAuthActionPending(true);
    setAuthActionError(null);
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error("TaskFlow could not sign in with Google.", error);
      const errorCode = typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
      setAuthActionError(errorCode === "auth/unauthorized-domain"
        ? `Firebase is blocking sign-in from "${window.location.hostname}". Add this hostname in Firebase Console > Authentication > Settings > Authorized domains, then try again.`
        : error instanceof Error ? error.message : "Could not sign in with Google.");
    } finally {
      setAuthActionPending(false);
    }
  }

  async function handleSignOut() {
    setAuthActionPending(true);
    setAuthActionError(null);
    try {
      await signOutFromFirebase();
    } catch (error) {
      console.error("TaskFlow could not sign out.", error);
      setAuthActionError(error instanceof Error ? error.message : "Could not sign out.");
    } finally {
      setAuthActionPending(false);
    }
  }

  function requestTaskCreation() {
    if (firebaseUser?.providerData.some(provider => provider.providerId === "google.com")) {
      if (accountDataReady === firebaseUser.uid) setShowModal(true);
      else setSignInPrompt("task");
      return;
    }
    setAuthActionError(null);
    setSignInPrompt("task");
  }

  function requestHabitCreation() {
    if (firebaseUser?.providerData.some(provider => provider.providerId === "google.com")) {
      if (accountDataReady === firebaseUser.uid) setShowHabitModal(true);
      else setSignInPrompt("habit");
      return;
    }
    setAuthActionError(null);
    setSignInPrompt("habit");
  }

  useEffect(() => {
    try {
      if (firebaseUser && !firebaseUser.isAnonymous) {
        if (accountDataReady !== firebaseUser.uid) return;
        localStorage.setItem(accountTasksStorageKey(firebaseUser.uid), JSON.stringify(tasks));
        return;
      }
      localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
    } catch (error) {
      console.error("TaskFlow could not save tasks to local storage.", error);
    }
  }, [tasks, firebaseUser, accountDataReady]);

  useEffect(() => {
    try {
      if (firebaseUser && !firebaseUser.isAnonymous) {
        if (accountDataReady !== firebaseUser.uid) return;
        localStorage.setItem(accountHabitsStorageKey(firebaseUser.uid), JSON.stringify(habits));
        return;
      }
      localStorage.setItem(HABITS_STORAGE_KEY, JSON.stringify(habits));
    } catch (error) {
      console.error("TaskFlow could not save habits to local storage.", error);
    }
  }, [habits, firebaseUser, accountDataReady]);

  useEffect(() => {
    if (!firebaseUser || firebaseUser.isAnonymous || accountDataReady !== firebaseUser.uid) return;
    void saveAccountData(firebaseUser, tasks, habits).catch(error => {
      console.error("TaskFlow could not save account tasks and habits.", error);
      setAccountDataError(error instanceof Error ? error.message : "Could not save account data.");
    });
  }, [firebaseUser, accountDataReady, tasks, habits]);

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications));
    } catch (error) {
      console.error("TaskFlow could not save notifications to local storage.", error);
    }
  }, [notifications]);

  function publishNotification(id: string, kind: NotificationKind, title: string, message: string) {
    if (sentNotificationIds.current.has(id)) return;
    sentNotificationIds.current.add(id);
    const notification: AppNotification = { id, kind, title, message, createdAt: new Date().toISOString(), read: false };
    setNotifications(previous => [notification, ...previous].slice(0, 200));

    if (notificationPermission === "granted" && !pushEnabled) {
      try {
        new Notification(title, { body: message, icon: `${import.meta.env.BASE_URL}Icon-192.png`, tag: id });
      } catch (error) {
        console.error("TaskFlow could not display a browser notification.", error);
      }
    }
  }

  useEffect(() => {
    function checkReminders() {
      const now = new Date();
      const today = localDateString(now);
      const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      tasks.forEach(task => {
        if (task.completed) return;
        const deadline = getTaskDeadline(task);
        if (Number.isNaN(deadline.getTime())) return;
        const deadlineKey = `${task.deadline}T${task.deadlineTime || "23:59"}`;
        if (deadline <= now) {
          publishNotification(`overdue:${task.id}:${deadlineKey}`, "overdue", "Task overdue", `“${task.title}” passed its deadline without being completed.`);
          return;
        }

        const leadMinutes = task.reminderMinutesBefore ?? 30;
        const reminderTime = new Date(deadline.getTime() - leadMinutes * 60_000);
        if (reminderTime <= now) {
          const leadText = leadMinutes === 1440 ? "in 1 day" : leadMinutes >= 60 ? `in ${leadMinutes / 60} hour${leadMinutes === 60 ? "" : "s"}` : `in ${leadMinutes} minutes`;
          publishNotification(`task-reminder:${task.id}:${deadlineKey}:${leadMinutes}`, "task-reminder", "Task deadline coming up", `“${task.title}” is due ${leadText}.`);
        }
      });

      habits.forEach(habit => {
        const reminderTime = habit.reminderTime || "22:00";
        if (localTime >= reminderTime && !habit.completedDates.includes(today)) {
          publishNotification(`habit-reminder:${habit.id}:${today}`, "habit-reminder", "Habit reminder", `Time to complete “${habit.name}”.`);
        }
      });

      if (localTime >= "09:00") {
        publishNotification(`daily-planning:${today}`, "daily-planning", "Plan your day", "Take a moment to add the tasks you want to get done today.");
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") checkReminders();
    };
    checkReminders();
    const interval = window.setInterval(checkReminders, 30_000);
    window.addEventListener("focus", checkReminders);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkReminders);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [tasks, habits, notificationPermission, pushEnabled]);

  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    if (!firebasePushConfigured) {
      setPushError("Background push is not configured. Add the Firebase web configuration and VAPID key, then rebuild the app.");
      return;
    }
    try {
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      setNotificationPermission(permission);
      if (permission !== "granted") return;
      setPushError(null);
      const user = await signInForPush();
      await subscribeDeviceForPush(user);
      await syncReminderData(user, tasks, habits);
      setFirebaseUser(user);
      setPushEnabled(true);
    } catch (error) {
      console.error("TaskFlow could not request browser notification permission.", error);
      setPushError(error instanceof Error ? error.message : "Could not enable background push.");
    }
  }

  function markNotificationRead(id: string) {
    setNotifications(previous => previous.map(notification => notification.id === id ? { ...notification, read: true } : notification));
  }

  function markAllNotificationsRead() {
    setNotifications(previous => previous.map(notification => ({ ...notification, read: true })));
  }

  function toggleTask(id: string) { setTasks(p => p.map(t => t.id === id ? { ...t, completed: !t.completed } : t)); }
  function deleteTask(id: string) { setTasks(p => p.filter(t => t.id !== id)); }
  function addTask(task: Task) { setTasks(p => [task, ...p]); }
  function saveTask(updated: Task) { setTasks(p => p.map(t => t.id === updated.id ? updated : t)); }
  function addHabit(habit: Habit) { setHabits(p => [habit, ...p]); }
  function saveHabit(updated: Habit) { setHabits(p => p.map(habit => habit.id === updated.id ? updated : habit)); }
  function deleteHabit(id: string) { setHabits(p => p.filter(habit => habit.id !== id)); }
  function toggleHabit(id: string) {
    const today = dateOffset(0);
    setHabits(previous => previous.map(habit => {
      if (habit.id !== id) return habit;
      const completedDates = habit.completedDates.includes(today)
        ? habit.completedDates.filter(date => date !== today)
        : [...habit.completedDates, today];
      return { ...habit, completedDates };
    }));
  }

  const filtered = useMemo(() => tasks.filter(t => {
    if (tab !== "all" && t.type !== tab) return false;
    if (statusFilter === "pending" && t.completed) return false;
    if (statusFilter === "completed" && !t.completed) return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [tasks, tab, statusFilter, search]);

  const tabs: { id: Tab; label: string; emoji: string }[] = [
    { id: "all", label: "All", emoji: "✦" },
    { id: "daily", label: "Daily", emoji: "☀️" },
    { id: "weekly", label: "Weekly", emoji: "📅" },
    { id: "monthly", label: "Monthly", emoji: "🗓️" },
    { id: "yearly", label: "Yearly", emoji: "🎯" },
  ];

  const donePct = filtered.length ? Math.round((filtered.filter(t => t.completed).length / filtered.length) * 100) : 0;
  const isGoogleAccount = Boolean(firebaseUser?.providerData.some(provider => provider.providerId === "google.com"));

  return (
    <div className="min-h-full bg-iridescent">
      {showModal && <AddTaskModal onClose={() => setShowModal(false)} onAdd={addTask} />}
      {showHabitModal && <HabitModal onClose={() => setShowHabitModal(false)} onSave={addHabit} />}
      {editingHabit && <HabitModal key={editingHabit.id} habit={editingHabit} onClose={() => setEditingHabit(null)} onSave={saveHabit} />}
      {editingTask && <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSave={saveTask} />}
      {signInPrompt && (
        <div className="modal-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4"
          onMouseDown={event => { if (event.target === event.currentTarget) setSignInPrompt(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="sign-in-prompt-title"
            className="glass-card relative w-full max-w-sm rounded-3xl p-6 text-center">
            <button onClick={() => setSignInPrompt(null)} aria-label="Close sign-in prompt"
              className="absolute right-5 top-5 rounded-full px-2 py-1 text-lg" style={{ color: "#8E8E93" }}>×</button>
            <span className="text-4xl" aria-hidden="true">{signInPrompt === "task" ? "📋" : "🌱"}</span>
            <h2 id="sign-in-prompt-title" className="mt-3 text-lg font-bold" style={{ color: "#1c1c1e" }}>
              Sign in to create a {signInPrompt}
            </h2>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "#636366" }}>
              Sign in with Google to create and sync your tasks and habits across devices.
            </p>
            {authActionError && <p role="alert" className="mt-3 text-xs leading-relaxed" style={{ color: "#B42318" }}>{authActionError}</p>}
            {accountDataError && <p role="alert" className="mt-3 text-xs leading-relaxed" style={{ color: "#B42318" }}>{accountDataError}</p>}
            {firebaseUser?.providerData.some(provider => provider.providerId === "google.com") ? (
              <p className="mt-4 text-sm font-medium" style={{ color: "#007AFF" }}>Preparing your account…</p>
            ) : (
              <button onClick={handleGoogleSignIn} disabled={authActionPending || !firebaseAuthConfigured}
                className="mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)" }}>
                {authActionPending ? "Signing in…" : "Continue with Google"}
              </button>
            )}
            {!firebaseAuthConfigured && <p className="mt-3 text-xs" style={{ color: "#8E8E93" }}>Firebase needs to be configured before you can sign in.</p>}
          </section>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-40 glass border-b border-white/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="order-1 flex items-center gap-3 sm:order-1">
            <img src={`${import.meta.env.BASE_URL}Icon.png`} alt="TaskFlow" width={36} height={36}
              className="w-9 h-9 rounded-2xl bg-white/80 p-0.5 object-contain shadow-lg ring-1 ring-blue-100"
              style={{ boxShadow: "0 4px 14px rgba(0,122,255,0.4)" }} />
            <div>
              <h1 className="text-base font-bold leading-tight" style={{ color: "#1c1c1e", letterSpacing: "-0.5px" }}>TaskFlow</h1>
              <p className="text-xs leading-none" style={{ color: "#8E8E93" }}>
                {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </p>
            </div>
          </div>
          <div className="order-2 flex flex-1 min-w-0 items-center justify-end gap-2 sm:order-2 sm:ml-3">
            {installPrompt && !isInstalled && (
              <button onClick={installApp}
                className="glass-btn rounded-2xl px-3 py-2 text-sm font-semibold whitespace-nowrap"
                style={{ color: "#007AFF" }}>
                Install
              </button>
            )}
            {isGoogleAccount ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="hidden max-w-32 truncate text-xs font-medium sm:inline" style={{ color: "#636366" }}
                  title={firebaseUser?.email || firebaseUser?.displayName || undefined}>
                  {firebaseUser?.displayName || firebaseUser?.email || "Google account"}
                  <span className="ml-1 text-[10px]">{accountDataReady === firebaseUser?.uid ? "· Synced" : "· Syncing…"}</span>
                </span>
                <button onClick={handleSignOut} disabled={authActionPending}
                  className="glass-btn rounded-2xl px-3 py-2 text-xs font-semibold whitespace-nowrap disabled:opacity-50"
                  style={{ color: "#007AFF" }}>
                  Sign out
                </button>
              </div>
            ) : (
              <button onClick={handleGoogleSignIn} disabled={authActionPending || !firebaseAuthConfigured}
                className="glass-btn rounded-2xl px-3 py-2 text-xs font-semibold whitespace-nowrap disabled:opacity-50"
                style={{ color: "#007AFF" }}
                title={firebaseAuthConfigured ? "Sign in with Google to sync your tasks and habits" : "Configure Firebase to enable Google sign-in"}>
                {authActionPending ? "Signing in…" : "Sign in"}
              </button>
            )}
            {/* View toggle */}
            <div className="hidden sm:grid flex-1 min-w-0 grid-cols-[1fr_auto_1fr] items-center">
              <div />
              <div className="glass-dark flex items-center justify-center gap-1 rounded-2xl p-1">
                {(["tasks", "habits"] as View[]).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all tab-pill"
                    style={{
                      background: view === v ? "rgba(255,255,255,0.85)" : "transparent",
                      color: view === v ? "#007AFF" : "#8E8E93",
                      boxShadow: view === v ? "0 1px 6px rgba(0,0,0,0.08)" : "none",
                      fontWeight: view === v ? 600 : 400,
                    }}>
                    {v === "tasks" ? "📋 Tasks" : "🌱 Habits"}
                  </button>
                ))}
              </div>
              <button onClick={() => setView("calendar")} aria-label="Calendar" title="Calendar"
                className="glass-dark justify-self-end rounded-xl px-3 py-2 text-sm transition-all tab-pill"
                style={{
                  background: view === "calendar" ? "rgba(255,255,255,0.85)" : undefined,
                  color: view === "calendar" ? "#007AFF" : "#8E8E93",
                  boxShadow: view === "calendar" ? "0 1px 6px rgba(0,0,0,0.08)" : undefined,
                }}>
                📅
              </button>
            </div>
            <div className="order-2 sm:order-2">
              <NotificationCenter
                notifications={notifications}
                permission={notificationPermission}
                pushEnabled={pushEnabled}
                pushConfigured={firebasePushConfigured}
                pushError={pushError}
                onRequestPermission={requestNotificationPermission}
                onMarkRead={markNotificationRead}
                onMarkAllRead={markAllNotificationsRead}
                onAddTask={() => { setView("tasks"); requestTaskCreation(); }}
              />
            </div>
            <button onClick={() => view === "habits" ? requestHabitCreation() : requestTaskCreation()}
              className="order-1 flex items-center gap-1.5 px-4 py-2 rounded-2xl text-sm font-semibold transition-all active:scale-95 sm:order-1"
              style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(0,122,255,0.35)" }}>
              <span className="text-base leading-none font-light">+</span>
              <span className="hidden sm:inline">{view === "habits" ? "New Habit" : "New Task"}</span>
            </button>
          </div>
        </div>
        {/* Mobile view toggle */}
        <div className="sm:hidden grid grid-cols-[1fr_auto_1fr] items-center border-t border-white/40 px-4 py-2">
          <div />
          <div className="glass-dark flex items-center justify-center gap-1 rounded-2xl p-1">
            {(["tasks", "habits"] as View[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className="px-3 py-2 rounded-xl text-xs font-medium transition-all"
                style={{ background: view === v ? "rgba(255,255,255,0.7)" : "transparent", color: view === v ? "#007AFF" : "#8E8E93" }}>
                {v === "tasks" ? "📋 Tasks" : "🌱 Habits"}
              </button>
            ))}
          </div>
          <button onClick={() => setView("calendar")} aria-label="Calendar" title="Calendar"
            className="glass-dark justify-self-end rounded-xl px-3 py-2 text-sm transition-all"
            style={{ background: view === "calendar" ? "rgba(255,255,255,0.7)" : undefined, color: view === "calendar" ? "#007AFF" : "#8E8E93" }}>
            📅
          </button>
        </div>
      </header>

      {(authActionError || accountDataError) && (
        <p role="alert" className="mx-auto mt-3 max-w-5xl px-4 text-sm font-medium" style={{ color: "#B42318" }}>
          {authActionError || accountDataError}
        </p>
      )}

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {view === "habits" ? <HabitStats habits={habits} /> : view === "tasks" ? <StatsBar tasks={filtered} /> : null}

        {view === "habits" ? (
          <section className="space-y-4">
            <div className="glass-card rounded-3xl px-5 py-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold" style={{ color: "#1c1c1e" }}>Your habits</h2>
                <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>Build better routines, one day at a time.</p>
              </div>
              <button onClick={requestHabitCreation} className="glass-btn px-4 py-2 rounded-2xl text-xs font-semibold whitespace-nowrap" style={{ color: "#34C759" }}>+ Add a habit</button>
            </div>
            {habits.length === 0 ? (
              <div className="glass-card rounded-3xl py-16 flex flex-col items-center gap-3">
                <span className="text-4xl">🌱</span>
                <p className="text-sm font-medium" style={{ color: "#8E8E93" }}>No habits yet</p>
                <button onClick={requestHabitCreation} className="glass-btn px-4 py-2 rounded-2xl text-xs font-semibold" style={{ color: "#34C759" }}>Create your first habit</button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {habits.map(habit => <HabitCard key={habit.id} habit={habit} onToggle={toggleHabit} onDelete={deleteHabit} onEdit={setEditingHabit} />)}
              </div>
            )}
          </section>
        ) : view === "tasks" ? (
          <>
            {/* Tabs */}
            <div className="glass rounded-3xl p-1.5 flex justify-center gap-1 overflow-x-auto">
              {tabs.map(t => {
                const count = t.id === "all" ? tasks.length : tasks.filter(x => x.type === t.id).length;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-2xl text-xs font-medium whitespace-nowrap transition-all tab-pill flex-shrink-0"
                    style={{
                      background: tab === t.id ? "rgba(255,255,255,0.88)" : "transparent",
                      color: t.id === "all" ? "#007AFF" : tab === t.id ? TYPE_META[t.id as TaskType].color : "#8E8E93",
                      boxShadow: tab === t.id ? "0 2px 10px rgba(0,0,0,0.08), 0 1px 0 rgba(255,255,255,1) inset" : "none",
                      fontWeight: tab === t.id ? 600 : 400,
                    }}>
                    <span>{t.emoji}</span>
                    <span>{t.label}</span>
                    <span className="rounded-full px-1.5 py-0.5 text-xs font-mono" style={{ background: "rgba(0,0,0,0.06)", color: "#8E8E93" }}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Search + filter */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: "#8E8E93" }}>🔍</span>
                <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks..."
                  className="w-full pl-9 pr-4 py-2.5 rounded-2xl text-sm border"
                  style={{ background: "rgba(255,255,255,0.62)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", backdropFilter: "blur(12px)" }} />
              </div>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                className="px-3 py-2.5 rounded-2xl text-sm border"
                style={{ background: "rgba(255,255,255,0.62)", borderColor: "rgba(255,255,255,0.9)", color: "#1c1c1e", backdropFilter: "blur(12px)" }}>
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="completed">Done</option>
              </select>
            </div>

            {/* Progress */}
            {filtered.length > 0 && (
              <div className="glass-card rounded-3xl px-5 py-4">
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-xs font-medium" style={{ color: "#8E8E93" }}>Progress</span>
                  <span className="text-xs font-bold font-mono" style={{ color: "#007AFF" }}>{filtered.filter(t => t.completed).length} / {filtered.length} completed</span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.07)" }}>
                  <div className="h-full rounded-full progress-bar" style={{
                    width: `${donePct}%`,
                    background: donePct === 100 ? "#34C759" : "linear-gradient(90deg, #007AFF 0%, #5B5BFF 100%)",
                    boxShadow: donePct > 0 ? "0 0 8px rgba(0,122,255,0.4)" : "none",
                  }} />
                </div>
              </div>
            )}

            {/* Task list */}
            {filtered.length === 0 ? (
              <div className="glass-card rounded-3xl py-16 flex flex-col items-center gap-3">
                <span className="text-4xl">🌸</span>
                <p className="text-sm font-medium" style={{ color: "#8E8E93" }}>No tasks found</p>
                <button onClick={requestTaskCreation} className="glass-btn px-4 py-2 rounded-2xl text-xs font-semibold" style={{ color: "#007AFF" }}>
                  + Add a task
                </button>
              </div>
            ) : (
              <div className="space-y-2.5 group">
                {filtered.map((task, i) => (
                  <div key={task.id} style={{ animationDelay: `${i * 40}ms` }}>
                    <TaskCard task={task} onToggle={toggleTask} onDelete={deleteTask} onEdit={setEditingTask} />
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <CalendarView tasks={tasks} habits={habits} />
        )}
      </main>
    </div>
  );
}
