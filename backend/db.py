"""
SQLite data layer for the college schedule app.
One file, no ORM — plain sqlite3 with small helper functions.

Convention: day_of_week is 0=Sunday, 1=Monday, ... 6=Saturday
(matches the SU-SA layout of most college timetables).
"""

import os
import sqlite3
from datetime import datetime, timedelta

DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schedule.db"
)


def weekday_for_date(date_str: str) -> int:
    """Convert 'YYYY-MM-DD' to our 0=Sunday..6=Saturday convention."""
    d = datetime.strptime(date_str, "%Y-%m-%d").date()
    python_weekday = d.weekday()  # Mon=0 ... Sun=6
    return (python_weekday + 1) % 7


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_connection()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            course TEXT NOT NULL,
            type TEXT NOT NULL,              -- lecture / tutorial / lab
            day_of_week INTEGER NOT NULL,    -- 0=Sunday .. 6=Saturday
            start_time TEXT NOT NULL,        -- 'HH:MM' 24h
            end_time TEXT NOT NULL,
            section TEXT,                    -- e.g. 'Section 3' / 'B02' — which of a professor's sections
            room TEXT,
            instructor_name TEXT,
            instructor_email TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            original_date TEXT NOT NULL,     -- 'YYYY-MM-DD' — date being overridden
            status TEXT NOT NULL,            -- 'cancelled' or 'rescheduled'
            new_date TEXT,                   -- set only if moved to a different day
            new_start_time TEXT,
            new_end_time TEXT,
            new_room TEXT,
            note TEXT,
            source TEXT NOT NULL DEFAULT 'app',  -- 'app' or 'agent' — who made this change
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            date TEXT NOT NULL,              -- 'YYYY-MM-DD'
            start_time TEXT NOT NULL,        -- 'HH:MM'
            end_time TEXT,                   -- optional
            category TEXT NOT NULL DEFAULT 'personal',  -- exam / personal / deadline / other
            course TEXT,                     -- optional free-text link, e.g. 'MATH113'
            note TEXT,
            source TEXT NOT NULL DEFAULT 'app',  -- 'app' or 'agent' — who made this change
            updated_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def _now():
    return datetime.utcnow().isoformat()


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def list_sessions(include_inactive: bool = True):
    conn = get_connection()
    if include_inactive:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY day_of_week, start_time"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE active=1 ORDER BY day_of_week, start_time"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_session(session_id: int):
    conn = get_connection()
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_session(data: dict):
    conn = get_connection()
    cur = conn.execute(
        """
        INSERT INTO sessions (course, type, day_of_week, start_time, end_time, section, room,
                               instructor_name, instructor_email, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["course"],
            data["type"],
            data["day_of_week"],
            data["start_time"],
            data["end_time"],
            data.get("section"),
            data.get("room"),
            data.get("instructor_name"),
            data.get("instructor_email"),
            int(data.get("active", 1)),
            _now(),
        ),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return get_session(new_id)


def update_session(session_id: int, data: dict):
    existing = get_session(session_id)
    if not existing:
        return None
    merged = {**existing, **{k: v for k, v in data.items() if v is not None}}
    conn = get_connection()
    conn.execute(
        """
        UPDATE sessions SET course=?, type=?, day_of_week=?, start_time=?, end_time=?,
                             section=?, room=?, instructor_name=?, instructor_email=?, active=?,
                             updated_at=?
        WHERE id=?
        """,
        (
            merged["course"],
            merged["type"],
            merged["day_of_week"],
            merged["start_time"],
            merged["end_time"],
            merged["section"],
            merged["room"],
            merged["instructor_name"],
            merged["instructor_email"],
            int(merged["active"]),
            _now(),
            session_id,
        ),
    )
    conn.commit()
    conn.close()
    return get_session(session_id)


def delete_session(session_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Overrides
# ---------------------------------------------------------------------------

def list_overrides():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM overrides ORDER BY original_date").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_override(override_id: int):
    conn = get_connection()
    row = conn.execute("SELECT * FROM overrides WHERE id=?", (override_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_override(data: dict):
    conn = get_connection()
    cur = conn.execute(
        """
        INSERT INTO overrides (session_id, original_date, status, new_date,
                                new_start_time, new_end_time, new_room, note, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["session_id"],
            data["original_date"],
            data["status"],
            data.get("new_date"),
            data.get("new_start_time"),
            data.get("new_end_time"),
            data.get("new_room"),
            data.get("note"),
            data.get("source", "app"),
            _now(),
        ),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return get_override(new_id)


def update_override(override_id: int, data: dict):
    existing = get_override(override_id)
    if not existing:
        return None
    merged = {**existing, **{k: v for k, v in data.items() if v is not None}}
    conn = get_connection()
    conn.execute(
        """
        UPDATE overrides SET session_id=?, original_date=?, status=?, new_date=?,
                              new_start_time=?, new_end_time=?, new_room=?, note=?,
                              source=?, updated_at=?
        WHERE id=?
        """,
        (
            merged["session_id"],
            merged["original_date"],
            merged["status"],
            merged["new_date"],
            merged["new_start_time"],
            merged["new_end_time"],
            merged["new_room"],
            merged["note"],
            merged["source"],
            _now(),
            override_id,
        ),
    )
    conn.commit()
    conn.close()
    return get_override(override_id)


def delete_override(override_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM overrides WHERE id=?", (override_id,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Events (exams, deadlines, personal one-offs — independent of the weekly grid)
# ---------------------------------------------------------------------------

def list_events():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM events ORDER BY date, start_time").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_event(event_id: int):
    conn = get_connection()
    row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_events_for_date(date_str: str):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM events WHERE date=? ORDER BY start_time", (date_str,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_event(data: dict):
    conn = get_connection()
    cur = conn.execute(
        """
        INSERT INTO events (title, date, start_time, end_time, category, course, note, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["title"],
            data["date"],
            data["start_time"],
            data.get("end_time"),
            data.get("category", "personal"),
            data.get("course"),
            data.get("note"),
            data.get("source", "app"),
            _now(),
        ),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return get_event(new_id)


def update_event(event_id: int, data: dict):
    existing = get_event(event_id)
    if not existing:
        return None
    merged = {**existing, **{k: v for k, v in data.items() if v is not None}}
    conn = get_connection()
    conn.execute(
        """
        UPDATE events SET title=?, date=?, start_time=?, end_time=?, category=?,
                           course=?, note=?, source=?, updated_at=?
        WHERE id=?
        """,
        (
            merged["title"],
            merged["date"],
            merged["start_time"],
            merged["end_time"],
            merged["category"],
            merged["course"],
            merged["note"],
            merged["source"],
            _now(),
            event_id,
        ),
    )
    conn.commit()
    conn.close()
    return get_event(event_id)


def delete_event(event_id: int):
    conn = get_connection()
    conn.execute("DELETE FROM events WHERE id=?", (event_id,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Resolved schedule (sessions + overrides merged)
# ---------------------------------------------------------------------------

def get_schedule_for_date(date_str: str):
    """Resolved list of classes for one date: active recurring sessions for
    that weekday, with cancellations/reschedules applied, plus any sessions
    moved IN from a different day."""
    weekday = weekday_for_date(date_str)
    conn = get_connection()

    base_sessions = conn.execute(
        "SELECT * FROM sessions WHERE day_of_week=? AND active=1", (weekday,)
    ).fetchall()

    overrides_today = conn.execute(
        "SELECT * FROM overrides WHERE original_date=?", (date_str,)
    ).fetchall()
    overrides_by_session = {o["session_id"]: dict(o) for o in overrides_today}

    moved_in = conn.execute(
        "SELECT * FROM overrides WHERE new_date=? AND status='rescheduled'",
        (date_str,),
    ).fetchall()

    conn.close()

    result = []

    for row in base_sessions:
        s = dict(row)
        ov = overrides_by_session.get(s["id"])
        if ov and ov["status"] == "cancelled":
            result.append({**s, "status": "cancelled", "note": ov.get("note")})
        elif ov and ov["status"] == "rescheduled" and ov.get("new_date") and ov["new_date"] != date_str:
            # moved away to a different date — don't show it as happening today
            result.append({**s, "status": "moved_away", "moved_to": ov["new_date"], "note": ov.get("note")})
        elif ov and ov["status"] == "rescheduled":
            # same-day time/room change
            result.append(
                {
                    **s,
                    "status": "rescheduled",
                    "start_time": ov.get("new_start_time") or s["start_time"],
                    "end_time": ov.get("new_end_time") or s["end_time"],
                    "room": ov.get("new_room") or s["room"],
                    "note": ov.get("note"),
                }
            )
        else:
            result.append({**s, "status": "normal", "note": None})

    for row in moved_in:
        o = dict(row)
        original = get_session(o["session_id"])
        if not original:
            continue
        result.append(
            {
                **original,
                "status": "moved_in",
                "start_time": o.get("new_start_time") or original["start_time"],
                "end_time": o.get("new_end_time") or original["end_time"],
                "room": o.get("new_room") or original["room"],
                "note": o.get("note"),
            }
        )

    result.sort(key=lambda c: c["start_time"])
    return result


def get_schedule_for_range(start_date: str, days: int = 7):
    """dict of date -> resolved schedule for `days` consecutive days."""
    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    output = {}
    for i in range(days):
        d_str = (start + timedelta(days=i)).isoformat()
        output[d_str] = get_schedule_for_date(d_str)
    return output


def get_full_export():
    """Full sessions + overrides dump, used by the client for offline caching."""
    conn = get_connection()
    sessions = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM sessions ORDER BY day_of_week, start_time"
        ).fetchall()
    ]
    overrides = [
        dict(r)
        for r in conn.execute("SELECT * FROM overrides ORDER BY original_date").fetchall()
    ]
    events = [
        dict(r)
        for r in conn.execute("SELECT * FROM events ORDER BY date, start_time").fetchall()
    ]
    conn.close()
    return {
        "sessions": sessions,
        "overrides": overrides,
        "events": events,
        "server_time": _now(),
    }