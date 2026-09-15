# College Schedule (MezoSchedule)

A personal, offline-first schedule app. FastAPI backend + vanilla HTML/CSS/JS
frontend, packaged as an Android app via Capacitor.

## How it works

- **`sessions`** = your recurring weekly classes (lecture/tutorial/lab). Each
  has an `active` flag — flip it off once a lab/tutorial finishes for the
  term instead of deleting it (flip it back on if you're wrong). Nothing is
  tied to a date range, since term timing isn't fixed.
- **`overrides`** = a one-off change to a specific date: cancelled, or
  rescheduled (new time/room, optionally a different day entirely). You or
  your agent set these explicitly — nothing is guessed.
- **`events`** = one-off items independent of the weekly grid: exams,
  deadlines, personal reminders. Each has a category (`exam`, `personal`,
  `deadline`, `other`). Events show in their own "Events" section below the
  classes for the selected day. The nearest upcoming exam also gets a
  banner card at the top of the Schedule tab, which shifts blue → amber →
  red as the date gets closer (7 days / 2 days thresholds).
- **`source`** on both `overrides` and `events` — `"app"` (default) or
  `"agent"`. Purely informational: it just lets the Activity tab show a
  small "agent" tag so you can tell your own changes apart from your
  LangChain agent's. Your agent should set `"source": "agent"` explicitly
  on every write it makes; anything that omits it defaults to `"app"`.

## In-app controls

You don't need the API for day-to-day changes anymore:

- **Schedule tab** — tap any class to Cancel This Day, Reschedule This Day,
  Undo an existing change, or jump to Edit Recurring Class. Use the `‹`/`›`
  arrows above the day tabs to browse other weeks; a "Today" button appears
  whenever you've navigated away from the current week.
- **Manage tab** — add/edit/deactivate classes and events directly.
- **Activity tab** — every override and event, newest first, with a small
  "agent" tag on anything your agent created. Tap an override to jump to
  that date, tap an event to edit it.

## Offline-first sync

Every action (cancel a class, add an event, edit a session) applies to the
on-device cache immediately and re-renders right away, regardless of
connectivity. It's also queued in a local "outbox." The app drains that
outbox — in order, resolving any temporary offline-created IDs to real
server IDs as they resolve — whenever it can reach the server:

- on app open or resume from background
- every ~30 seconds while the app is open
- when the device regains connectivity
- when you tap the refresh (⟳) button or the sync status text

The sync status text shows pending writes, e.g. `"2 pending · synced 4m
ago"`, turning amber whenever something local hasn't reached the server yet.
If there's anything still pending, the app won't pull fresh server data that
round — pulling first could silently overwrite an unsynced local change.

## Backend setup

```bash
cd college-schedule
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

echo "SCHEDULE_API_KEY=pick-a-long-random-string" > .env   # same key the app + agent will use
uvicorn main:app --host 0.0.0.0 --port 8000
```

**Important:** bind to `0.0.0.0`, not the uvicorn default of `127.0.0.1` — a
`127.0.0.1` bind only accepts connections from the machine it's running on,
which is why an Android emulator (routes through the host's own loopback)
can reach it but a physical phone on the same wifi can't.

Point your tunnel at `localhost:8000`. Data lives in `schedule.db` (SQLite),
created automatically next to `main.py` on first run.

Open `http://localhost:8000` in a desktop browser any time to test the UI
without touching Android — FastAPI serves `www/` directly for dev.

### Migrating an existing database

If you already have a `schedule.db` from before the `source` column existed,
`init_db()` won't retrofit it onto existing tables. Run this once:

```bash
sqlite3 schedule.db "ALTER TABLE overrides ADD COLUMN source TEXT NOT NULL DEFAULT 'app'; ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'app';"
```

Or, if you don't care about existing test data, just delete `schedule.db`
and let it recreate fresh on next startup.

## Android app (Capacitor)

```bash
npm install
npx cap add android      # one-time
npx cap sync android      # after any change to www/ or capacitor.config.json
npx cap open android      # opens Android Studio to build/run
```

On first launch the app asks for:
- **Server URL** — your tunnel URL (e.g. `https://your-tunnel.example.com`)
- **API Key** — same value as `SCHEDULE_API_KEY`

Both are stored on-device and editable later from the ⚙ button.

## API reference

Every endpoint requires header `X-API-Key: <your key>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/schedule/full` | Full sessions + overrides + events dump (what the app uses to cache for offline use) |
| GET | `/api/schedule/today` | Resolved classes + events for today |
| GET | `/api/schedule/day/{date}` | Resolved classes + events for one date (`YYYY-MM-DD`) |
| GET | `/api/schedule/week?start=YYYY-MM-DD` | Resolved classes for 7 days from `start` |
| GET | `/api/sessions/{id}` | Fetch one recurring class by ID; used by the agent to resolve an original date before creating an override |
| GET, POST | `/api/sessions` | List / create recurring classes |
| PUT, DELETE | `/api/sessions/{id}` | Edit a class, or set `active: false` when it's done for the term |
| GET, POST | `/api/overrides` | List / create one-off changes |
| PUT, DELETE | `/api/overrides/{id}` | Edit or remove an override |
| GET, POST | `/api/events` | List / create exams, deadlines, personal events |
| PUT, DELETE | `/api/events/{id}` | Edit or remove an event |

### Agent override workflow

When the agent needs to cancel or reschedule a recurring class, it must first resolve the actual calendar date for that class before posting an override. The flow is:

1. `GET /api/schedule/full` to inspect session IDs and weekly metadata
2. `GET /api/sessions/{id}` to fetch the session's `day_of_week` and metadata
3. `resolve_session_dates(session_id, count)` to calculate the real upcoming dates from the current week
4. `POST /api/overrides` with the chosen `original_date` and `status`

This avoids guessing the date from the weekly schedule and is the key requirement for correct override creation.

`day_of_week` convention: `0=Sunday, 1=Monday, 2=Tuesday, ... 6=Saturday`.

### Example: agent sees a cancellation email

```
POST /api/overrides
X-API-Key: your-key
Content-Type: application/json

{
  "session_id": 3,
  "original_date": "2026-09-10",
  "status": "cancelled",
  "note": "Prof. email: no lecture today",
  "source": "agent"
}
```

### Example: agent sees a lab moved to a different day

```
POST /api/overrides
X-API-Key: your-key
Content-Type: application/json

{
  "session_id": 7,
  "original_date": "2026-09-14",
  "status": "rescheduled",
  "new_date": "2026-09-16",
  "new_start_time": "14:30",
  "new_end_time": "16:29",
  "new_room": "D301",
  "note": "Moved to make up for public holiday",
  "source": "agent"
}
```

The app shows the class as "moved" on the original date and as a normal
(highlighted) class on the new date — nothing extra needed.

### Example: agent spots a midterm date in an email

```
POST /api/events
X-API-Key: your-key
Content-Type: application/json

{
  "title": "MATH113 Midterm",
  "date": "2026-10-14",
  "start_time": "10:00",
  "end_time": "12:00",
  "category": "exam",
  "course": "MATH113",
  "note": "Covers chapters 1-4",
  "source": "agent"
}
```

Every one of these examples will also show up in the app's Activity tab,
tagged "agent," within the next sync (on open, on resume, every ~30s, or a
manual refresh tap).

## Notes

- Notifications: your LangChain agent sends a Telegram message when it makes
  a change. The app itself doesn't do push notifications — decided against
  it for now since Telegram already covers it and it avoids the added
  complexity/fragility of a native notifications plugin.
- No database migrations tooling — it's one small SQLite file. If you ever
  need to change the schema by hand, edit `backend/db.py`'s `init_db()` and
  either delete `schedule.db` to start fresh or write a manual `ALTER TABLE`
  (see the migration note above for an example).