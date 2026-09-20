"""
FastAPI backend for the college schedule app.

Run: uvicorn main:app --host 0.0.0.0 --port 8000
Requires env var SCHEDULE_API_KEY to be set (see README).
"""

import os
from datetime import date
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import db

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
API_KEY = os.environ.get("SCHEDULE_API_KEY", "changeme")

app = FastAPI(title="College Schedule API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


@app.on_event("startup")
def startup():
    db.init_db()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SessionIn(BaseModel):
    course: str
    type: str  # lecture / tutorial / lab
    day_of_week: int  # 0=Sunday .. 6=Saturday
    start_time: str  # 'HH:MM'
    end_time: str
    section: Optional[str] = None
    room: Optional[str] = None
    instructor_name: Optional[str] = None
    instructor_email: Optional[str] = None
    active: Optional[bool] = True
    # JSON-encoded array of custom reminder lead times in minutes, e.g.
    # "[15,60]". null/omitted means "use the app's default reminder
    # settings" rather than "no reminders" — the client tells the
    # difference, this field is just an opaque string to the backend.
    reminder_minutes: Optional[str] = None


class SessionUpdate(BaseModel):
    course: Optional[str] = None
    type: Optional[str] = None
    day_of_week: Optional[int] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    section: Optional[str] = None
    room: Optional[str] = None
    instructor_name: Optional[str] = None
    instructor_email: Optional[str] = None
    active: Optional[bool] = None
    reminder_minutes: Optional[str] = None


class OverrideIn(BaseModel):
    session_id: int
    original_date: str  # 'YYYY-MM-DD'
    status: str  # 'cancelled' or 'rescheduled'
    new_date: Optional[str] = None
    new_start_time: Optional[str] = None
    new_end_time: Optional[str] = None
    new_room: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = "app"  # 'app' or 'agent'


class OverrideUpdate(BaseModel):
    status: Optional[str] = None
    new_date: Optional[str] = None
    new_start_time: Optional[str] = None
    new_end_time: Optional[str] = None
    new_room: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = None


class EventIn(BaseModel):
    title: str
    date: str  # 'YYYY-MM-DD'
    start_time: str  # 'HH:MM'
    end_time: Optional[str] = None
    category: Optional[str] = "personal"  # exam / personal / deadline / other
    course: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = "app"  # 'app' or 'agent'
    reminder_minutes: Optional[str] = None  # see SessionIn — JSON string or ""


class EventUpdate(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    category: Optional[str] = None
    course: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = None
    reminder_minutes: Optional[str] = None


# ---------------------------------------------------------------------------
# Health (unprotected — handy for tunnel/uptime checks)
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Schedule (resolved views)
# ---------------------------------------------------------------------------

@app.get("/api/schedule/today", dependencies=[Depends(require_api_key)])
def schedule_today():
    today = date.today().isoformat()
    return {
        "date": today,
        "classes": db.get_schedule_for_date(today),
        "events": db.get_events_for_date(today),
    }


@app.get("/api/schedule/day/{date_str}", dependencies=[Depends(require_api_key)])
def schedule_for_day(date_str: str):
    return {
        "date": date_str,
        "classes": db.get_schedule_for_date(date_str),
        "events": db.get_events_for_date(date_str),
    }


@app.get("/api/schedule/week", dependencies=[Depends(require_api_key)])
def schedule_week(start: Optional[str] = None):
    start_date = start or date.today().isoformat()
    return db.get_schedule_for_range(start_date, days=7)


@app.get("/api/schedule/full", dependencies=[Depends(require_api_key)])
def schedule_full():
    """Full dump of sessions + overrides — the app uses this for offline caching."""
    return db.get_full_export()


# ---------------------------------------------------------------------------
# Sessions CRUD
# ---------------------------------------------------------------------------

@app.get("/api/sessions", dependencies=[Depends(require_api_key)])
def sessions_list():
    return db.list_sessions()


@app.get("/api/sessions/{session_id}", dependencies=[Depends(require_api_key)])
def sessions_get(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.post("/api/sessions", dependencies=[Depends(require_api_key)])
def sessions_create(payload: SessionIn):
    return db.create_session(payload.model_dump())


@app.put("/api/sessions/{session_id}", dependencies=[Depends(require_api_key)])
def sessions_update(session_id: int, payload: SessionUpdate):
    updated = db.update_session(session_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return updated


@app.delete("/api/sessions/{session_id}", dependencies=[Depends(require_api_key)])
def sessions_delete(session_id: int):
    db.delete_session(session_id)
    return {"deleted": session_id}


# ---------------------------------------------------------------------------
# Overrides CRUD
# This is what your LangChain agent calls when it spots a cancellation or
# reschedule in your college email.
# ---------------------------------------------------------------------------

@app.get("/api/overrides", dependencies=[Depends(require_api_key)])
def overrides_list():
    return db.list_overrides()


@app.post("/api/overrides", dependencies=[Depends(require_api_key)])
def overrides_create(payload: OverrideIn):
    return db.create_override(payload.model_dump())


@app.put("/api/overrides/{override_id}", dependencies=[Depends(require_api_key)])
def overrides_update(override_id: int, payload: OverrideUpdate):
    updated = db.update_override(override_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise HTTPException(status_code=404, detail="Override not found")
    return updated


@app.delete("/api/overrides/{override_id}", dependencies=[Depends(require_api_key)])
def overrides_delete(override_id: int):
    db.delete_override(override_id)
    return {"deleted": override_id}


# ---------------------------------------------------------------------------
# Events CRUD
# One-off items independent of the weekly grid: exams, deadlines, personal
# reminders. Your agent can also POST here for a college exam it spots in
# an email, using category="exam".
# ---------------------------------------------------------------------------

@app.get("/api/events", dependencies=[Depends(require_api_key)])
def events_list():
    return db.list_events()


@app.post("/api/events", dependencies=[Depends(require_api_key)])
def events_create(payload: EventIn):
    return db.create_event(payload.model_dump())


@app.put("/api/events/{event_id}", dependencies=[Depends(require_api_key)])
def events_update(event_id: int, payload: EventUpdate):
    updated = db.update_event(event_id, payload.model_dump(exclude_unset=True))
    if not updated:
        raise HTTPException(status_code=404, detail="Event not found")
    return updated


@app.delete("/api/events/{event_id}", dependencies=[Depends(require_api_key)])
def events_delete(event_id: int):
    db.delete_event(event_id)
    return {"deleted": event_id}


# ---------------------------------------------------------------------------
# Serve the frontend — handy for testing in a desktop browser during dev.
# The Android app itself doesn't use this; Capacitor bundles www/ directly
# into the app.
# ---------------------------------------------------------------------------

if os.path.isdir("www"):
    app.mount("/", StaticFiles(directory="www", html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8002)