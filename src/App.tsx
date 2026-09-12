import { useState, useMemo, useRef, useEffect } from "react";

type TaskType = "daily" | "weekly" | "monthly" | "yearly";
type Priority = "low" | "medium" | "high";

interface Task {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  deadline: string;
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
  createdAt: string;
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
function monthsFromNow(n: number) {
  const d = new Date(); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10);
}

const INITIAL_TASKS: Task[] = [
  { id: uid(), title: "Morning workout", description: "30 min cardio + stretching", type: "daily", deadline: daysFromNow(0), hours: 0.5, priority: "medium", completed: true, createdAt: new Date().toISOString() },
  { id: uid(), title: "Review pull requests", description: "Check open PRs and leave feedback", type: "daily", deadline: daysFromNow(0), hours: 1.5, priority: "high", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Team standup", description: "Daily sync with engineering team", type: "daily", deadline: daysFromNow(0), hours: 0.5, priority: "medium", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Write unit tests", description: "Add coverage for the auth module", type: "weekly", deadline: daysFromNow(4), hours: 6, priority: "high", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Design system audit", description: "Review components for accessibility", type: "weekly", deadline: daysFromNow(6), hours: 4, priority: "medium", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Q3 performance reviews", description: "Complete reviews for direct reports", type: "monthly", deadline: monthsFromNow(1), hours: 12, priority: "high", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Blog post on system design", description: "Write and publish technical article", type: "monthly", deadline: monthsFromNow(1), hours: 8, priority: "low", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "Ship v2.0 release", description: "Complete all milestones for the next major version", type: "yearly", deadline: monthsFromNow(3), hours: 320, priority: "high", completed: false, createdAt: new Date().toISOString() },
  { id: uid(), title: "AWS Solutions Architect cert", description: "Study and pass the SAA-C03 exam", type: "yearly", deadline: monthsFromNow(6), hours: 120, priority: "medium", completed: false, createdAt: new Date().toISOString() },
];

const TASKS_STORAGE_KEY = "taskflow.tasks";
const HABITS_STORAGE_KEY = "taskflow.habits";

function isTaskType(value: unknown): value is TaskType {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly";
}

function isPriority(value: unknown): value is Priority {
  return value === "low" || value === "medium" || value === "high";
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string"
    && typeof task.title === "string"
    && typeof task.description === "string"
    && isTaskType(task.type)
    && typeof task.deadline === "string"
    && typeof task.hours === "number"
    && isPriority(task.priority)
    && typeof task.completed === "boolean"
    && typeof task.createdAt === "string";
}

function loadTasks(): Task[] {
  try {
    const stored = localStorage.getItem(TASKS_STORAGE_KEY);
    if (!stored) return INITIAL_TASKS;

    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || !parsed.every(isTask)) {
      console.error("TaskFlow could not restore tasks because stored data is invalid.");
      return INITIAL_TASKS;
    }

    return parsed;
  } catch (error) {
    console.error("TaskFlow could not restore tasks from local storage.", error);
    return INITIAL_TASKS;
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
    && typeof habit.createdAt === "string";
}

function loadHabits(): Habit[] {
  try {
    const stored = localStorage.getItem(HABITS_STORAGE_KEY);
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

function dateOffset(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

/* ── Add Habit Modal ── */
function AddHabitModal({ onClose, onAdd }: { onClose: () => void; onAdd: (habit: Habit) => void }) {
  const [form, setForm] = useState({ name: "", emoji: "🌱", color: "#34C759" });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    onAdd({ id: uid(), ...form, name: form.name.trim(), completedDates: [], createdAt: new Date().toISOString() });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="glass w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-6 animate-in">
        <div className="w-10 h-1 rounded-full mx-auto mb-5 sm:hidden" style={{ background: "rgba(0,0,0,0.15)" }} />
        <div className="flex items-center justify-between mb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#34C759" }}>Habit tracker</p>
            <h2 className="text-xl font-semibold" style={{ color: "#1c1c1e", letterSpacing: "-0.4px" }}>New Habit</h2>
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
              <input type="text" maxLength={2} value={form.emoji} onChange={e => setForm(p => ({ ...p, emoji: e.target.value || "🌱" }))}
                className="w-full px-4 py-3 rounded-2xl text-xl text-center border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)" }} />
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: "#636366" }}>Color</label>
              <input type="color" value={form.color} onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                className="w-full h-12 p-1 rounded-2xl border" style={{ background: "rgba(255,255,255,0.6)", borderColor: "rgba(255,255,255,0.9)" }} />
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="glass-btn flex-1 py-3 rounded-2xl text-sm font-medium" style={{ color: "#636366" }}>Cancel</button>
            <button type="submit" className="flex-1 py-3 rounded-2xl text-sm font-semibold transition-all hover:opacity-90 active:scale-95"
              style={{ background: "linear-gradient(135deg, #34C759 0%, #00A86B 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(52,199,89,0.35)" }}>
              Add Habit
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
  const [form, setForm] = useState({ title: "", description: "", type: "daily" as TaskType, deadline: daysFromNow(0), hours: "", priority: "medium" as Priority });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onAdd({ id: uid(), ...form, title: form.title.trim(), description: form.description.trim(), hours: parseFloat(form.hours) || 1, completed: false, createdAt: new Date().toISOString() });
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
    hours: String(task.hours),
    priority: task.priority,
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSave({ ...task, ...form, title: form.title.trim(), description: form.description.trim(), hours: parseFloat(form.hours) || 1 });
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
  const overdue = tasks.filter(t => !t.completed && t.deadline < new Date().toISOString().slice(0, 10)).length;
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

