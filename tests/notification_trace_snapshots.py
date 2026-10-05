"""Turn bridge-produced record frames into real watcher snapshots for Node tests."""

import json
import sys
import tempfile
from pathlib import Path

from watch_test_support import FakeProcessSource, FakeTerminal, watch


def snapshots_for(frames):
    processes = {}
    with tempfile.TemporaryDirectory() as directory:
        status_dir = Path(directory)
        snapshots = watch.SnapshotService(watch.SessionCollector(
            FakeProcessSource(processes, {}),
            watch.AttentionStateReader(status_dir),
            FakeTerminal(),
        ), clock=lambda: 200)
        result = []
        for records in frames:
            processes.clear()
            for status_file in status_dir.glob("*.json"):
                status_file.unlink()
            for record in records:
                pid = record["source_pid"]
                processes[pid] = watch.ProcessInfo(
                    pid, record["directory"], record["process_started_at"],
                    record["process_start_ticks"],
                )
                (status_dir / f"{pid}.json").write_text(json.dumps(record), encoding="utf-8")
            result.append(snapshots.snapshot())
        return result


if __name__ == "__main__":
    json.dump(snapshots_for(json.load(sys.stdin)), sys.stdout)
