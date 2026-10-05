"""Keep record matching, retained state and titles tied to process lifetimes."""

from dataclasses import dataclass, replace
from typing import Any, Dict, Iterable, Mapping, Optional, Tuple

from .config import PROCESS_START_TOLERANCE
from .domain import ProcessInfo, SessionStateMachine, SessionStatus


@dataclass(frozen=True)
class TrackedSession:
    identity: str
    status: SessionStatus
    record: Mapping[str, Any]
    number: int


@dataclass(frozen=True)
class ProcessObservation:
    process: ProcessInfo
    session: TrackedSession


def _process_identity(process: ProcessInfo) -> str:
    # Start ticks are authoritative; cwd and epoch-clock changes are not restarts.
    if process.start_ticks is not None:
        return f"pid:{process.pid}:ticks:{process.start_ticks}"
    return f"pid:{process.pid}:started:{process.started_at}"


class SessionTracker:
    """Observe a live process once and return its matched, continuous session."""

    def __init__(self):
        self._observations: Dict[int, ProcessObservation] = {}
        self._machines: Dict[str, SessionStateMachine] = {}
        self._session_numbers: Dict[Tuple[str, str], int] = {}
        self._directory_sequences: Dict[str, int] = {}

    def observe(self, process: ProcessInfo, record: Mapping[str, Any]) -> TrackedSession:
        if not self._matches_process(process, record):
            record = {}
        previous = self._observations.get(process.pid)
        if previous is not None and self._same_lifetime(previous.process, process):
            identity = previous.session.identity
            if process.start_ticks is None:
                process = replace(process, start_ticks=previous.process.start_ticks)
        else:
            identity = _process_identity(process)
        machine = self._machines.get(identity)
        if machine is None:
            machine = SessionStateMachine()
            self._machines[identity] = machine
        if "state" in record:
            machine.transition_to(record["state"])

        title_key = (identity, process.directory)
        number = self._session_numbers.get(title_key)
        if number is None:
            number = self._directory_sequences.get(process.directory, 0) + 1
            self._directory_sequences[process.directory] = number
            self._session_numbers[title_key] = number
        tracked = TrackedSession(identity, machine.status, dict(record), number)
        self._observations[process.pid] = ProcessObservation(process, tracked)
        return tracked

    def last_observation(self, pid: int) -> Optional[ProcessObservation]:
        """Freeze a known session when enumeration succeeds but inspection fails."""
        return self._observations.get(pid)

    def remove_missing(self, active_pids: Iterable[int]) -> None:
        active = set(active_pids)
        self._observations = {
            pid: observation for pid, observation in self._observations.items() if pid in active
        }
        identities = {observation.session.identity for observation in self._observations.values()}
        self._machines = {
            identity: machine for identity, machine in self._machines.items()
            if identity in identities
        }
        title_keys = {
            (observation.session.identity, observation.process.directory)
            for observation in self._observations.values()
        }
        self._session_numbers = {
            key: number for key, number in self._session_numbers.items()
            if key in title_keys
        }
        directories = {observation.process.directory for observation in self._observations.values()}
        self._directory_sequences = {
            directory: number for directory, number in self._directory_sequences.items()
            if directory in directories
        }

    @staticmethod
    def _same_lifetime(previous: ProcessInfo, current: ProcessInfo) -> bool:
        if previous.start_ticks is not None and current.start_ticks is not None:
            return previous.start_ticks == current.start_ticks
        return previous.started_at == current.started_at

    @staticmethod
    def _matches_process(process: ProcessInfo, record: Mapping[str, Any]) -> bool:
        recorded_ticks = record.get("process_start_ticks")
        if recorded_ticks is not None and process.start_ticks is not None:
            return type(recorded_ticks) is int and recorded_ticks == process.start_ticks
        recorded_started_at = record.get("process_started_at")
        if recorded_started_at is None:
            return True
        try:
            return abs(float(recorded_started_at) - process.started_at) <= PROCESS_START_TOLERANCE
        except (TypeError, ValueError):
            return False
