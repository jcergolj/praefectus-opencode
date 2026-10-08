import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from watch_test_support import FakeAttentionSource, FakeFocusTarget, FakeProcessSource, FakeTerminal, watch


def envelope(pid=101, ticks=12345, server="shared", ids=("A", "B")):
    owner = {"source_pid": pid, "directory": "/work/a", "process_started_at": 10,
             "process_start_ticks": ticks, "bridge_version": 2, "server_id": server}
    return {**owner, "sessions": [{**owner, "session_id": sid, "state": "IDLE",
            "tab_open": True, "navigation_socket": f"/runtime/{pid}.sock", "updated_at": 20}
            for sid in ids], "completed_sessions": []}


class SessionSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.processes = {101: watch.ProcessInfo(101, "/work/a", 10, 12345, True)}
        self.records = {101: envelope()}
        self.source = FakeProcessSource(self.processes, {})
        self.collector = watch.SessionCollector(self.source, FakeAttentionSource(self.records), FakeTerminal())
        self.snapshots = watch.SnapshotService(self.collector)

    def test_multiple_same_pid_records_and_unique_server_scoped_sessions(self):
        self.records[101]["sessions"][0]["state"] = "WORKING"
        self.processes[102] = replace(self.processes[101], pid=102)
        self.records[102] = envelope(102)
        self.records[102]["sessions"][0]["state"] = "WORKING"
        snapshot = self.snapshots.snapshot()
        self.assertEqual(snapshot["counts"]["sessions"], 2)
        self.assertEqual(snapshot["counts"]["working"], 1)
        self.assertEqual(snapshot["counts"]["idle"], 1)
        self.assertEqual([s["project"] for s in snapshot["sessions"]], ["a", "a II"])
        self.assertEqual(len({s["tracking_id"] for s in snapshot["sessions"]}), 2)
        for session in snapshot["sessions"]:
            target = json.loads(session["focus_target"][8:])
            self.assertEqual(target["session_id"], session["session_id"])
            self.assertEqual([o["source_pid"] for o in target["owners"]], [101, 102])
        self.records[102] = envelope(102, server="independent")
        self.assertEqual(self.snapshots.snapshot()["counts"]["sessions"], 4)

    def test_membership_cleanup_is_independent_of_pid_and_titles_stay_stable(self):
        original = self.snapshots.snapshot()["sessions"]
        self.records[101]["sessions"].pop(0)
        remaining = self.snapshots.snapshot()["sessions"]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["tracking_id"], original[1]["tracking_id"])
        self.assertEqual(remaining[0]["project"], "a II")
        self.records[101]["sessions"] = []
        self.assertEqual(self.snapshots.snapshot()["counts"]["sessions"], 0)
        self.records[101] = envelope(ids=("C",))
        self.assertEqual(self.snapshots.snapshot()["sessions"][0]["project"], "a")

    def test_completion_does_not_count_and_keeps_a_self_contained_target(self):
        self.records[101]["sessions"][1]["state"] = "WORKING"
        self.snapshots.snapshot()
        done = self.records[101]["sessions"].pop()
        self.records[101]["completed_sessions"] = [{**done, "state": "IDLE", "completion_id": "done"}]
        snapshot = self.snapshots.snapshot()
        self.assertEqual(snapshot["counts"]["sessions"], 1)
        completion = snapshot["completed_sessions"][0]
        self.assertEqual(json.loads(completion["focus_target"][8:])["session_id"], "B")
        self.assertEqual(watch.snapshot_signature(snapshot), watch.snapshot_signature(self.snapshots.snapshot()))

    def test_missing_bridge_warns_and_retains_only_the_same_lifetime(self):
        self.records[101]["sessions"][0]["state"] = "WORKING"
        original = self.snapshots.snapshot()
        self.records.clear()
        retained = self.snapshots.snapshot()
        self.assertEqual(retained["sessions"], original["sessions"])
        self.assertIn("missing V2", retained["warnings"][0])
        self.processes[101] = replace(self.processes[101], start_ticks=54321)
        missing = self.snapshots.snapshot()
        self.assertEqual(missing["counts"]["sessions"], 0)
        self.assertIn("missing V2", missing["warnings"][0])
        self.records[101] = envelope()
        stale = self.snapshots.snapshot()
        self.assertEqual(stale["counts"]["sessions"], 0)
        self.assertIn("stale V2", stale["warnings"][0])

    def test_failed_inspection_freezes_all_sessions_not_just_one(self):
        self.records[101]["sessions"][0]["state"] = "WORKING"
        before = self.snapshots.snapshot()["sessions"]
        self.processes[101] = None
        self.records[101]["sessions"] = []
        self.assertEqual(self.snapshots.snapshot()["sessions"], before)
        self.processes.clear()
        self.assertEqual(self.snapshots.snapshot()["sessions"], [])

    def test_no_bridge_never_invents_idle_and_empty_envelope_is_not_a_warning(self):
        self.records.clear()
        snapshot = self.snapshots.snapshot()
        self.assertEqual(snapshot["counts"]["sessions"], 0)
        self.assertIn("warnings", snapshot)
        self.records[101] = envelope(ids=())
        snapshot = self.snapshots.snapshot()
        self.assertEqual(snapshot["sessions"], [])
        self.assertNotIn("warnings", snapshot)

    def test_invalid_membership_or_missing_lifetime_is_warned_not_invented(self):
        for fields in ({"sessions": None}, {"completed_sessions": {}},
                       {"process_start_ticks": None, "process_started_at": None}):
            self.records[101] = {**envelope(), **fields}
            snapshot = self.snapshots.snapshot()
            self.assertEqual(snapshot["counts"]["sessions"], 0)
            self.assertIn("invalid or stale", snapshot["warnings"][0])

    def test_subagent_records_and_completions_are_never_counted(self):
        child = {**self.records[101]["sessions"][0], "session_id": "child", "parentID": "A",
                 "state": "NEEDS_APPROVAL", "attention": True}
        self.records[101]["sessions"].append(child)
        self.records[101]["completed_sessions"].append({**child, "state": "IDLE", "completion_id": "ignored"})
        snapshot = self.snapshots.snapshot()
        self.assertEqual(snapshot["counts"]["sessions"], 2)
        self.assertEqual(snapshot["counts"]["permission"], 0)
        self.assertNotIn("completed_sessions", snapshot)

    def test_cycle_targets_individual_sessions_in_the_same_terminal(self):
        snapshot = self.snapshots.snapshot()
        targets = []
        with tempfile.TemporaryDirectory() as directory:
            store = watch.FocusCycleStore(Path(directory) / "cycle.json")
            for _ in range(3):
                self.assertTrue(store.focus(snapshot, "all", lambda target: targets.append(target) or True))
        self.assertEqual([json.loads(target[8:])["session_id"] for target in targets], ["A", "B", "A"])
        self.assertEqual(watch.focus_target_for_state(snapshot, "idle"), targets[0])


