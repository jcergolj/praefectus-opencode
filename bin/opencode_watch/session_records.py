"""V2 session identity, deduplication and self-contained navigation targets."""

import json
from copy import deepcopy
from dataclasses import replace
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from .domain import ProcessInfo, Session, SessionStatus, TmuxPane
from .tracking import SessionTracker, TrackedSession


def identity(record: Mapping[str, Any]) -> str:
    return "session:" + json.dumps([record["server_id"], record["session_id"]], separators=(",", ":"))


def focus_target(record: Mapping[str, Any], owners: List[Mapping[str, Any]]) -> str:
    return "session:" + json.dumps({
        "server_id": record["server_id"], "session_id": record["session_id"],
        "owners": owners,
    }, separators=(",", ":"))


def owner_target(process: ProcessInfo, record: Mapping[str, Any]) -> Dict[str, Any]:
    return {"source_pid": process.pid, "process_start_ticks": process.start_ticks,
            "process_started_at": process.started_at, "navigation_socket": record.get("navigation_socket")}


class SessionRecords:
    """Keep V2 membership independent of process-based V1 tracking."""

    def __init__(self, factory):
        self.factory = factory
        self.by_pid: Dict[int, Tuple[ProcessInfo, Mapping[str, Any]]] = {}
        self.numbers = {}
        self.sequences = {}
        self.completed: List[Mapping[str, Any]] = []

    def observe(self, process: ProcessInfo, envelope: Mapping[str, Any]) -> bool:
        if (not isinstance(envelope.get("sessions"), list)
                or not isinstance(envelope.get("completed_sessions", []), list)
                or not isinstance(envelope.get("warnings", []), list)
                or not isinstance(envelope.get("server_id"), str)
                or not envelope.get("server_id")
                or not (envelope.get("process_start_ticks") is not None
                        or envelope.get("process_started_at") is not None)
                or not SessionTracker._matches_process(process, envelope)):
            self.by_pid.pop(process.pid, None)
            return False
        self.by_pid[process.pid] = (process, deepcopy(envelope))
        return True

    def retained(self, process: ProcessInfo) -> Optional[Mapping[str, Any]]:
        previous = self.by_pid.get(process.pid)
        if previous and SessionTracker._same_lifetime(previous[0], process):
            return previous[1]
        self.by_pid.pop(process.pid, None)
        return None

    def collect(
        self,
        active_pids: Iterable[int],
        panes: List[TmuxPane],
        ancestors: Callable[[int], List[int]],
    ) -> List[Session]:
        active_pids = set(active_pids)
        self.by_pid = {pid: value for pid, value in self.by_pid.items() if pid in active_pids}
        groups = {}
        for process, envelope in self.by_pid.values():
            for completed, field in ((False, "sessions"), (True, "completed_sessions")):
                for record in envelope.get(field, []):
                    if (not isinstance(record, dict) or not isinstance(record.get("server_id"), str)
                            or not isinstance(record.get("session_id"), str)
                            or not record.get("server_id") or not record.get("session_id")):
                        continue
                    if record.get("parentID") or record.get("parent_id"):
                        continue
                    if not SessionTracker._matches_process(process, record):
                        continue
                    groups.setdefault(identity(record), []).append((process, record, completed))
        sessions = []
        self.completed = []
        active_keys = set()
        for key, candidates in sorted(groups.items(), key=lambda item: (
                min(record.get("session_created_at", process.started_at) for process, record, _ in item[1]),
                item[0])):
            # A lagging closed-terminal completion must not hide an open tab.
            live = [item for item in candidates if not item[2]]
            choices = live or candidates
            process, record, completed = max(choices, key=lambda item: (
                item[1].get("updated_at", 0), -item[0].pid))
            owners = [owner_target(p, r) for p, r, _ in sorted(candidates, key=lambda item: item[0].pid)]
            target = focus_target(record, owners)
            if completed:
                self.completed.append({**record, "tracking_id": key, "focus_target": target})
                continue
            directory = record.get("directory") or process.directory
            title_key = (key, directory)
            active_keys.add(title_key)
            if title_key not in self.numbers:
                self.sequences[directory] = self.sequences.get(directory, 0) + 1
                self.numbers[title_key] = self.sequences[directory]
            status = SessionStatus.from_value(record.get("state"))
            if status is None:
                continue
            tracked = TrackedSession(key, status, record, self.numbers[title_key])
            pane = next((pane for pane in panes if pane.pid in ancestors(process.pid)), None)
            session = self.factory.create(replace(process, directory=directory), pane, tracked)
            sessions.append(replace(session, focus_target=target))
        self.numbers = {key: number for key, number in self.numbers.items() if key in active_keys}
        directories = {directory for _, directory in active_keys}
        self.sequences = {d: n for d, n in self.sequences.items() if d in directories}
        return sessions
