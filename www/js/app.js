// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
  serverUrl: "schedule_server_url",
  apiKey: "schedule_api_key",
  cachedFull: "schedule_cached_full",
  lastSync: "schedule_last_sync",
  outbox: "schedule_outbox",
  notifyEnabled: "schedule_notify_enabled",
  notifyLead: "schedule_notify_lead",
  notifySound: "schedule_notify_sound",
  notifyIds: "schedule_notify_ids",
  notifyFingerprint: "schedule_notify_fingerprint",
  welcomeDismissed: "schedule_welcome_dismissed",
  expandedGroups: "schedule_expanded_groups",
};

// ---------------------------------------------------------------------------
// HTML escaping — every piece of user-entered text (course names, notes,
// titles, instructor info, ...) gets rendered via innerHTML for layout
// convenience, so it has to be escaped first. Never interpolate raw fields
// into a template string that ends up in innerHTML.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Icons used in JS-generated markup (rest are static in index.html) —
// pulls from the inline sprite defined at the top of <body>.
const ICONS = {
  pin: `<svg class="icon" aria-hidden="true"><use href="#icon-pin"></use></svg>`,
  folder: `<svg class="icon" aria-hidden="true"><use href="#icon-folder"></use></svg>`,
  chevron: `<svg class="icon" aria-hidden="true"><use href="#icon-chevron"></use></svg>`,
  x: `<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>`,
};

function getServerUrl() {
  return localStorage.getItem(STORAGE_KEYS.serverUrl) || "";
}
function getApiKey() {
  return localStorage.getItem(STORAGE_KEYS.apiKey) || "";
}
function saveSettings(url, key) {
  localStorage.setItem(STORAGE_KEYS.serverUrl, url.replace(/\/$/, ""));
  localStorage.setItem(STORAGE_KEYS.apiKey, key);
}

// ---------------------------------------------------------------------------
// Local cache (source of truth for rendering — always read from here)
// ---------------------------------------------------------------------------

function getCache() {
  const raw = localStorage.getItem(STORAGE_KEYS.cachedFull);
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    sessions: parsed.sessions || [],
    overrides: parsed.overrides || [],
    events: parsed.events || [],
  };
}

// Used only when pulling fresh truth from the server (also stamps lastSync).
function setCacheFromServer(data) {
  localStorage.setItem(STORAGE_KEYS.cachedFull, JSON.stringify(data));
  localStorage.setItem(STORAGE_KEYS.lastSync, new Date().toISOString());
}

// Used for local optimistic edits — does NOT touch lastSync, since nothing
// was actually confirmed by the server yet.
function saveCacheOnly(cache) {
  localStorage.setItem(STORAGE_KEYS.cachedFull, JSON.stringify(cache));
}

function getLastSync() {
  return localStorage.getItem(STORAGE_KEYS.lastSync);
}

// ---------------------------------------------------------------------------
// Outbox (queued writes waiting to reach the server)
// ---------------------------------------------------------------------------

function getOutbox() {
  const raw = localStorage.getItem(STORAGE_KEYS.outbox);
  return raw ? JSON.parse(raw) : [];
}
function setOutbox(ops) {
  localStorage.setItem(STORAGE_KEYS.outbox, JSON.stringify(ops));
}
function genOpId() {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function genTempId() {
  return -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

function queueOp(entity, action, targetId, payload) {
  const outbox = getOutbox();
  outbox.push({ opId: genOpId(), entity, action, targetId, payload: payload || null });
  setOutbox(outbox);
}

// ---------------------------------------------------------------------------
// Optimistic local mutations — applied immediately, regardless of connectivity
// ---------------------------------------------------------------------------

function applyLocalCreate(entity, payload) {
  const cache = getCache();
  const tempId = genTempId();
  const listKey = entity + "s";
  cache[listKey].push({ ...payload, id: tempId, updated_at: new Date().toISOString() });
  saveCacheOnly(cache);
  return tempId;
}

function applyLocalUpdate(entity, id, payload) {
  const cache = getCache();
  const listKey = entity + "s";
  const idx = cache[listKey].findIndex((item) => item.id === id);
  if (idx !== -1) {
    cache[listKey][idx] = { ...cache[listKey][idx], ...payload, updated_at: new Date().toISOString() };
  }
  saveCacheOnly(cache);
}

function applyLocalDelete(entity, id) {
  const cache = getCache();
  const listKey = entity + "s";
  cache[listKey] = cache[listKey].filter((item) => item.id !== id);
  if (entity === "session") {
    cache.overrides = cache.overrides.filter((o) => o.session_id !== id);
  }
  saveCacheOnly(cache);
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  const base = getServerUrl();
  const key = getApiKey();
  if (!base) throw new Error("No server configured yet");
  const res = await fetch(base + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

async function syncFull() {
  const data = await apiFetch("/api/schedule/full");
  setCacheFromServer(data);
  return data;
}

// ---------------------------------------------------------------------------
// Outbox draining — pushes queued local writes to the server, in order,
// remapping any temp (offline-created) IDs to real server IDs as they resolve.
// ---------------------------------------------------------------------------

const ENTITY_PATHS = { session: "/api/sessions", event: "/api/events", override: "/api/overrides" };

async function sendOp(op) {
  const base = ENTITY_PATHS[op.entity];
  if (op.action === "create") return apiFetch(base, { method: "POST", body: JSON.stringify(op.payload) });
  if (op.action === "update") return apiFetch(`${base}/${op.targetId}`, { method: "PUT", body: JSON.stringify(op.payload) });
  if (op.action === "delete") return apiFetch(`${base}/${op.targetId}`, { method: "DELETE" });
}

function remapTempId(op, idMap) {
  if (op.targetId < 0 && idMap[op.targetId] !== undefined) {
    op.targetId = idMap[op.targetId];
  }
  if (op.entity === "override" && op.payload && op.payload.session_id < 0 && idMap[op.payload.session_id] !== undefined) {
    op.payload.session_id = idMap[op.payload.session_id];
  }
}

function remapCacheTempId(entity, tempId, realId) {
  const cache = getCache();
  const listKey = entity + "s";
  const item = cache[listKey].find((i) => i.id === tempId);
  if (item) item.id = realId;
  if (entity === "session") {
    cache.overrides.forEach((o) => { if (o.session_id === tempId) o.session_id = realId; });
  }
  saveCacheOnly(cache);
}

async function drainOutbox() {
  const idMap = {};
  let outbox = getOutbox();
  while (outbox.length > 0) {
    const op = outbox[0];
    remapTempId(op, idMap);
    try {
      const result = await sendOp(op);
      if (op.action === "create" && op.targetId < 0 && result && result.id !== undefined) {
        idMap[op.targetId] = result.id;
        remapCacheTempId(op.entity, op.targetId, result.id);
      }
      outbox = outbox.slice(1);
      setOutbox(outbox);
    } catch (err) {
      break; // stuck (offline or server error) — leave the rest queued, retry later
    }
  }
}

let syncInProgress = false;

async function attemptSync() {
  // Runs regardless of whether a server is configured — reminders are a
  // fully local feature and shouldn't depend on sync being set up.
  scheduleUpcomingNotificationsIfEnabled();
  if (syncInProgress || !getServerUrl()) return;
  syncInProgress = true;
  try {
    await drainOutbox();
    if (getOutbox().length === 0) {
      // safe to pull fresh server truth only once nothing local is still pending
      await syncFull();
      refreshAllViews();
    }
  } catch (err) {
    // offline or unreachable — local state stands as-is, we'll retry later
  } finally {
    syncInProgress = false;
    updateSyncStatus();
  }
}

// ---------------------------------------------------------------------------
// Local notifications — class & event reminders, scheduled entirely
// on-device via @capacitor/local-notifications. No server or connectivity
// involved; this only runs when installed as the native Android app.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reminder lead-time editor — one small reusable widget wired up by ID
// prefix, used for the global default (prefix "notif") and per-item
// overrides (prefix "session" / "event"). Each modal gets its own instance
// each time it opens; call .getValues() when saving.
// ---------------------------------------------------------------------------

const LEAD_PRESETS = [5, 15, 30, 60, 1440];

function formatLeadLabel(minutes) {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d before`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h before`;
  return `${minutes}m before`;
}

function createLeadEditor(prefix, initialMinutes) {
  let values = [...new Set(initialMinutes)].sort((a, b) => a - b);

  const chipsEl = document.getElementById(`${prefix}LeadChips`);
  const presetsEl = document.getElementById(`${prefix}LeadPresets`);
  const customValueEl = document.getElementById(`${prefix}LeadCustomValue`);
  const customUnitEl = document.getElementById(`${prefix}LeadCustomUnit`);
  const customAddEl = document.getElementById(`${prefix}LeadCustomAdd`);

  function renderChips() {
    chipsEl.innerHTML = values.length
      ? values
          .map(
            (m) => `
        <span class="lead-chip">
          ${formatLeadLabel(m)}
          <button type="button" class="lead-chip-remove" data-min="${m}" aria-label="Remove">${ICONS.x}</button>
        </span>`
          )
          .join("")
      : `<span class="lead-chips-empty">No reminders</span>`;
    chipsEl.querySelectorAll(".lead-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        values = values.filter((m) => m !== Number(btn.dataset.min));
        renderChips();
        renderPresets();
      });
    });
  }

  function renderPresets() {
    presetsEl.innerHTML = LEAD_PRESETS.map(
      (m) => `<button type="button" class="lead-preset-btn ${values.includes(m) ? "active" : ""}" data-min="${m}">${formatLeadLabel(m)}</button>`
    ).join("");
    presetsEl.querySelectorAll(".lead-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = Number(btn.dataset.min);
        values = values.includes(m) ? values.filter((v) => v !== m) : [...values, m].sort((a, b) => a - b);
        renderChips();
        renderPresets();
      });
    });
  }

  // .onclick (not addEventListener) on purpose: these three inputs are
  // static, persistent DOM elements re-used every time a modal opens, and
  // this factory runs again on every open — addEventListener would stack a
  // new handler on top of the old one each time.
  customAddEl.onclick = () => {
    const raw = Number(customValueEl.value);
    const unit = Number(customUnitEl.value);
    if (!raw || raw <= 0) return;
    const minutes = raw * unit;
    if (!values.includes(minutes)) {
      values = [...values, minutes].sort((a, b) => a - b);
      renderChips();
      renderPresets();
    }
    customValueEl.value = "";
  };

  renderChips();
  renderPresets();

  return { getValues: () => values };
}

