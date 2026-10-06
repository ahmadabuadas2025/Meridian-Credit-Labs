"""JSON persistence.

  data/applications.json  - each application record, written ONCE at submission
  data/audit_log.jsonl    - append-only event log; every state change is a new line
  data/outbox.jsonl       - mock notifications (written by notify.py)

Current status is derived from the record plus its events, so nothing is ever
overwritten. A single lock keeps the threaded web server safe.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .models import AuditEvent


class Store:
    def __init__(self, data_dir: str | os.PathLike):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.apps_path = self.data_dir / "applications.json"
        self.audit_path = self.data_dir / "audit_log.jsonl"
        self.outbox_path = self.data_dir / "outbox.jsonl"
        self.lock = threading.RLock()

    # --- applications (insert-once) -------------------------------------------------
    def _load_apps(self) -> dict[str, dict]:
        if not self.apps_path.exists():
            return {}
        with open(self.apps_path, encoding="utf-8") as f:
            return json.load(f)

    def next_id(self) -> str:
        with self.lock:
            return f"MCL-{1001 + len(self._load_apps())}"

    def save_application(self, record: dict) -> None:
        with self.lock:
            apps = self._load_apps()
            if record["id"] in apps:
                raise ValueError(f"Application {record['id']} already exists; records are write-once.")
            apps[record["id"]] = record
            tmp = self.apps_path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(apps, f, indent=2)
            os.replace(tmp, self.apps_path)

    def get_application(self, app_id: str) -> dict | None:
        with self.lock:
            return self._load_apps().get(app_id)

    def list_applications(self) -> list[dict]:
        with self.lock:
            return list(self._load_apps().values())

    # --- append-only logs -------------------------------------------------------------
    def append_jsonl(self, path: Path, obj: dict) -> None:
        with self.lock, open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj) + "\n")

    def read_jsonl(self, path: Path) -> list[dict]:
        with self.lock:
            if not path.exists():
                return []
            with open(path, encoding="utf-8") as f:
                return [json.loads(line) for line in f if line.strip()]

    def append_event(self, event: AuditEvent) -> dict:
        data = event.to_dict()
        self.append_jsonl(self.audit_path, data)
        return data

    def events(self, app_id: str | None = None) -> list[dict]:
        events = self.read_jsonl(self.audit_path)
        return [e for e in events if app_id is None or e["app_id"] == app_id]

    def reset(self) -> None:
        with self.lock:
            for path in (self.apps_path, self.audit_path, self.outbox_path):
                path.unlink(missing_ok=True)