class SessionSourceTests(unittest.TestCase):
    def test_reader_preserves_empty_and_multiple_same_pid_v2_records(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "101.json"
            record = envelope()
            file.write_text(json.dumps(record))
            self.assertEqual(watch.AttentionStateReader(directory).read(), {101: record})
            record["sessions"] = []
            file.write_text(json.dumps(record))
            self.assertEqual(watch.AttentionStateReader(directory).read(), {101: record})

    def test_reader_does_not_overwrite_same_pid_in_legacy_envelopes(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "state.json"
            records = [{"source_pid": 101, "session_id": id} for id in ("A", "B")]
            file.write_text(json.dumps({"sessions": records}))
            self.assertEqual(watch.AttentionStateReader(file).read()[101]["sessions"], records)

    def test_executable_version_is_cached_and_v1_remains_optional(self):
        for version, required in (("opencode v2.0.24", True), ("1.18.29", False)):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                executable = Path(directory) / "101" / "exe"
                executable.parent.mkdir(); executable.touch()
                source = watch.ProcProcessSource(directory, lambda: 10, 100)
                with patch("opencode_watch.sources.subprocess.run") as run:
                    run.return_value.stdout = version
                    self.assertEqual(source._bridge_required(101), required)
                    self.assertEqual(source._bridge_required(101), required)
                    self.assertEqual(run.call_count, 1)


class ExactFocusTests(unittest.TestCase):
    def test_focus_uses_acknowledged_session_and_falls_back_to_live_deduplicated_owner(self):
        processes = {101: watch.ProcessInfo(101, "/a", 10, 54321),
                     102: watch.ProcessInfo(102, "/a", 10, 12345)}
        source = FakeProcessSource(processes, {102: [102, 20]})
        desktop = FakeFocusTarget(True)
        calls = []
        target = "session:" + json.dumps({"server_id": "server", "session_id": "B", "owners": [
            {"source_pid": pid, "process_start_ticks": 12345, "navigation_socket": f"/{pid}.sock"}
            for pid in (101, 102)]})
        service = watch.FocusService(source, [desktop], navigate=lambda owner, server, session:
                                     calls.append((owner["source_pid"], server, session)) or True)
        self.assertTrue(service.focus(target))
        self.assertEqual(calls, [(102, "server", "B")])
        self.assertEqual(desktop.focus_calls, [[102, 20]])
        desktop.focus_calls.clear()
        service.navigate = lambda *args: False
        self.assertFalse(service.focus(target))
        self.assertEqual(desktop.focus_calls, [])

    def test_malformed_session_targets_are_rejected(self):
        service = watch.FocusService(FakeProcessSource({}, {}), [])
        for value in ("session:garbage", "session:[]", "session:{}", 'session:{"owners":null}'):
            self.assertFalse(service.focus(value))


if __name__ == "__main__":
    unittest.main()