// Android notification channels — each controls sound/vibration/urgency for
// notifications posted to it. Files live in
// android/app/src/main/res/raw/ — if you add/rename files there, update
// the "sound" filenames below to match exactly (case-sensitive).
const NOTIF_CHANNELS = [
  { id: "reminders_default", name: "Default", importance: 4, vibration: true },
  { id: "reminders_silent", name: "Silent", importance: 2, vibration: false },
  { id: "reminders_correct_answer", name: "Correct Answer Tone", importance: 4, sound: "mixkit_correct_answer_tone_2870.wav", vibration: true },
  { id: "reminders_dry_pop_up", name: "Dry Pop Up", importance: 4, sound: "mixkit_dry_pop_up_notification_alert_2356.wav", vibration: true },
  { id: "reminders_gaming_lock", name: "Gaming Lock", importance: 4, sound: "mixkit_gaming_lock_2848.wav", vibration: true },
  { id: "reminders_interface_select", name: "Interface Select", importance: 4, sound: "mixkit_interface_option_select_2573.wav", vibration: true },
  { id: "reminders_long_pop", name: "Long Pop", importance: 4, sound: "mixkit_long_pop_2358.wav", vibration: true },
  { id: "reminders_magic_ring", name: "Magic Ring", importance: 5, sound: "mixkit_magic_notification_ring_2344.wav", vibration: true },
  { id: "reminders_sci_fi_confirm", name: "Sci-Fi Confirm", importance: 4, sound: "mixkit_sci_fi_confirmation_914.wav", vibration: true },
  { id: "reminders_interface_back", name: "Interface Back", importance: 4, sound: "mixkit_software_interface_back_2575.wav", vibration: true },
  { id: "reminders_interface_remove", name: "Interface Remove", importance: 4, sound: "mixkit_software_interface_remove_2576.wav", vibration: true },
  { id: "reminders_interface_start", name: "Interface Start", importance: 4, sound: "mixkit_software_interface_start_2574.wav", vibration: true },
];

async function ensureNotifChannels() {
  const plugin = getNotifPlugin();
  if (!plugin) return;
  for (const channel of NOTIF_CHANNELS) {
    try {
      await plugin.createChannel(channel);
    } catch (err) {
      // channel already exists with these settings, or platform doesn't
      // support channels (iOS) — either way, nothing to do
    }
  }
}

function getNotifPlugin() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
}

function isNotifSupported() {
  return !!(
    window.Capacitor &&
    window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform() &&
    getNotifPlugin()
  );
}

function getNotifPrefs() {
  let leadMinutes;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.notifyLead) || "null");
    leadMinutes = Array.isArray(stored) ? stored : null;
  } catch (err) {
    leadMinutes = null;
  }
  if (!leadMinutes) {
    // Migrate from the old single-value format (a plain number string), or
    // fall back to a sensible default.
    const old = Number(localStorage.getItem(STORAGE_KEYS.notifyLead));
    leadMinutes = old > 0 ? [old] : [15];
  }
  return {
    enabled: localStorage.getItem(STORAGE_KEYS.notifyEnabled) === "1",
    leadMinutes,
    sound: localStorage.getItem(STORAGE_KEYS.notifySound) || "reminders_default",
  };
}

function setNotifPrefs(enabled, leadMinutes, sound) {
  localStorage.setItem(STORAGE_KEYS.notifyEnabled, enabled ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.notifyLead, JSON.stringify(leadMinutes));
  if (sound) localStorage.setItem(STORAGE_KEYS.notifySound, sound);
}

async function ensureNotifPermission() {
  const plugin = getNotifPlugin();
  if (!plugin) return false;
  await ensureNotifChannels();
  try {
    const status = await plugin.checkPermissions();
    if (status.display === "granted") return true;
    const req = await plugin.requestPermissions();
    return req.display === "granted";
  } catch (err) {
    return false;
  }
}

async function cancelAllScheduledNotifications() {
  const plugin = getNotifPlugin();
  const ids = JSON.parse(localStorage.getItem(STORAGE_KEYS.notifyIds) || "[]");
  if (plugin && ids.length > 0) {
    try {
      await plugin.cancel({ notifications: ids.map((id) => ({ id })) });
    } catch (err) {
      // best effort — nothing more we can do if this fails
    }
  }
  localStorage.removeItem(STORAGE_KEYS.notifyIds);
  localStorage.removeItem(STORAGE_KEYS.notifyFingerprint);
}

// Deterministic 32-bit positive id from a string, so "this class on this
// date" always maps to the same notification id and gets replaced rather
// than duplicated when rescheduled.
function hashToId(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (Math.abs(hash) % 2000000000) + 1;
}

