"""Build the stable session snapshot consumed by the QML widget."""

import os
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple

from .domain import (
    AttentionSource,
    DEFAULT_PREVIEWS,
    EMPTY_SESSION_COUNTS,
    ProcessInfo,
    ProcessSource,
    Session,
    SessionSource,
    STATUS_COUNT_BUCKETS,
    TerminalSource,
    TmuxPane,
)
from .tracking import SessionTracker, TrackedSession


def roman_number(number: int) -> str:
    numerals = []
    for value, numeral in (
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
        (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
        (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ):
        count, number = divmod(number, value)
        numerals.append(numeral * count)
    return "".join(numerals)


class SessionFactory:
    """Translate process and optional attention data into a UI session."""

    def create(
        self,
        process: ProcessInfo,
        pane: Optional[TmuxPane],
        tracked: TrackedSession,
    ) -> Session:
        current_status = tracked.status
        status_record = tracked.record
        project = os.path.basename(process.directory) or "OpenCode"
        if tracked.number > 1:
            project = f"{project} {roman_number(tracked.number)}"
        return Session(
            session_id=status_record.get("session_id", f"pid:{process.pid}"),
            tracking_id=tracked.identity,
            project=project,
            state=current_status.value,
            tmux_pane=pane.id if pane else None,
            tmux_socket=status_record.get("tmux_socket"),
            source_pid=process.pid,
            directory=process.directory,
            notification_id=status_record.get("notification_id"),
            attention=bool(status_record.get("attention")),
            attention_since=status_record.get("attention_since"),
            last_transition_ts=status_record.get(
                "last_transition_ts", process.started_at
            ),
            preview=status_record.get("preview")
            or DEFAULT_PREVIEWS.get(current_status.value, "idle"),
            context_tokens=status_record.get("context_tokens"),
            context_limit=status_record.get("context_limit"),
            context_percentage=status_record.get("context_percentage"),
        )


class SessionCollector:
    """Collect top-level OpenCode processes and enrich them with UI metadata."""

    def __init__(
        self,
        process_source: ProcessSource,
        attention_source: AttentionSource,
        terminal_source: TerminalSource,
        session_factory: Optional[SessionFactory] = None,
        tracker: Optional[SessionTracker] = None,
    ):
        self.process_source = process_source
        self.attention_source = attention_source
        self.terminal_source = terminal_source
        self.session_factory = session_factory or SessionFactory()
        self.tracker = tracker or SessionTracker()

    def collect(self) -> List[Session]:
        status_records = self.attention_source.read()
        opencode_pids = self.process_source.opencode_pids()
        panes = self.terminal_source.panes()
        sessions: List[Session] = []
        active_pids: Set[int] = set()
        processes: List[Tuple[ProcessInfo, Optional[TrackedSession]]] = []
        for pid in opencode_pids:
            process = self.process_source.inspect(pid)
            if process is not None:
                processes.append((process, None))
            else:
                last_observation = self.tracker.last_observation(pid)
                if last_observation is not None:
                    processes.append((last_observation.process, last_observation.session))

        for process, frozen in sorted(processes, key=lambda item: (item[0].started_at, item[0].pid)):
            session = self._collect_process(
                process,
                opencode_pids,
                status_records,
                panes,
                frozen,
            )
            if session is None:
                continue
            active_pids.add(process.pid)
            sessions.append(session)

        self.tracker.remove_missing(active_pids)
        return sorted(sessions, key=lambda session: session.source_pid)

    def _collect_process(
        self,
        process: ProcessInfo,
        opencode_pids: Set[int],
        status_records: Mapping[int, Mapping[str, Any]],
        panes: List[TmuxPane],
        frozen: Optional[TrackedSession] = None,
    ) -> Optional[Session]:
        process_pid = process.pid
        process_ancestors = self.process_source.ancestors(process_pid)
        if any(parent_pid in opencode_pids for parent_pid in process_ancestors[1:]):
            return None

        status_record = status_records.get(process_pid, {})
        pane = next(
            (pane for pane in panes if pane.pid in process_ancestors),
            None,
        )
        return self.session_factory.create(
            process,
            pane,
            frozen if frozen is not None else self.tracker.observe(process, status_record),
        )


class SnapshotService:
    """Build the stable JSON document consumed by the QML widget."""

    def __init__(
        self,
        collector: SessionSource,
        clock: Callable[[], float] = time.time,
    ):
        self.collector = collector
        self.clock = clock

    def snapshot(self) -> Dict[str, Any]:
        sessions = [session.as_dict() for session in self.collector.collect()]
        session_counts = dict(EMPTY_SESSION_COUNTS)
        session_counts["sessions"] = len(sessions)
        session_counts["attention"] = sum(
            session["attention"] for session in sessions
        )
        for session in sessions:
            count_bucket = STATUS_COUNT_BUCKETS.get(session["state"])
            if count_bucket:
                session_counts[count_bucket] += 1
        return {
            "generated_ts": self.clock(),
            "counts": session_counts,
            "sessions": sessions,
        }
