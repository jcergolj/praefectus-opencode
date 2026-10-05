import unittest

from watch_test_support import FakeAttentionSource, FakeProcessSource, FakeTerminal, watch


class SnapshotServiceTests(unittest.TestCase):
    def test_temporary_tick_unavailability_does_not_reset_a_known_lifetime(self):
        processes = {101: watch.ProcessInfo(101, "/work/alpha", 100, 12345)}
        records = {101: {"state": "WORKING", "process_start_ticks": 12345}}
        snapshots = watch.SnapshotService(watch.SessionCollector(
            FakeProcessSource(processes, {}), FakeAttentionSource(records), FakeTerminal()
        ))
        original = snapshots.snapshot()["sessions"][0]
        records.clear()
        processes[101] = watch.ProcessInfo(101, "/work/alpha", 100)
        uncertain = snapshots.snapshot()["sessions"][0]
        self.assertEqual(uncertain["state"], "WORKING")
        self.assertEqual(uncertain["tracking_id"], original["tracking_id"])
        self.assertEqual(uncertain["project"], "alpha")
        processes[101] = watch.ProcessInfo(101, "/work/alpha", 100, 12345)
        self.assertEqual(snapshots.snapshot()["sessions"][0]["state"], "WORKING")
        processes[101] = watch.ProcessInfo(101, "/work/alpha", 100, 54321)
        self.assertEqual(snapshots.snapshot()["sessions"][0]["state"], "IDLE")

    def test_missing_records_retain_state_only_for_the_same_process_lifetime(self):
        for ticks in (None, 12345):
            with self.subTest(ticks=ticks):
                processes = {101: watch.ProcessInfo(101, "/work/alpha", 100, ticks)}
                record = {"state": "WORKING", "process_started_at": 100}
                if ticks is not None:
                    record["process_start_ticks"] = ticks
                records = {101: record}
                snapshots = watch.SnapshotService(watch.SessionCollector(
                    FakeProcessSource(processes, {}), FakeAttentionSource(records), FakeTerminal()
                ))
                original = snapshots.snapshot()["sessions"][0]
                records.clear()
                retained = snapshots.snapshot()["sessions"][0]
                self.assertEqual(retained["state"], "WORKING")
                self.assertEqual(retained["tracking_id"], original["tracking_id"])

                processes[101] = watch.ProcessInfo(
                    101, "/work/alpha", 200, None if ticks is None else 54321
                )
                replacement = snapshots.snapshot()["sessions"][0]
                self.assertEqual(replacement["state"], "IDLE")
                self.assertNotEqual(replacement["tracking_id"], original["tracking_id"])
                self.assertEqual(replacement["project"], "alpha II")
                records[101] = record
                self.assertEqual(snapshots.snapshot()["sessions"][0]["state"], "IDLE")

    def test_start_ticks_keep_identity_state_and_titles_stable_despite_epoch_changes(self):
        processes = {
            101: watch.ProcessInfo(101, "/work/alpha", 100, 12345),
            202: watch.ProcessInfo(202, "/work/alpha", 200, 54321),
        }
        records = {202: {"state": "WORKING", "process_start_ticks": 54321}}
        snapshots = watch.SnapshotService(watch.SessionCollector(
            FakeProcessSource(processes, {}), FakeAttentionSource(records), FakeTerminal()
        ))
        before = snapshots.snapshot()["sessions"][1]
        processes[202] = watch.ProcessInfo(202, "/work/alpha", 260, 54321)
        records.clear()
        after = snapshots.snapshot()["sessions"][1]
        self.assertEqual(after["tracking_id"], before["tracking_id"])
        self.assertEqual(after["project"], "alpha II")
        self.assertEqual(after["state"], "WORKING")

    def test_pid_reuse_between_polls_rejects_stale_record_and_resets_state(self):
        processes = {101: watch.ProcessInfo(101, "/work/alpha", 100, 12345)}
        records = {101: {
            "state": "WORKING", "session_id": "old", "process_start_ticks": 12345,
            "attention": True, "preview": "old preview", "context_tokens": 500,
        }}
        collector = watch.SessionCollector(
            FakeProcessSource(processes, {}), FakeAttentionSource(records), FakeTerminal()
        )
        self.assertEqual(collector.collect()[0].state, "WORKING")

        # No empty poll: even a matching epoch cannot override different ticks.
        processes[101] = watch.ProcessInfo(101, "/work/alpha", 100, 54321)
        replacement = collector.collect()[0]
        self.assertEqual(replacement.state, "IDLE")
        self.assertEqual(replacement.session_id, "pid:101")
        self.assertFalse(replacement.attention)
        self.assertEqual(replacement.preview, "idle")
        self.assertIsNone(replacement.context_tokens)
        self.assertEqual(replacement.project, "alpha II")

    def test_same_directory_titles_use_creation_order_and_roman_numerals(self):
        processes = {
            200 - number: watch.ProcessInfo(200 - number, "/work/foo bar", number)
            for number in range(1, 11)
        }
        collector = watch.SessionCollector(
            FakeProcessSource(processes, {}), FakeAttentionSource({}), FakeTerminal()
        )

        sessions = watch.SnapshotService(collector).snapshot()["sessions"]
        titles_by_pid = {session["source_pid"]: session["project"] for session in sessions}
        self.assertEqual(
            [titles_by_pid[200 - number] for number in range(1, 11)],
            ["foo bar", "foo bar II", "foo bar III", "foo bar IV", "foo bar V",
             "foo bar VI", "foo bar VII", "foo bar VIII", "foo bar IX", "foo bar X"],
        )

    def test_titles_stay_stable_as_sessions_start_and_close(self):
        processes = {202: watch.ProcessInfo(202, "/work/alpha", 100)}
        collector = watch.SessionCollector(
            FakeProcessSource(processes, {}), FakeAttentionSource({}), FakeTerminal()
        )
        self.assertEqual(collector.collect()[0].project, "alpha")

        processes[101] = watch.ProcessInfo(101, "/work/alpha", 200)
        self.assertEqual(
            {session.source_pid: session.project for session in collector.collect()},
            {202: "alpha", 101: "alpha II"},
        )
        del processes[202]
        self.assertEqual(collector.collect()[0].project, "alpha II")

        # Reused PIDs represent a new process and receive a new suffix.
        processes[202] = watch.ProcessInfo(202, "/work/alpha", 300)
        self.assertEqual(
            {session.source_pid: session.project for session in collector.collect()},
            {101: "alpha II", 202: "alpha III"},
        )
        self.assertEqual(
            {session.source_pid: session.project for session in collector.collect()},
            {101: "alpha II", 202: "alpha III"},
        )

        processes.clear()
        self.assertEqual(collector.collect(), [])
        processes[303] = watch.ProcessInfo(303, "/work/alpha", 400)
        self.assertEqual(collector.collect()[0].project, "alpha")

    def test_numbering_groups_full_directories_and_ignores_nested_processes(self):
        collector = watch.SessionCollector(
            FakeProcessSource(
                {
                    101: watch.ProcessInfo(101, "/work/alpha", 100),
                    202: watch.ProcessInfo(202, "/work/alpha", 200),
                    303: watch.ProcessInfo(303, "/other/alpha", 300),
                    404: watch.ProcessInfo(404, "/work/alpha", 400),
                },
                {202: [202, 101]},
            ),
            FakeAttentionSource({}),
            FakeTerminal(),
        )
        self.assertEqual(
            {session.source_pid: session.project for session in collector.collect()},
            {101: "alpha", 303: "alpha", 404: "alpha II"},
        )

    def test_exact_start_ticks_accept_status_despite_epoch_mismatch(self):
        collector = watch.SessionCollector(
            FakeProcessSource(
                {101: watch.ProcessInfo(101, "/work/alpha", 100, 12345)},
                {101: [101]},
            ),
            FakeAttentionSource({101: {
                "state": "WORKING",
                "process_started_at": 160,
                "process_start_ticks": 12345,
            }}),
            FakeTerminal(),
        )

        self.assertEqual(collector.collect()[0].state, "WORKING")

    def test_mismatched_or_malformed_ticks_reject_status_despite_matching_epoch(self):
        for ticks in (12346, "12345", 12345.5, True, [], {}):
            with self.subTest(ticks=ticks):
                collector = watch.SessionCollector(
                    FakeProcessSource(
                        {101: watch.ProcessInfo(101, "/work/alpha", 100, 12345)},
                        {101: [101]},
                    ),
                    FakeAttentionSource({101: {
                        "state": "WORKING",
                        "process_started_at": 100,
                        "process_start_ticks": ticks,
                    }}),
                    FakeTerminal(),
                )

                self.assertEqual(collector.collect()[0].state, "IDLE")

    def test_timestamp_fallback_when_either_side_lacks_ticks(self):
        for process_ticks, record_ticks in ((12345, None), (None, 12345), (None, None)):
            for epoch, expected in ((102.2, True), (160, False)):
                with self.subTest(process_ticks=process_ticks, record_ticks=record_ticks, epoch=epoch):
                    record = {"state": "WORKING", "process_started_at": epoch}
                    if record_ticks is not None:
                        record["process_start_ticks"] = record_ticks
                    collector = watch.SessionCollector(
                        FakeProcessSource({101: watch.ProcessInfo(
                            101, "/work/alpha", 100, process_ticks
                        )}, {}),
                        FakeAttentionSource({101: record}), FakeTerminal(),
                    )
                    self.assertEqual(collector.collect()[0].state, "WORKING" if expected else "IDLE")

    def test_new_process_uses_its_first_reported_attention_state(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        attention_source = FakeAttentionSource({101: {"state": "NEEDS_APPROVAL"}})
        collector = watch.SessionCollector(
            process_source,
            attention_source,
            FakeTerminal(),
        )

        self.assertEqual(collector.collect()[0].state, "NEEDS_APPROVAL")

        attention_source.status_records[101]["state"] = "WORKING"
        self.assertEqual(collector.collect()[0].state, "WORKING")

        attention_source.status_records[101]["state"] = "NEEDS_APPROVAL"
        self.assertEqual(collector.collect()[0].state, "NEEDS_APPROVAL")

    def test_status_record_allows_plugin_startup_clock_skew(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        collector = watch.SessionCollector(
            process_source,
            FakeAttentionSource(
                {
                    101: {
                        "state": "NEEDS_APPROVAL",
                        "process_started_at": 102.2,
                    }
                }
            ),
            FakeTerminal(),
        )

        self.assertEqual(collector.collect()[0].state, "NEEDS_APPROVAL")

    def test_recreated_process_gets_a_new_state(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        attention_source = FakeAttentionSource({101: {"state": "WORKING"}})
        collector = watch.SessionCollector(
            process_source,
            attention_source,
            FakeTerminal(),
        )

        self.assertEqual(collector.collect()[0].state, "WORKING")

        process_source.process_info_by_pid.clear()
        self.assertEqual(collector.collect(), [])

        process_source.process_info_by_pid[101] = watch.ProcessInfo(
            101, "/work/alpha", 200
        )
        attention_source.status_records[101]["state"] = "WAITING"
        self.assertEqual(collector.collect()[0].state, "WAITING")

    def test_snapshot_ignores_nested_processes_and_aggregates_states(self):
        processes = {
            101: watch.ProcessInfo(101, "/work/alpha", 100),
            202: watch.ProcessInfo(202, "/work/nested", 200),
            303: watch.ProcessInfo(303, "/work/beta", 300),
        }
        process_source = FakeProcessSource(
            processes,
            {
                101: [101, 10],
                202: [202, 101, 10],
                303: [303, 20],
            },
        )
        attention_source = FakeAttentionSource(
            {
                101: {
                    "session_id": "alpha",
                    "state": "WORKING",
                    "attention": True,
                    "attention_since": 90,
                    "preview": "Answer the question",
                    "context_tokens": 1300,
                    "context_limit": 10000,
                    "context_percentage": 13,
                },
                303: {"session_id": "beta", "state": "IDLE"},
            }
        )
        terminal = FakeTerminal(watch.TmuxPane("%1", 10))
        collector = watch.SessionCollector(process_source, attention_source, terminal)
        snapshots = watch.SnapshotService(collector, clock=lambda: 1234)

        collector.collect()
        attention_source.status_records[101]["state"] = "WAITING"
        state = snapshots.snapshot()

        self.assertEqual(state["generated_ts"], 1234)
        self.assertEqual(
            state["counts"],
            {
                "sessions": 2,
                "attention": 1,
                "response": 1,
                "permission": 0,
                "idle": 1,
                "working": 0,
            },
        )
        self.assertEqual(
            [session["session_id"] for session in state["sessions"]],
            ["alpha", "beta"],
        )
        self.assertEqual(state["sessions"][0]["tmux_pane"], "%1")
        self.assertEqual(state["sessions"][1]["state"], "IDLE")
        self.assertEqual(state["sessions"][0]["context_tokens"], 1300)
        self.assertEqual(state["sessions"][0]["context_limit"], 10000)
        self.assertEqual(state["sessions"][0]["context_percentage"], 13)
        self.assertEqual(terminal.pane_call_count, 2)

    def test_untracked_process_defaults_to_idle(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        collector = watch.SessionCollector(
            process_source,
            FakeAttentionSource({}),
            FakeTerminal(),
        )

        session = collector.collect()[0]

        self.assertEqual(session.state, "IDLE")
        self.assertEqual(session.session_id, "pid:101")
        self.assertFalse(session.attention)
        self.assertEqual(session.preview, "idle")

        counts = watch.SnapshotService(collector).snapshot()["counts"]

        self.assertEqual(counts["idle"], 1)
        self.assertEqual(counts["working"], 0)

    def test_permission_state_is_not_counted_as_working(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        attention_source = FakeAttentionSource({101: {"state": "WORKING"}})
        collector = watch.SessionCollector(process_source, attention_source, FakeTerminal())

        collector.collect()
        attention_source.status_records[101]["state"] = "NEEDS_APPROVAL"

        counts = watch.SnapshotService(collector).snapshot()["counts"]

        self.assertEqual(counts["permission"], 1)
        self.assertEqual(counts["working"], 0)
        self.assertEqual(collector.collect()[0].preview, "waiting for permission")

    def test_working_state_is_exclusive_from_other_status_counts(self):
        process_source = FakeProcessSource(
            {101: watch.ProcessInfo(101, "/work/alpha", 100)},
            {101: [101]},
        )
        collector = watch.SessionCollector(
            process_source,
            FakeAttentionSource({101: {"state": "WORKING"}}),
            FakeTerminal(),
        )

        state = watch.SnapshotService(collector).snapshot()

        self.assertEqual(state["counts"]["sessions"], 1)
        self.assertEqual(state["counts"]["working"], 1)
        self.assertEqual(state["counts"]["idle"], 0)
        self.assertEqual(state["counts"]["response"], 0)
        self.assertEqual(state["counts"]["permission"], 0)


if __name__ == "__main__":
    unittest.main()