const NOTIF_WINDOW_DAYS = 7;

function effectiveLeadMinutes(item, defaultLeadMinutes) {
  // reminder_minutes is a JSON-string on the item ("[15,60]"), empty
  // string/null meaning "use the app default" — see main.py/db.py for why
  // it's stored as an opaque string rather than a real array.
  if (item.reminder_minutes) {
    try {
      const custom = JSON.parse(item.reminder_minutes);
      if (Array.isArray(custom)) return custom;
    } catch (err) {
      // malformed — fall through to default
    }
  }
  return defaultLeadMinutes;
}

function computeUpcomingNotifications(cache, prefs) {
  const notifications = [];
  const now = new Date();

  for (let i = 0; i < NOTIF_WINDOW_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = toDateStr(d);

    resolveScheduleForDate(dateStr, cache).forEach((c) => {
      if (c.status === "cancelled" || c.status === "moved_away") return;
      effectiveLeadMinutes(c, prefs.leadMinutes).forEach((leadMinutes) => {
        const at = new Date(`${dateStr}T${c.start_time}:00`);
        at.setMinutes(at.getMinutes() - leadMinutes);
        if (at <= now) return;
        notifications.push({
          id: hashToId(`class-${c.id}-${dateStr}-${leadMinutes}`),
          title: `${c.course} · ${c.type}`,
          body: `${formatTime(c.start_time)}${c.room ? " · " + c.room : ""}`,
          channelId: prefs.sound,
          schedule: { at, allowWhileIdle: true },
        });
      });
    });

    resolveEventsForDate(dateStr, cache).forEach((e) => {
      if (!e.start_time) return;
      effectiveLeadMinutes(e, prefs.leadMinutes).forEach((leadMinutes) => {
        const at = new Date(`${dateStr}T${e.start_time}:00`);
        at.setMinutes(at.getMinutes() - leadMinutes);
        if (at <= now) return;
        notifications.push({
          id: hashToId(`event-${e.id}-${dateStr}-${leadMinutes}`),
          title: e.title,
          body: `${formatTime(e.start_time)}${e.course ? " · " + e.course : ""}`,
          channelId: prefs.sound,
          schedule: { at, allowWhileIdle: true },
        });
      });
    });
  }

  return notifications;
}

async function scheduleUpcomingNotificationsIfEnabled() {
  const prefs = getNotifPrefs();
  if (!prefs.enabled || !isNotifSupported()) return;

  const cache = getCache();
  // Cheap guard: skip the native reschedule call if nothing that affects
  // the schedule OR the reminder settings has changed since we last
  // computed this.
  const fingerprint = JSON.stringify({ cache, prefs });
  if (fingerprint === localStorage.getItem(STORAGE_KEYS.notifyFingerprint)) return;

  const plugin = getNotifPlugin();
  const oldIds = JSON.parse(localStorage.getItem(STORAGE_KEYS.notifyIds) || "[]");
  const notifications = computeUpcomingNotifications(cache, prefs);

  try {
    if (oldIds.length > 0) {
      await plugin.cancel({ notifications: oldIds.map((id) => ({ id })) });
    }
    if (notifications.length > 0) {
      await plugin.schedule({ notifications });
    }
    localStorage.setItem(STORAGE_KEYS.notifyIds, JSON.stringify(notifications.map((n) => n.id)));
    localStorage.setItem(STORAGE_KEYS.notifyFingerprint, fingerprint);
  } catch (err) {
    // permission revoked, plugin not synced, etc. — leave state as-is and
    // retry on the next data change
  }
}

// ---------------------------------------------------------------------------
// Backup & restore — the only safety net for data that otherwise lives
// solely in this device's local storage.
// ---------------------------------------------------------------------------

function buildBackupPayload() {
  const cache = getCache();
  return JSON.stringify(
    {
      format: "mezoschedule-backup",
      version: 1,
      exported_at: new Date().toISOString(),
      sessions: cache.sessions,
      overrides: cache.overrides,
      events: cache.events,
    },
    null,
    2
  );
}

async function exportData() {
  const payload = buildBackupPayload();
  const filename = `schedule-backup-${toDateStr(new Date())}.json`;

  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  const Filesystem = isNative && window.Capacitor.Plugins.Filesystem;
  const Share = isNative && window.Capacitor.Plugins.Share;

  if (Filesystem && Share) {
    // No plugin lets us skip straight to Drive without native code — this
    // is the plain, no-native-code path, so the important part is making
    // sure the person knows what to tap once the sheet opens.
    const proceed = confirm(
      "Next, choose Google Drive from the list — that way you can find and " +
        "restore this backup later from any device, even a new phone."
    );
    if (!proceed) return;
    try {
      const result = await Filesystem.writeFile({
        path: filename,
        data: payload,
        directory: "CACHE",
        encoding: "utf8",
      });
      await Share.share({
        title: "Schedule backup",
        dialogTitle: "Save backup to Google Drive",
        url: result.uri,
      });
      return;
    } catch (err) {
      alert("Couldn't export: " + (err && err.message ? err.message : err));
      return;
    }
  }

  // Browser fallback (e.g. testing via the FastAPI dev server in a desktop browser)
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      alert("That file isn't valid JSON.");
      return;
    }
    if (!data || !Array.isArray(data.sessions) || !Array.isArray(data.overrides) || !Array.isArray(data.events)) {
      alert("That doesn't look like a schedule backup file.");
      return;
    }

    const pending = getOutbox().length;
    const warning = pending > 0
      ? `You have ${pending} unsynced change${pending === 1 ? "" : "s"} that ${pending === 1 ? "hasn't" : "haven't"} reached the server yet — importing will discard them. `
      : "";
    if (!confirm(`${warning}This replaces everything currently on this device with the backup. Continue?`)) {
      return;
    }

    saveCacheOnly({ sessions: data.sessions, overrides: data.overrides, events: data.events });
    setOutbox([]);
    localStorage.removeItem(STORAGE_KEYS.lastSync);

    renderDayTabs();
    refreshAllViews();
    updateSyncStatus();
    scheduleUpcomingNotificationsIfEnabled();
    alert("Import complete.");
  };
  reader.onerror = () => alert("Couldn't read that file.");
  reader.readAsText(file);
}

function refreshAllViews() {
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  if (!document.getElementById("manageView").classList.contains("hidden")) {
    renderSessionList();
    renderManageEventList();
  }
  if (!document.getElementById("activityView").classList.contains("hidden")) {
    renderActivityList();
  }
}

// ---------------------------------------------------------------------------
// Local schedule resolution (mirrors backend/db.py) — works entirely offline
// ---------------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayOfWeekForDate(d) {
  return d.getDay();
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveScheduleForDate(dateStr, cache) {
  const weekday = dayOfWeekForDate(new Date(dateStr + "T00:00:00"));
  const baseSessions = cache.sessions.filter((s) => s.day_of_week === weekday && s.active);
  const overridesToday = cache.overrides.filter((o) => o.original_date === dateStr);
  const overrideBySession = {};
  overridesToday.forEach((o) => { overrideBySession[o.session_id] = o; });
  const movedIn = cache.overrides.filter((o) => o.new_date === dateStr && o.status === "rescheduled");

  const result = [];

  baseSessions.forEach((s) => {
    const ov = overrideBySession[s.id];
    if (ov && ov.status === "cancelled") {
      result.push({ ...s, status: "cancelled", note: ov.note });
    } else if (ov && ov.status === "rescheduled" && ov.new_date && ov.new_date !== dateStr) {
      result.push({ ...s, status: "moved_away", moved_to: ov.new_date, note: ov.note });
    } else if (ov && ov.status === "rescheduled") {
      result.push({
        ...s,
        status: "rescheduled",
        start_time: ov.new_start_time || s.start_time,
        end_time: ov.new_end_time || s.end_time,
        room: ov.new_room || s.room,
        note: ov.note,
      });
    } else {
      result.push({ ...s, status: "normal", note: null });
    }
  });

  movedIn.forEach((o) => {
    const original = cache.sessions.find((s) => s.id === o.session_id);
    if (!original) return;
    result.push({
      ...original,
      status: "moved_in",
      start_time: o.new_start_time || original.start_time,
      end_time: o.new_end_time || original.end_time,
      room: o.new_room || original.room,
      note: o.note,
    });
  });

  result.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return result;
}