/* ── Task Card ── */
function TaskCard({ task, onToggle, onDelete, onEdit }: {
  task: Task; onToggle: (id: string) => void; onDelete: (id: string) => void; onEdit: (t: Task) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = !task.completed && task.deadline < today;
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
              📅 {isOverdue && !task.completed ? `${Math.abs(daysLeft)}d overdue` : task.completed ? "Completed" : daysLeft === 0 ? "Due today" : `${daysLeft}d left`}
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>
              ⏱ {task.hours}h
            </span>
            <span className="text-xs font-medium rounded-full px-2 py-0.5" style={{ background: "rgba(0,0,0,0.05)", color: "#8E8E93" }}>
              🗓 {task.deadline}
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

function HabitCard({ habit, onToggle, onDelete }: { habit: Habit; onToggle: (id: string) => void; onDelete: (id: string) => void }) {
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
              <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>{streak > 0 ? `🔥 ${streak} day streak` : "Start your streak today"}</p>
            </div>
            <button onClick={() => onDelete(habit.id)} className="glass-btn w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ color: "#FF3B30" }} aria-label={`Delete ${habit.name}`}>✕</button>
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
function CalendarView({ tasks }: { tasks: Task[] }) {
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

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

  const cells: (number | null)[] = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  const todayStr = today.toISOString().slice(0, 10);
  const selectedTasks = tasksByDate[selectedDay] || [];

  return (
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
                const isToday = ds === todayStr;
                const isSel = ds === selectedDay;
                const dotColors = [...new Set(dayTasks.slice(0, 3).map(t => TYPE_META[t.type].color))];
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
                    {dotColors.length > 0 && (
                      <div className="absolute bottom-1 flex gap-0.5">
                        {dotColors.map((c, i) => (
                          <span key={i} className="w-1 h-1 rounded-full" style={{ background: isSel ? "rgba(255,255,255,0.8)" : c }} />
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
        {selectedTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <span className="text-3xl">🌿</span>
            <p className="text-xs text-center" style={{ color: "#8E8E93" }}>No tasks this day</p>
          </div>
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
                        {task.completed && <span className="text-xs rounded-full px-1.5 py-0.5" style={{ background: "rgba(52,199,89,0.12)", color: "#34C759" }}>✓ done</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main App ── */
export default function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [habits, setHabits] = useState<Habit[]>(loadHabits);
  const [view, setView] = useState<View>("tasks");
  const [tab, setTab] = useState<Tab>("all");
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "completed">("all");
  const [showHabitModal, setShowHabitModal] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
    } catch (error) {
      console.error("TaskFlow could not save tasks to local storage.", error);
    }
  }, [tasks]);

  useEffect(() => {
    try {
      localStorage.setItem(HABITS_STORAGE_KEY, JSON.stringify(habits));
    } catch (error) {
      console.error("TaskFlow could not save habits to local storage.", error);
    }
  }, [habits]);

  function toggleTask(id: string) { setTasks(p => p.map(t => t.id === id ? { ...t, completed: !t.completed } : t)); }
  function deleteTask(id: string) { setTasks(p => p.filter(t => t.id !== id)); }
  function addTask(task: Task) { setTasks(p => [task, ...p]); }
  function saveTask(updated: Task) { setTasks(p => p.map(t => t.id === updated.id ? updated : t)); }
  function addHabit(habit: Habit) { setHabits(p => [habit, ...p]); }
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

  return (
    <div className="min-h-full bg-iridescent">
      {showModal && <AddTaskModal onClose={() => setShowModal(false)} onAdd={addTask} />}
      {showHabitModal && <AddHabitModal onClose={() => setShowHabitModal(false)} onAdd={addHabit} />}
      {editingTask && <EditTaskModal task={editingTask} onClose={() => setEditingTask(null)} onSave={saveTask} />}

      {/* Header */}
      <header className="sticky top-0 z-40 glass border-b border-white/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl flex items-center justify-center text-lg font-bold shadow-lg"
              style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)", boxShadow: "0 4px 14px rgba(0,122,255,0.4)" }}>
              ✦
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight" style={{ color: "#1c1c1e", letterSpacing: "-0.5px" }}>TaskFlow</h1>
              <p className="text-xs leading-none" style={{ color: "#8E8E93" }}>
                {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="hidden sm:flex glass-dark rounded-2xl p-1 gap-1">
              {(["tasks", "habits", "calendar"] as View[]).map(v => (
                <button key={v} onClick={() => setView(v)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all tab-pill"
                  style={{
                    background: view === v ? "rgba(255,255,255,0.85)" : "transparent",
                    color: view === v ? "#007AFF" : "#8E8E93",
                    boxShadow: view === v ? "0 1px 6px rgba(0,0,0,0.08)" : "none",
                    fontWeight: view === v ? 600 : 400,
                  }}>
                  {v === "tasks" ? "📋 Tasks" : v === "habits" ? "🌱 Habits" : "📅 Calendar"}
                </button>
              ))}
            </div>
            <button onClick={() => view === "habits" ? setShowHabitModal(true) : setShowModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-2xl text-sm font-semibold transition-all active:scale-95"
              style={{ background: "linear-gradient(135deg, #007AFF 0%, #5B5BFF 100%)", color: "#fff", boxShadow: "0 4px 16px rgba(0,122,255,0.35)" }}>
              <span className="text-base leading-none font-light">+</span>
              <span className="hidden sm:inline">{view === "habits" ? "New Habit" : "New Task"}</span>
            </button>
          </div>
        </div>
        {/* Mobile view toggle */}
        <div className="sm:hidden flex border-t border-white/40 px-4 py-2 gap-2">
          {(["tasks", "habits", "calendar"] as View[]).map(v => (
            <button key={v} onClick={() => setView(v)}
              className="flex-1 py-2 rounded-xl text-xs font-medium transition-all"
              style={{ background: view === v ? "rgba(255,255,255,0.7)" : "transparent", color: view === v ? "#007AFF" : "#8E8E93" }}>
              {v === "tasks" ? "📋 Tasks" : v === "habits" ? "🌱 Habits" : "📅 Calendar"}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {view === "habits" ? <HabitStats habits={habits} /> : <StatsBar tasks={view === "tasks" ? filtered : tasks} />}

        {view === "tasks" ? (
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
            {view === "habits" ? (
              <section className="space-y-4">
                <div className="glass-card rounded-3xl px-5 py-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold" style={{ color: "#1c1c1e" }}>Build better routines</h2>
                    <p className="text-xs mt-1" style={{ color: "#8E8E93" }}>Small steps, tracked consistently.</p>
                  </div>
                  <span className="text-3xl" style={{ animation: "float 4s ease-in-out infinite" }}>🌿</span>
                </div>
                {habits.length === 0 ? (
                  <div className="glass-card rounded-3xl py-16 flex flex-col items-center gap-3">
                    <span className="text-4xl">🌱</span>
                    <p className="text-sm font-medium" style={{ color: "#8E8E93" }}>No habits yet</p>
                    <button onClick={() => setShowHabitModal(true)} className="glass-btn px-4 py-2 rounded-2xl text-xs font-semibold" style={{ color: "#34C759" }}>+ Add a habit</button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {habits.map(habit => <HabitCard key={habit.id} habit={habit} onToggle={toggleHabit} onDelete={deleteHabit} />)}
                  </div>
                )}
              </section>
            ) : filtered.length === 0 ? (
              <div className="glass-card rounded-3xl py-16 flex flex-col items-center gap-3">
                <span className="text-4xl">🌸</span>
                <p className="text-sm font-medium" style={{ color: "#8E8E93" }}>No tasks found</p>
                <button onClick={() => setShowModal(true)} className="glass-btn px-4 py-2 rounded-2xl text-xs font-semibold" style={{ color: "#007AFF" }}>
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
          <CalendarView tasks={tasks} />
        )}
      </main>
    </div>
  );
}
