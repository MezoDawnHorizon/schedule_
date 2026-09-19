# Schedule_

An offline first class schedule app for Android. It works fully standalone —
no account, no server, no internet connection required — with an optional
self-hosted backend if you want your schedule to sync across devices.

Vanilla HTML/CSS/JS frontend packaged via [Capacitor](https://capacitorjs.com/),
with an optional FastAPI + SQLite backend for sync.

## Features

- Weekly recurring class schedule (lectures, tutorials, labs)
- Cancel or reschedule a single occurrence without touching the recurring class
- Exams, deadlines, and personal events, separate from the weekly grid
- An upcoming-exam banner that shifts blue → amber → red as the date gets closer
- Full offline support — every read and write works with no connection
- Optional sync to a self-hosted backend across multiple devices

## How it works

The schedule is built from three kinds of records:

- **Sessions** — your recurring weekly classes. Each is tied to a day of
  the week, not a date range, since term boundaries vary. When a class is
  done for the term, deactivate it instead of deleting it — deactivated
  sessions keep their history but stop appearing on the schedule.
- **Overrides** — a one-off change to a specific date: a class cancelled,
  or rescheduled to a new time, room, or day.
- **Events** — one-off items independent of the weekly grid: exams,
  deadlines, personal reminders. Events appear in an "Events" section
  below the day's classes.

## In-app controls

- **Schedule tab** — tap a class to cancel it for the day, reschedule it,
  undo an existing change, or jump to editing the recurring class. Use the
  `‹` / `›` arrows to browse other weeks; a "Today" button appears once
  you've navigated away from the current week.
- **Manage tab** — add, edit, or deactivate classes and events.
- **Activity tab** — every override and event, newest first. Tap an entry
  to jump to that date or open it for editing.

## Offline-first sync

The app never waits on a network request. Every action applies to a local
cache immediately and re-renders right away, regardless of connectivity.

If you connect a backend, edits are also queued in a local outbox, which
drains to the server — in order, resolving any offline-created temporary
IDs to real server IDs as they land:

- on app open or resume from background
- roughly every 30 seconds while the app is open
- when the device regains connectivity
- when you tap the refresh (⟳) button or the sync status text

The sync status text shows pending writes, e.g. `"2 pending · synced 4m
ago"`, turning amber whenever something local hasn't reached the server
yet. If anything is still pending, the app won't pull fresh server data
that round — pulling first could silently overwrite an unsynced local
change.

If you never configure a backend, none of this applies — the app just
runs entirely on-device, permanently. The Server Settings screen on first
launch can be skipped.

## Getting started

```bash
npm install
npx cap add android      # one-time
npx cap sync android      # after any change to www/ or capacitor.config.json
npx cap open android      # opens Android Studio to build/run
```

No backend setup is required to use the app — skip the Server Settings
screen on first launch and it works immediately, fully offline.

## Optional: self-hosted backend

Run this if you want your schedule to sync across devices.

```bash
cd college-schedule
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

echo "SCHEDULE_API_KEY=pick-a-long-random-string" > .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

**Bind to `0.0.0.0`, not the uvicorn default of `127.0.0.1`.** A
`127.0.0.1` bind only accepts connections from the machine it's running
on — an Android emulator can still reach it, but a physical phone on the
same network can't.

For access from outside your local network, put a tunnel (reverse proxy,
Cloudflare Tunnel, ngrok, etc.) in front of `localhost:8000`, and use
HTTPS — the API key travels as a plain header, so it should only go over
an encrypted connection.

Data lives in `schedule.db` (SQLite), created automatically next to
`main.py` on first run. Open `http://localhost:8000` in a desktop browser
to use the UI without touching Android — FastAPI serves `www/` directly
in dev.

### Connecting the app to your server

Open the ⚙ Settings screen in the app and enter:

- **Server URL** — your server's address (e.g. `https://your-tunnel.example.com`)
- **API Key** — the same value as `SCHEDULE_API_KEY`

Both are stored on-device and editable later from the same screen.

## API reference

Only relevant if you're running the backend. Every endpoint requires the
header `X-API-Key: <your key>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/schedule/full` | Full sessions + overrides + events dump — what the app uses to cache for offline use |
| GET | `/api/schedule/today` | Resolved classes + events for today |
| GET | `/api/schedule/day/{date}` | Resolved classes + events for one date (`YYYY-MM-DD`) |
| GET | `/api/schedule/week?start=YYYY-MM-DD` | Resolved classes for 7 days from `start` |
| GET, POST | `/api/sessions` | List / create recurring classes |
| PUT, DELETE | `/api/sessions/{id}` | Edit a class, or set `active: false` when it's done for the term |
| GET, POST | `/api/overrides` | List / create one-off changes |
| PUT, DELETE | `/api/overrides/{id}` | Edit or remove an override |
| GET, POST | `/api/events` | List / create exams, deadlines, personal events |
| PUT, DELETE | `/api/events/{id}` | Edit or remove an event |

## Tech stack

- **Frontend:** HTML, CSS, vanilla JavaScript
- **Mobile packaging:** Capacitor (Android)
- **Backend (optional):** FastAPI, SQLite
- **Storage:** localStorage cache on-device, SQLite on the server