// ---------------------------------------------------------------------------
// Rendering — Schedule view
// ---------------------------------------------------------------------------

let selectedDate = toDateStr(new Date());
let weekOffset = 0;

function getWeekStart(offset) {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - dayOfWeekForDate(today) + offset * 7);
  start.setHours(0, 0, 0, 0);
  return start;
}

function updateWeekLabel(startOfWeek) {
  const end = new Date(startOfWeek);
  end.setDate(startOfWeek.getDate() + 6);
  const opts = { month: "short", day: "numeric" };
  const label = `${startOfWeek.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
  document.getElementById("weekLabel").textContent = label;
  document.getElementById("todayJumpBtn").classList.toggle("hidden", weekOffset === 0);
}

function renderDayTabs() {
  const container = document.getElementById("dayTabs");
  container.innerHTML = "";
  const today = new Date();
  const startOfWeek = getWeekStart(weekOffset);
  updateWeekLabel(startOfWeek);

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    const dStr = toDateStr(d);
    const btn = document.createElement("button");
    btn.className = "day-tab";
    if (dStr === toDateStr(today)) btn.classList.add("today");
    if (dStr === selectedDate) btn.classList.add("selected");
    btn.innerHTML = `${DAY_NAMES[i]}<br>${d.getDate()}`;
    btn.addEventListener("click", () => {
      selectedDate = dStr;
      renderDayTabs();
      renderClassList();
      renderEventList();
    });
    container.appendChild(btn);
  }
}

function shiftWeek(delta) {
  const oldStart = getWeekStart(weekOffset);
  const selDate = new Date(selectedDate + "T00:00:00");
  const weekdayIndex = Math.round((selDate - oldStart) / 86400000);
  weekOffset += delta;
  const newStart = getWeekStart(weekOffset);
  const newSelected = new Date(newStart);
  newSelected.setDate(newStart.getDate() + weekdayIndex);
  selectedDate = toDateStr(newSelected);
  renderDayTabs();
  renderClassList();
  renderEventList();
}

function goToToday() {
  weekOffset = 0;
  selectedDate = toDateStr(new Date());
  renderDayTabs();
  renderClassList();
  renderEventList();
}

function jumpToDate(dateStr) {
  const target = new Date(dateStr + "T00:00:00");
  const currentWeekStart = getWeekStart(0);
  const diffDays = Math.round((target - currentWeekStart) / 86400000);
  weekOffset = Math.floor(diffDays / 7);
  selectedDate = dateStr;
  switchView("schedule");
  renderDayTabs();
  renderClassList();
  renderEventList();
}

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function renderWelcomeCard() {
  const card = document.getElementById("welcomeCard");
  const cache = getCache();
  const hasData = cache.sessions.length > 0 || cache.events.length > 0;
  const dismissed = localStorage.getItem(STORAGE_KEYS.welcomeDismissed) === "1";
  card.classList.toggle("hidden", hasData || dismissed);
}

function classStatusInfo(c) {
  let statusText = "";
  let statusTone = "tone-dim";
  if (c.status === "cancelled") { statusText = "Cancelled" + (c.note ? ` — ${escapeHtml(c.note)}` : ""); statusTone = "tone-red"; }
  if (c.status === "rescheduled") { statusText = "Time/room changed" + (c.note ? ` — ${escapeHtml(c.note)}` : ""); statusTone = "tone-amber"; }
  if (c.status === "moved_away") { statusText = `Moved to ${escapeHtml(c.moved_to)}` + (c.note ? ` — ${escapeHtml(c.note)}` : ""); statusTone = "tone-dim"; }
  if (c.status === "moved_in") { statusText = "Moved from another day" + (c.note ? ` — ${escapeHtml(c.note)}` : ""); statusTone = "tone-amber"; }
  return { statusText, statusTone };
}

function renderClassList() {
  renderWelcomeCard();
  const container = document.getElementById("classList");
  const cache = getCache();
  const classes = resolveScheduleForDate(selectedDate, cache);

  if (classes.length === 0) {
    const isToday = selectedDate === toDateStr(new Date());
    container.innerHTML = `<p class="empty-state">No classes ${isToday ? "today" : "this day"}.</p>`;
    return;
  }

  container.innerHTML = "";
  classes.forEach((c) => {
    const card = document.createElement("div");
    card.className = `class-card ${c.status}`;
    card.addEventListener("click", () => openActionModal(c));

    const courseClass = c.status === "cancelled" ? "class-course cancelled-text" : "class-course";
    const { statusText, statusTone } = classStatusInfo(c);

    card.innerHTML = `
      <div class="card-top-row">
        <span class="class-time">${formatTime(c.start_time)} – ${formatTime(c.end_time)}</span>
        <span class="card-top-tags">
          ${c.section ? `<span class="section-tag">${escapeHtml(c.section)}</span>` : ""}
          <span class="id-tag ${escapeHtml(c.type)}">${escapeHtml(c.type)}</span>
        </span>
      </div>
      <div class="${courseClass}">${escapeHtml(c.course)}</div>
      <div class="class-meta">
        ${c.room ? `<span>${ICONS.pin} ${escapeHtml(c.room)}</span>` : ""}
        ${c.instructor_name ? `<span>${escapeHtml(c.instructor_name)}</span>` : ""}
      </div>
      ${c.instructor_email ? `<div class="class-meta"><a href="mailto:${escapeHtml(c.instructor_email)}">${escapeHtml(c.instructor_email)}</a></div>` : ""}
      ${statusText ? `<div class="status-note"><span class="status-pill ${statusTone}"><span class="dot"></span>${statusText}</span></div>` : ""}
      <div class="class-meta" style="margin-top:8px;color:var(--text-faint);font-size:11px">Tap to cancel, reschedule, or edit</div>
    `;
    container.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Events (exams, deadlines, personal one-offs)
// ---------------------------------------------------------------------------

function daysUntil(dateStr) {
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  return Math.round((target - todayMidnight) / 86400000);
}

function urgencyTier(days) {
  if (days < 0) return "past";
  if (days <= 2) return "urgent";
  if (days <= 7) return "soon";
  return "far";
}
function urgencyClass(days) {
  const tier = urgencyTier(days);
  if (tier === "urgent") return "urgency-urgent";
  if (tier === "soon") return "urgency-soon";
  return "urgency-far";
}
function urgencyColorVar(days) {
  const tier = urgencyTier(days);
  if (tier === "urgent") return "red";
  if (tier === "soon") return "amber";
  return "blue";
}
function urgencyTone(days) {
  const tier = urgencyTier(days);
  if (tier === "urgent") return "tone-red";
  if (tier === "soon") return "tone-amber";
  return "tone-blue";
}
function daysLabel(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days < 0) return `${Math.abs(days)}d ago`;
  return `${days}d`;
}

function resolveEventsForDate(dateStr, cache) {
  return cache.events.filter((e) => e.date === dateStr).sort((a, b) => a.start_time.localeCompare(b.start_time));
}

function renderUpcomingExamCard() {
  const cache = getCache();
  const card = document.getElementById("upcomingExamCard");
  const upcoming = cache.events
    .filter((e) => e.category === "exam" && daysUntil(e.date) >= 0)
    .sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));

  if (upcoming.length === 0) {
    card.classList.add("hidden");
    return;
  }

  const next = upcoming[0];
  const days = daysUntil(next.date);
  card.classList.remove("hidden");
  card.className = `stat-card ${urgencyClass(days)}`;
  document.getElementById("upcomingExamDays").innerHTML =
    days === 0 ? "Today" : `${days}<span class="unit">day${days === 1 ? "" : "s"}</span>`;
  const dateLabel = new Date(next.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  let sub = `${next.title} · ${dateLabel}, ${formatTime(next.start_time)}`;
  if (upcoming.length > 1) sub += ` · +${upcoming.length - 1} more`;
  document.getElementById("upcomingExamSub").textContent = sub;
}

function renderEventList() {
  const container = document.getElementById("eventList");
  const cache = getCache();
  const events = resolveEventsForDate(selectedDate, cache);

  if (events.length === 0) {
    container.innerHTML = `<p class="empty-state">No events this day.</p>`;
    return;
  }

  container.innerHTML = "";
  events.forEach((e) => {
    const days = daysUntil(e.date);
    const card = document.createElement("div");
    card.className = `event-card category-${e.category}`;
    if (e.category === "exam") card.style.setProperty("--stat-accent", `var(--${urgencyColorVar(days)})`);
    card.addEventListener("click", () => openEventModal(e));

    card.innerHTML = `
      <div class="card-top-row">
        <span class="class-time">${formatTime(e.start_time)}${e.end_time ? " – " + formatTime(e.end_time) : ""}</span>
        <span class="id-tag ${escapeHtml(e.category)}">${escapeHtml(e.category)}</span>
      </div>
      <div class="class-course">${escapeHtml(e.title)}</div>
      <div class="class-meta">
        ${e.course ? `<span>${escapeHtml(e.course)}</span>` : ""}
        ${e.category === "exam" ? `<span class="status-pill ${urgencyTone(days)}"><span class="dot"></span>${daysLabel(days)}</span>` : ""}
      </div>
      ${e.note ? `<div class="class-meta"><span>${escapeHtml(e.note)}</span></div>` : ""}
    `;
    container.appendChild(card);
  });
}

function renderManageEventList() {
  const container = document.getElementById("manageEventList");
  const cache = getCache();
  const sorted = [...cache.events].sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));

  if (sorted.length === 0) {
    container.innerHTML = `<p class="empty-state">No events added yet.</p>`;
    return;
  }

  container.innerHTML = "";
  sorted.forEach((e) => {
    const dateLabel = new Date(e.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const row = document.createElement("div");
    row.className = "session-row";
    row.innerHTML = `
      <div class="session-info">
        <div class="course">${escapeHtml(e.title)} · ${escapeHtml(e.category)}</div>
        <div class="meta">${dateLabel} · ${formatTime(e.start_time)}</div>
      </div>
      <span class="id-tag ${escapeHtml(e.category)}">${escapeHtml(e.category)}</span>
    `;
    row.addEventListener("click", () => openEventModal(e));
    container.appendChild(row);
  });
}

function saveEventFromModal() {
  const id = document.getElementById("eventIdInput").value;
  const payload = {
    title: document.getElementById("eventTitleInput").value.trim(),
    category: document.getElementById("eventCategoryInput").value,
    date: document.getElementById("eventDateInput").value,
    start_time: document.getElementById("eventStartTimeInput").value,
    end_time: document.getElementById("eventEndTimeInput").value || null,
    course: document.getElementById("eventCourseInput").value.trim(),
    note: document.getElementById("eventNoteInput").value.trim(),
    reminder_minutes:
      document.getElementById("eventCustomNotifToggle").classList.contains("on") && eventLeadEditorInstance
        ? JSON.stringify(eventLeadEditorInstance.getValues())
        : "",
  };
  if (!payload.title || !payload.date || !payload.start_time) {
    alert("Title, date, and start time are required.");
    return;
  }
  if (id) {
    applyLocalUpdate("event", Number(id), payload);
    queueOp("event", "update", Number(id), payload);
  } else {
    payload.source = "app";
    const tempId = applyLocalCreate("event", payload);
    queueOp("event", "create", tempId, payload);
  }
  closeEventModal();
  renderManageEventList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function deleteEventFromModal() {
  const id = document.getElementById("eventIdInput").value;
  if (!id || !confirm("Delete this event permanently?")) return;
  applyLocalDelete("event", Number(id));
  queueOp("event", "delete", Number(id));
  closeEventModal();
  renderManageEventList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

let eventLeadEditorInstance = null;

function openEventModal(event) {
  document.getElementById("eventModalTitle").textContent = event ? "Edit Event" : "Add Event";
  document.getElementById("eventIdInput").value = event ? event.id : "";
  document.getElementById("eventTitleInput").value = event ? event.title : "";
  document.getElementById("eventCategoryInput").value = event ? event.category : "exam";
  document.getElementById("eventDateInput").value = event ? event.date : selectedDate;
  document.getElementById("eventStartTimeInput").value = event ? event.start_time : "";
  document.getElementById("eventEndTimeInput").value = event ? event.end_time || "" : "";
  document.getElementById("eventCourseInput").value = event ? event.course || "" : "";
  document.getElementById("eventNoteInput").value = event ? event.note || "" : "";
  document.getElementById("deleteEventBtn").classList.toggle("hidden", !event);

  const hasCustomReminders = !!(event && event.reminder_minutes);
  document.getElementById("eventCustomNotifToggle").classList.toggle("on", hasCustomReminders);
  document.getElementById("eventLeadEditor").classList.toggle("hidden", !hasCustomReminders);
  let initialLead = getNotifPrefs().leadMinutes;
  if (hasCustomReminders) {
    try {
      initialLead = JSON.parse(event.reminder_minutes);
    } catch (err) {
      // malformed — fall back to the default set above
    }
  }
  eventLeadEditorInstance = createLeadEditor("event", initialLead);

  document.getElementById("eventModal").classList.remove("hidden");
}
function closeEventModal() {
  document.getElementById("eventModal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Class actions modal — in-app cancel / reschedule / undo / edit recurring
// ---------------------------------------------------------------------------

let actionContext = null;

function openActionModal(c) {
  const cache = getCache();
  const existing = cache.overrides.find(
    (o) => o.session_id === c.id && (o.original_date === selectedDate || (o.status === "rescheduled" && o.new_date === selectedDate))
  );
  actionContext = { sessionId: c.id, date: selectedDate, existingOverrideId: existing ? existing.id : null };

  document.getElementById("actionModalTime").textContent = `${formatTime(c.start_time)} – ${formatTime(c.end_time)}`;
  const sectionTag = document.getElementById("actionModalSection");
  sectionTag.textContent = c.section || "";
  sectionTag.classList.toggle("hidden", !c.section);
  const typeTag = document.getElementById("actionModalType");
  typeTag.textContent = c.type;
  typeTag.className = `id-tag ${c.type}`;
  document.getElementById("actionModalTitle").textContent = c.course;

  const metaParts = [];
  if (c.room) metaParts.push(`${ICONS.pin} ${escapeHtml(c.room)}`);
  if (c.instructor_name) metaParts.push(escapeHtml(c.instructor_name));
  document.getElementById("actionModalMeta").innerHTML = metaParts.map((p) => `<span>${p}</span>`).join("");

  const statusWrap = document.getElementById("actionModalStatusWrap");
  const { statusText, statusTone } = classStatusInfo(c);
  statusWrap.innerHTML = statusText
    ? `<div class="status-note"><span class="status-pill ${statusTone}"><span class="dot"></span>${statusText}</span></div>`
    : "";

  const weekday = DAY_NAMES_FULL[dayOfWeekForDate(new Date(selectedDate + "T00:00:00"))];
  document.getElementById("actionModalSubtitle").textContent = `${weekday}, ${selectedDate}`;

  document.getElementById("actionUndoBtn").classList.toggle("hidden", !existing);
  document.getElementById("actionCancelDayBtn").classList.toggle("hidden", !!existing);
  document.getElementById("actionRescheduleBtn").classList.toggle("hidden", !!existing);
  document.getElementById("rescheduleForm").classList.add("hidden");
  document.getElementById("actionButtons").classList.remove("hidden");
  document.getElementById("actionModal").classList.remove("hidden");
}
function closeActionModal() {
  document.getElementById("actionModal").classList.add("hidden");
  actionContext = null;
}

function actionCancelDay() {
  if (!actionContext) return;
  const payload = { session_id: actionContext.sessionId, original_date: actionContext.date, status: "cancelled", source: "app" };
  const tempId = applyLocalCreate("override", payload);
  queueOp("override", "create", tempId, payload);
  closeActionModal();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function actionShowRescheduleForm() {
  if (!actionContext) return;
  const cache = getCache();
  const session = cache.sessions.find((s) => s.id === actionContext.sessionId);
  document.getElementById("actionNewDateInput").value = actionContext.date;
  document.getElementById("actionNewStartInput").value = session ? session.start_time : "";
  document.getElementById("actionNewEndInput").value = session ? session.end_time : "";
  document.getElementById("actionNewRoomInput").value = session ? session.room || "" : "";
  document.getElementById("actionNoteInput").value = "";
  document.getElementById("actionButtons").classList.add("hidden");
  document.getElementById("rescheduleForm").classList.remove("hidden");
}
function actionBackToButtons() {
  document.getElementById("rescheduleForm").classList.add("hidden");
  document.getElementById("actionButtons").classList.remove("hidden");
}

function actionSaveReschedule() {
  if (!actionContext) return;
  const newDate = document.getElementById("actionNewDateInput").value;
  const payload = {
    session_id: actionContext.sessionId,
    original_date: actionContext.date,
    status: "rescheduled",
    new_date: newDate && newDate !== actionContext.date ? newDate : null,
    new_start_time: document.getElementById("actionNewStartInput").value,
    new_end_time: document.getElementById("actionNewEndInput").value,
    new_room: document.getElementById("actionNewRoomInput").value.trim(),
    note: document.getElementById("actionNoteInput").value.trim(),
    source: "app",
  };
  const tempId = applyLocalCreate("override", payload);
  queueOp("override", "create", tempId, payload);
  closeActionModal();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function actionUndo() {
  if (!actionContext || !actionContext.existingOverrideId) return;
  applyLocalDelete("override", actionContext.existingOverrideId);
  queueOp("override", "delete", actionContext.existingOverrideId);
  closeActionModal();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function actionEditRecurring() {
  if (!actionContext) return;
  const cache = getCache();
  const session = cache.sessions.find((s) => s.id === actionContext.sessionId);
  closeActionModal();
  if (session) openSessionModal(session);
}

// ---------------------------------------------------------------------------
// Recent Activity — overrides + events merged by recency, agent changes tagged
// ---------------------------------------------------------------------------

function relativeTime(iso) {
  if (!iso) return "";
  // updated_at is stored as a naive UTC isoformat string from Python — append
  // "Z" so JS parses it as UTC instead of assuming local time.
  const diffMs = Date.now() - new Date(iso + "Z").getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function renderActivityList() {
  const container = document.getElementById("activityList");
  const cache = getCache();
  const items = [];

  cache.overrides.forEach((o) => {
    const session = cache.sessions.find((s) => s.id === o.session_id);
    const courseName = escapeHtml(session ? session.course : "Unknown class");
    let desc;
    if (o.status === "cancelled") {
      desc = `${courseName} cancelled — ${o.original_date}`;
    } else if (o.new_date && o.new_date !== o.original_date) {
      desc = `${courseName} moved to ${o.new_date} — was ${o.original_date}`;
    } else {
      desc = `${courseName} time/room changed — ${o.original_date}`;
    }
    items.push({ kind: "override", desc, note: o.note, source: o.source, updated_at: o.updated_at, raw: o });
  });

  cache.events.forEach((e) => {
    items.push({
      kind: "event",
      desc: `${escapeHtml(e.title)} added — ${e.date}`,
      note: e.note,
      source: e.source,
      updated_at: e.updated_at,
      raw: e,
    });
  });

  items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const top = items.slice(0, 30);

  if (top.length === 0) {
    container.innerHTML = `<p class="empty-state">No activity yet.</p>`;
    return;
  }

  container.innerHTML = "";
  top.forEach((item) => {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.innerHTML = `
      <div class="activity-main">
        ${item.source === "agent" ? `<span class="agent-tag">agent</span>` : ""}
        <div>
          <div class="activity-desc">${item.desc}</div>
          ${item.note ? `<div class="activity-note">${escapeHtml(item.note)}</div>` : ""}
        </div>
      </div>
      <div class="activity-time">${relativeTime(item.updated_at)}</div>
    `;
    row.addEventListener("click", () => {
      if (item.kind === "override") {
        jumpToDate(item.raw.original_date);
      } else {
        openEventModal(item.raw);
      }
    });
    container.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Manage view — classes
// ---------------------------------------------------------------------------

const TYPE_ORDER = { lecture: 0, tutorial: 1, lab: 2 };

function getExpandedCourseGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.expandedGroups) || "[]"));
  } catch (err) {
    return new Set();
  }
}

function setExpandedCourseGroups(set) {
  localStorage.setItem(STORAGE_KEYS.expandedGroups, JSON.stringify([...set]));
}

function renderSessionRow(s, extraClass) {
  const row = document.createElement("div");
  row.className = `session-row ${s.active ? "" : "inactive"} ${extraClass || ""}`.trim();
  row.innerHTML = `
    <div class="session-info">
      <div class="course-row">
        <span class="course">${escapeHtml(s.course)}</span>
        ${s.section ? `<span class="section-tag">${escapeHtml(s.section)}</span>` : ""}
        <span class="id-tag ${escapeHtml(s.type)}">${escapeHtml(s.type)}</span>
      </div>
      <div class="meta">${DAY_NAMES_FULL[s.day_of_week]} ${formatTime(s.start_time)}–${formatTime(s.end_time)}${s.room ? " · " + escapeHtml(s.room) : ""}</div>
    </div>
    <button class="toggle ${s.active ? "on" : ""}" aria-label="Toggle active"></button>
  `;
  row.querySelector(".session-info").addEventListener("click", () => openSessionModal(s));
  row.querySelector(".toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSessionActive(s);
  });
  return row;
}

function renderSessionList() {
  const container = document.getElementById("sessionList");
  const cache = getCache();

  if (cache.sessions.length === 0) {
    container.innerHTML = `<p class="empty-state">No classes added yet.</p>`;
    return;
  }

  // Same course, different session types (lecture/tutorial/lab), get grouped
  // into one folder-style row so a long list of near-duplicate course names
  // collapses down to one line each. A course with only one session type
  // just renders as a normal row — no point wrapping a single item.
  const groups = new Map();
  cache.sessions.forEach((s) => {
    const key = s.course.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });

  const entries = [...groups.values()].sort((a, b) => a[0].course.localeCompare(b[0].course));
  const expanded = getExpandedCourseGroups();

  container.innerHTML = "";
  entries.forEach((sessions) => {
    if (sessions.length === 1) {
      container.appendChild(renderSessionRow(sessions[0]));
      return;
    }

    const sorted = [...sessions].sort(
      (a, b) => (TYPE_ORDER[a.type] ?? 3) - (TYPE_ORDER[b.type] ?? 3) || a.day_of_week - b.day_of_week
    );
    const key = sorted[0].course.trim().toLowerCase();
    const isOpen = expanded.has(key);
    const typesLabel = sorted.map((s) => s.type[0].toUpperCase() + s.type.slice(1)).join(", ");

    const group = document.createElement("div");
    group.className = `course-group ${isOpen ? "expanded" : ""}`;

    const header = document.createElement("div");
    header.className = "course-group-header";
    header.innerHTML = `
      <span class="course-group-chevron">${ICONS.chevron}</span>
      <span class="course-group-icon">${ICONS.folder}</span>
      <div class="course-group-label">
        <div class="course-group-title">${escapeHtml(sorted[0].course)}</div>
        <div class="course-group-caption">${sorted.length} classes · ${escapeHtml(typesLabel)}</div>
      </div>
    `;
    header.addEventListener("click", () => {
      const nowExpanded = getExpandedCourseGroups();
      if (nowExpanded.has(key)) nowExpanded.delete(key);
      else nowExpanded.add(key);
      setExpandedCourseGroups(nowExpanded);
      renderSessionList();
    });

    const children = document.createElement("div");
    children.className = `course-group-children ${isOpen ? "" : "hidden"}`;
    sorted.forEach((s) => children.appendChild(renderSessionRow(s, "child-row")));

    group.appendChild(header);
    group.appendChild(children);
    container.appendChild(group);
  });
}

function toggleSessionActive(session) {
  applyLocalUpdate("session", session.id, { active: !session.active });
  queueOp("session", "update", session.id, { active: !session.active });
  renderSessionList();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function updateSyncStatus() {
  const el = document.getElementById("syncStatus");

  // Nothing is actually "pending" in a meaningful sense if there's no
  // server to sync to — don't show an alarmed amber state for something
  // the user never asked to sync.
  if (!getServerUrl()) {
    el.style.color = "";
    el.textContent = "offline";
    return;
  }

  const pending = getOutbox().length;
  const last = getLastSync();
  let text;
  if (!last) {
    text = "not synced";
  } else {
    const mins = Math.round((Date.now() - new Date(last).getTime()) / 60000);
    text = mins < 1 ? "synced just now" : `synced ${mins}m ago`;
  }
  if (pending > 0) {
    text = `${pending} pending · ${text}`;
    el.style.color = "var(--amber)";
  } else {
    el.style.color = "";
  }
  el.textContent = text;
}

let notifLeadEditorInstance = null;

function openSettingsModal() {
  document.getElementById("serverUrlInput").value = getServerUrl();
  document.getElementById("apiKeyInput").value = getApiKey();

  const prefs = getNotifPrefs();
  document.getElementById("notifToggle").classList.toggle("on", prefs.enabled);
  const soundSelect = document.getElementById("notifSoundInput");
  soundSelect.innerHTML = NOTIF_CHANNELS.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  soundSelect.value = prefs.sound;
  notifLeadEditorInstance = createLeadEditor("notif", prefs.leadMinutes);

  const notifRow = document.getElementById("notifSettingsRow");
  const notifSupported = isNotifSupported();
  document.getElementById("notifToggle").disabled = !notifSupported;
  document.getElementById("notifSoundInput").disabled = !notifSupported;
  notifRow.classList.toggle("disabled", !notifSupported);
  document.getElementById("notifHint").textContent = notifSupported
    ? ""
    : "Only available in the installed Android app.";

  document.getElementById("settingsModal").classList.remove("hidden");
}
function closeSettingsModal() {
  document.getElementById("settingsModal").classList.add("hidden");
}

let sessionLeadEditorInstance = null;

function openSessionModal(session) {
  document.getElementById("sessionModalTitle").textContent = session ? "Edit Class" : "Add Class";
  document.getElementById("sessionIdInput").value = session ? session.id : "";
  document.getElementById("courseInput").value = session ? session.course : "";
  document.getElementById("typeInput").value = session ? session.type : "lecture";
  document.getElementById("sectionInput").value = session ? session.section || "" : "";
  document.getElementById("dayInput").value = session ? session.day_of_week : "1";
  document.getElementById("startTimeInput").value = session ? session.start_time : "";
  document.getElementById("endTimeInput").value = session ? session.end_time : "";
  document.getElementById("roomInput").value = session ? session.room || "" : "";
  document.getElementById("instructorNameInput").value = session ? session.instructor_name || "" : "";
  document.getElementById("instructorEmailInput").value = session ? session.instructor_email || "" : "";
  document.getElementById("deleteSessionBtn").classList.toggle("hidden", !session);

  const hasCustomReminders = !!(session && session.reminder_minutes);
  document.getElementById("sessionCustomNotifToggle").classList.toggle("on", hasCustomReminders);
  document.getElementById("sessionLeadEditor").classList.toggle("hidden", !hasCustomReminders);
  let initialLead = getNotifPrefs().leadMinutes;
  if (hasCustomReminders) {
    try {
      initialLead = JSON.parse(session.reminder_minutes);
    } catch (err) {
      // malformed — fall back to the default set above
    }
  }
  sessionLeadEditorInstance = createLeadEditor("session", initialLead);

  document.getElementById("sessionModal").classList.remove("hidden");
}
function closeSessionModal() {
  document.getElementById("sessionModal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Modal dismissal — tapping outside a modal, or the Android hardware/gesture
// back button, should close it, same as hitting Close/Cancel/×.
// ---------------------------------------------------------------------------

function setupBackdropDismiss(modalId, closeFn) {
  const modal = document.getElementById(modalId);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeFn();
  });
}

// Returns true if it handled something (closed a modal / stepped back a
// sub-view), so the caller knows whether to fall through to app-exit.
function closeAnyOpenModal() {
  const actionModal = document.getElementById("actionModal");
  const rescheduleForm = document.getElementById("rescheduleForm");
  if (!actionModal.classList.contains("hidden") && !rescheduleForm.classList.contains("hidden")) {
    // Mid-reschedule-form: step back to the action list first, same as the
    // Back button, rather than closing everything in one go.
    rescheduleForm.classList.add("hidden");
    document.getElementById("actionButtons").classList.remove("hidden");
    return true;
  }

  const modals = [
    ["settingsModal", closeSettingsModal],
    ["sessionModal", closeSessionModal],
    ["eventModal", closeEventModal],
    ["actionModal", closeActionModal],
  ];
  for (const [id, closeFn] of modals) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains("hidden")) {
      closeFn();
      return true;
    }
  }
  return false;
}

function setupBackButtonHandler() {
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
  const AppPlugin = isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!AppPlugin) return; // web/dev preview — browser back behaves normally

  AppPlugin.addListener("backButton", () => {
    if (closeAnyOpenModal()) return;
    if (document.getElementById("scheduleView").classList.contains("hidden")) {
      switchView("schedule");
    } else {
      AppPlugin.exitApp();
    }
  });
}

function saveSessionFromModal() {
  const id = document.getElementById("sessionIdInput").value;
  const payload = {
    course: document.getElementById("courseInput").value.trim(),
    type: document.getElementById("typeInput").value,
    section: document.getElementById("sectionInput").value.trim(),
    day_of_week: Number(document.getElementById("dayInput").value),
    start_time: document.getElementById("startTimeInput").value,
    end_time: document.getElementById("endTimeInput").value,
    room: document.getElementById("roomInput").value.trim(),
    instructor_name: document.getElementById("instructorNameInput").value.trim(),
    instructor_email: document.getElementById("instructorEmailInput").value.trim(),
    reminder_minutes:
      document.getElementById("sessionCustomNotifToggle").classList.contains("on") && sessionLeadEditorInstance
        ? JSON.stringify(sessionLeadEditorInstance.getValues())
        : "",
  };
  if (!payload.course || !payload.start_time || !payload.end_time) {
    alert("Course, start time, and end time are required.");
    return;
  }
  if (id) {
    applyLocalUpdate("session", Number(id), payload);
    queueOp("session", "update", Number(id), payload);
  } else {
    payload.active = true;
    const tempId = applyLocalCreate("session", payload);
    queueOp("session", "create", tempId, payload);
  }
  closeSessionModal();
  renderSessionList();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

function deleteSessionFromModal() {
  const id = document.getElementById("sessionIdInput").value;
  if (!id || !confirm("Delete this class permanently?")) return;
  applyLocalDelete("session", Number(id));
  queueOp("session", "delete", Number(id));
  closeSessionModal();
  renderSessionList();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();
  attemptSync();
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function switchView(view) {
  document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.getElementById("scheduleView").classList.toggle("hidden", view !== "schedule");
  document.getElementById("manageView").classList.toggle("hidden", view !== "manage");
  document.getElementById("activityView").classList.toggle("hidden", view !== "activity");
  if (view === "manage") {
    renderSessionList();
    renderManageEventList();
  }
  if (view === "activity") {
    renderActivityList();
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  initTheme();
  if (isNotifSupported()) ensureNotifChannels();

  renderDayTabs();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();

  // The app is fully usable with zero setup. Only reach out to a server if
  // one has already been configured — first launch never blocks on this.
  if (getServerUrl()) {
    await attemptSync();
    renderDayTabs();
  } else {
    scheduleUpcomingNotificationsIfEnabled();
  }

  document.getElementById("settingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("settingsCancelBtn").addEventListener("click", closeSettingsModal);

  setupBackdropDismiss("settingsModal", closeSettingsModal);
  setupBackdropDismiss("sessionModal", closeSessionModal);
  setupBackdropDismiss("eventModal", closeEventModal);
  setupBackdropDismiss("actionModal", closeActionModal);
  setupBackButtonHandler();
  document.getElementById("notifToggle").addEventListener("click", () => {
    document.getElementById("notifToggle").classList.toggle("on");
  });
  document.getElementById("sessionCustomNotifToggle").addEventListener("click", () => {
    const toggle = document.getElementById("sessionCustomNotifToggle");
    toggle.classList.toggle("on");
    document.getElementById("sessionLeadEditor").classList.toggle("hidden", !toggle.classList.contains("on"));
  });
  document.getElementById("eventCustomNotifToggle").addEventListener("click", () => {
    const toggle = document.getElementById("eventCustomNotifToggle");
    toggle.classList.toggle("on");
    document.getElementById("eventLeadEditor").classList.toggle("hidden", !toggle.classList.contains("on"));
  });
  document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
    const url = document.getElementById("serverUrlInput").value.trim();
    const key = document.getElementById("apiKeyInput").value.trim();

    const notifEnabled = document.getElementById("notifToggle").classList.contains("on");
    const notifLead = notifLeadEditorInstance ? notifLeadEditorInstance.getValues() : [15];
    const notifSound = document.getElementById("notifSoundInput").value;
    setNotifPrefs(notifEnabled, notifLead, notifSound);
    if (notifEnabled) {
      const granted = await ensureNotifPermission();
      if (!granted) {
        setNotifPrefs(false, notifLead, notifSound);
        document.getElementById("notifToggle").classList.remove("on");
        alert("Reminders need notification permission — allow it in Android Settings to turn this on.");
      }
    } else {
      await cancelAllScheduledNotifications();
    }

    // Empty URL means "offline only" — clear any previous server config
    // rather than blocking the save.
    saveSettings(url, url ? key : "");
    closeSettingsModal();
    if (url) {
      await attemptSync();
    } else {
      scheduleUpcomingNotificationsIfEnabled();
    }
  });

  document.getElementById("welcomeDismissBtn").addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEYS.welcomeDismissed, "1");
    renderWelcomeCard();
  });
  document.getElementById("welcomeAddClassBtn").addEventListener("click", () => {
    switchView("manage");
    openSessionModal(null);
  });

  document.getElementById("exportDataBtn").addEventListener("click", exportData);
  document.getElementById("importDataBtn").addEventListener("click", () => {
    document.getElementById("importFileInput").click();
  });
  document.getElementById("importFileInput").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importData(file);
    e.target.value = "";
  });

  document.querySelectorAll(".view-tab").forEach((t) => {
    t.addEventListener("click", () => switchView(t.dataset.view));
  });

  document.getElementById("addSessionBtn").addEventListener("click", () => openSessionModal(null));
  document.getElementById("sessionCancelBtn").addEventListener("click", closeSessionModal);
  document.getElementById("sessionSaveBtn").addEventListener("click", saveSessionFromModal);
  document.getElementById("deleteSessionBtn").addEventListener("click", deleteSessionFromModal);

  document.getElementById("addEventBtn").addEventListener("click", () => openEventModal(null));
  document.getElementById("eventCancelBtn").addEventListener("click", closeEventModal);
  document.getElementById("eventSaveBtn").addEventListener("click", saveEventFromModal);
  document.getElementById("deleteEventBtn").addEventListener("click", deleteEventFromModal);

  document.getElementById("actionCancelDayBtn").addEventListener("click", actionCancelDay);
  document.getElementById("actionRescheduleBtn").addEventListener("click", actionShowRescheduleForm);
  document.getElementById("actionUndoBtn").addEventListener("click", actionUndo);
  document.getElementById("actionEditRecurringBtn").addEventListener("click", actionEditRecurring);
  document.getElementById("rescheduleBackBtn").addEventListener("click", actionBackToButtons);
  document.getElementById("rescheduleSaveBtn").addEventListener("click", actionSaveReschedule);
  document.getElementById("actionCloseBtn").addEventListener("click", closeActionModal);

  document.getElementById("refreshBtn").addEventListener("click", attemptSync);
  document.getElementById("syncStatus").addEventListener("click", attemptSync);

  document.getElementById("prevWeekBtn").addEventListener("click", () => shiftWeek(-1));
  document.getElementById("nextWeekBtn").addEventListener("click", () => shiftWeek(1));
  document.getElementById("todayJumpBtn").addEventListener("click", goToToday);

  // Sync on resume, on reconnect, and every ~30s while the app is open.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") attemptSync();
  });
  window.addEventListener("online", attemptSync);
  window.addEventListener("focus", attemptSync);
  setInterval(() => {
    if (document.visibilityState === "visible") attemptSync();
  }, 30000);

  // Keep the "Xm ago" text fresh even with no new sync.
  setInterval(updateSyncStatus, 30000);
}

document.addEventListener("DOMContentLoaded", init);