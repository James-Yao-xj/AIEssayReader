# Plan
1. Implement pure budget and coverage planner and tests.
2. Wire settings budget and status.
3. Wire client summary/window bounds and tests.
4. Integrate tests/build/docs, review, commit and push.

Completed: 51 regression tests pass. Production build and diff checks pass. Non-stream output truncation rejects summaries before the compression index advances. Estimation is heuristic; no paid model calls were used.
