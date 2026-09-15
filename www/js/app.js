// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
  serverUrl: "schedule_server_url",
  apiKey: "schedule_api_key",
  cachedFull: "schedule_cached_full",
  lastSync: "schedule_last_sync",
  outbox: "schedule_outbox",
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

function renderClassList() {
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
    let statusText = "";
    let statusTone = "tone-dim";
    if (c.status === "cancelled") { statusText = "Cancelled" + (c.note ? ` — ${c.note}` : ""); statusTone = "tone-red"; }
    if (c.status === "rescheduled") { statusText = "Time/room changed" + (c.note ? ` — ${c.note}` : ""); statusTone = "tone-amber"; }
    if (c.status === "moved_away") { statusText = `Moved to ${c.moved_to}` + (c.note ? ` — ${c.note}` : ""); statusTone = "tone-dim"; }
    if (c.status === "moved_in") { statusText = "Moved from another day" + (c.note ? ` — ${c.note}` : ""); statusTone = "tone-amber"; }

    card.innerHTML = `
      <div class="card-top-row">
        <span class="class-time">${formatTime(c.start_time)} – ${formatTime(c.end_time)}</span>
        <span class="id-tag ${c.type}">${c.type}</span>
      </div>
      <div class="${courseClass}">${c.course}</div>
      <div class="class-meta">
        ${c.room ? `<span>📍 ${c.room}</span>` : ""}
        ${c.instructor_name ? `<span>${c.instructor_name}</span>` : ""}
      </div>
      ${c.instructor_email ? `<div class="class-meta"><a href="mailto:${c.instructor_email}">${c.instructor_email}</a></div>` : ""}
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
        <span class="id-tag ${e.category}">${e.category}</span>
      </div>
      <div class="class-course">${e.title}</div>
      <div class="class-meta">
        ${e.course ? `<span>${e.course}</span>` : ""}
        ${e.category === "exam" ? `<span class="status-pill ${urgencyTone(days)}"><span class="dot"></span>${daysLabel(days)}</span>` : ""}
      </div>
      ${e.note ? `<div class="class-meta"><span>${e.note}</span></div>` : ""}
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
        <div class="course">${e.title} · ${e.category}</div>
        <div class="meta">${dateLabel} · ${formatTime(e.start_time)}</div>
      </div>
      <span class="id-tag ${e.category}">${e.category}</span>
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

  document.getElementById("actionModalTitle").textContent = c.course;
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
    const courseName = session ? session.course : "Unknown class";
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
      desc: `${e.title} added — ${e.date}`,
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
          ${item.note ? `<div class="activity-note">${item.note}</div>` : ""}
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

function renderSessionList() {
  const container = document.getElementById("sessionList");
  const cache = getCache();
  const sorted = [...cache.sessions].sort(
    (a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)
  );

  if (sorted.length === 0) {
    container.innerHTML = `<p class="empty-state">No classes added yet.</p>`;
    return;
  }

  container.innerHTML = "";
  sorted.forEach((s) => {
    const row = document.createElement("div");
    row.className = `session-row ${s.active ? "" : "inactive"}`;
    row.innerHTML = `
      <div class="session-info">
        <div class="course">${s.course} · ${s.type}</div>
        <div class="meta">${DAY_NAMES_FULL[s.day_of_week]} ${formatTime(s.start_time)}–${formatTime(s.end_time)}${s.room ? " · " + s.room : ""}</div>
      </div>
      <button class="toggle ${s.active ? "on" : ""}" aria-label="Toggle active"></button>
    `;
    row.querySelector(".session-info").addEventListener("click", () => openSessionModal(s));
    row.querySelector(".toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSessionActive(s);
    });
    container.appendChild(row);
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

function openSettingsModal() {
  document.getElementById("serverUrlInput").value = getServerUrl();
  document.getElementById("apiKeyInput").value = getApiKey();
  document.getElementById("settingsModal").classList.remove("hidden");
}
function closeSettingsModal() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function openSessionModal(session) {
  document.getElementById("sessionModalTitle").textContent = session ? "Edit Class" : "Add Class";
  document.getElementById("sessionIdInput").value = session ? session.id : "";
  document.getElementById("courseInput").value = session ? session.course : "";
  document.getElementById("typeInput").value = session ? session.type : "lecture";
  document.getElementById("dayInput").value = session ? session.day_of_week : "1";
  document.getElementById("startTimeInput").value = session ? session.start_time : "";
  document.getElementById("endTimeInput").value = session ? session.end_time : "";
  document.getElementById("roomInput").value = session ? session.room || "" : "";
  document.getElementById("instructorNameInput").value = session ? session.instructor_name || "" : "";
  document.getElementById("instructorEmailInput").value = session ? session.instructor_email || "" : "";
  document.getElementById("deleteSessionBtn").classList.toggle("hidden", !session);
  document.getElementById("sessionModal").classList.remove("hidden");
}
function closeSessionModal() {
  document.getElementById("sessionModal").classList.add("hidden");
}

function saveSessionFromModal() {
  const id = document.getElementById("sessionIdInput").value;
  const payload = {
    course: document.getElementById("courseInput").value.trim(),
    type: document.getElementById("typeInput").value,
    day_of_week: Number(document.getElementById("dayInput").value),
    start_time: document.getElementById("startTimeInput").value,
    end_time: document.getElementById("endTimeInput").value,
    room: document.getElementById("roomInput").value.trim(),
    instructor_name: document.getElementById("instructorNameInput").value.trim(),
    instructor_email: document.getElementById("instructorEmailInput").value.trim(),
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
  renderDayTabs();
  renderClassList();
  renderEventList();
  renderUpcomingExamCard();
  updateSyncStatus();

  if (!getServerUrl()) {
    openSettingsModal();
  } else {
    await attemptSync();
    renderDayTabs();
  }

  document.getElementById("settingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("settingsCancelBtn").addEventListener("click", closeSettingsModal);
  document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
    const url = document.getElementById("serverUrlInput").value.trim();
    const key = document.getElementById("apiKeyInput").value.trim();
    if (!url) { alert("Server URL is required."); return; }
    saveSettings(url, key);
    closeSettingsModal();
    await attemptSync();
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