// Daily word review: a count on the Words tab (and the app icon), a gentle
// nudge when you open the app after your chosen time, a phone/desktop
// notification where the browser supports background checks, and a calendar
// reminder you can add anywhere.
import { store } from "../data/store.js";
import { isDue } from "../data/dictionary.js";
import { bus, el, downloadBlob } from "./util.js";
import { dialog, toast } from "../ui/overlay.js";

export const dueCount = () => store.list("words").filter((w) => w.status !== "mastered" && isDue(w)).length;

function badge() {
  const n = dueCount();
  document.querySelectorAll('.nav-item[data-nav="words"]').forEach((a) => { a.dataset.badge = n ? (n > 99 ? "99+" : String(n)) : ""; });
  try { if (store.settings().reviewReminder) n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {}
}

export function startReminders() {
  badge();
  bus.on("change", ({ coll, rec }) => (coll === "words" || (coll === "settings" && rec?.id === "settings")) && badge());
  setInterval(badge, 20 * 60 * 1000);
  setTimeout(nudge, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { badge(); nudge(); } });
  registerPeriodic();
}

function nudge() {
  const s = store.settings();
  if (!s.reviewReminder || new Date().getHours() < (s.reminderHour ?? 19)) return;
  const n = dueCount();
  const day = new Date().toDateString();
  if (!n || localStorage.getItem("luma.nudged") === day) return;
  localStorage.setItem("luma.nudged", day);
  toast(`${n} ${n === 1 ? "word is" : "words are"} ready for review`, { action: "Review", onAction: () => { location.hash = "#/words"; }, duration: 9000 });
}

async function registerPeriodic() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg?.periodicSync) return false;
    if (!store.settings().reviewReminder) { await reg.periodicSync.unregister("luma-review"); return false; }
    const st = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (st.state !== "granted") return false;
    await reg.periodicSync.register("luma-review", { minInterval: 6 * 3600 * 1000 });
    return true;
  } catch {
    return false;
  }
}

export async function setReminders(on, hour) {
  if (on && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch {}
  }
  await store.setSettings({ reviewReminder: on, ...(hour != null ? { reminderHour: hour } : {}) });
  const bg = on ? await registerPeriodic() : (registerPeriodic(), false);
  badge();
  return { notifications: "Notification" in window && Notification.permission === "granted", background: bg };
}

function icsFile(hour) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const start = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(hour)}0000`;
  const url = location.origin + location.pathname + "#/words";
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Luma Reader//EN", "BEGIN:VEVENT",
    `UID:luma-review-${Date.now()}@luma`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART:${start}`, "DURATION:PT10M", "RRULE:FREQ=DAILY", "SUMMARY:Review your words in Luma", `DESCRIPTION:Ten minutes with your words: ${url}`, `URL:${url}`,
    "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", "DESCRIPTION:Review your words in Luma", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export function reminderDialog() {
  const s = store.settings();
  return dialog({
    title: "Daily review",
    body: (c) => {
      const on = el("input", { type: "checkbox", role: "switch", checked: Boolean(s.reviewReminder) });
      const hour = el("select.select", { "aria-label": "Reminder time" }, Array.from({ length: 17 }, (_, i) => i + 6).map((h) =>
        el("option", { value: h, selected: h === (s.reminderHour ?? 19) }, new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))));
      const goal = el("select.select", { "aria-label": "Daily goal" }, [5, 10, 15, 20, 30].map((n) => el("option", { value: n, selected: n === (s.dailyGoal || 10) }, `${n} words a day`)));
      const status = el("p.muted.small");
      const apply = async () => {
        await store.setSettings({ dailyGoal: Number(goal.value) });
        const r = await setReminders(on.checked, Number(hour.value));
        status.textContent = !on.checked ? "Reminders are off." : r.background
          ? "You'll get a notification when words are due, even with the app closed."
          : r.notifications ? "You'll get a reminder when you open Luma after this time. For a reminder with the app closed, add it to your calendar too."
          : "You'll see a reminder when you open Luma after this time. Add it to your calendar to be reminded anywhere.";
      };
      on.onchange = apply; hour.onchange = apply; goal.onchange = apply;
      c.append(
        el("label.typo-row.switch-row", {}, el("span.typo-label", {}, "Remind me every day"), el("span.switch", {}, on, el("span.knob"))),
        el("label.field", {}, el("span", {}, "At"), hour),
        el("label.field", {}, el("span", {}, "Goal"), goal),
        status,
        el("button.btn", { onclick: () => downloadBlob(new Blob([icsFile(Number(hour.value))], { type: "text/calendar" }), "luma-daily-review.ics") }, "Add a daily reminder to my calendar"));
      if (s.reviewReminder) apply();
    },
    actions: [{ label: "Done", primary: true }],
  });
}
