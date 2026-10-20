# Agent Management Optimizer

This project asks whether an orchestrator/worker split beats one model alone on hard coding tasks, and at what cost. In the split, a large model plans and delegates sub-tasks to a small model that has file tools. The benchmark is SWE-Bench Pro V2 HARD (51 tasks), run with six arms: two solo models and combination arms that pair a large orchestrator with a small worker.

## Status

Written and type-checked, not run yet. There are no scores or costs.

## Arms

Solo arms (one model works alone):

- `solo-haiku-5-5-low`: Haiku 5.5, low effort
- `solo-opus-5-5-xhigh`: Opus 5.5, xhigh effort
- `solo-haiku-4-5-low`: Haiku 4.5, low effort
- `solo-opus-4-8-xhigh`: Opus 4.8, xhigh effort

Combination arms (orchestrator plans and delegates; workers edit):

- `combo-opus-5-5-xhigh-haiku-5-5-low`: orchestrator Opus 5.5 (xhigh), workers Haiku 5.5 (low)
- `combo-opus-4-8-xhigh-haiku-4-5-low`: orchestrator Opus 4.8 (xhigh), workers Haiku 4.5 (low)

The orchestrator has no file tools. Its only tool delegates one sub-task to a worker. Workers run one at a time in the same repository.

## Setup

```
npm install
npm run plan
```

## Run

See the "How to run" section of [swe_bench_pro_v2_report.md](swe_bench_pro_v2_report.md).

- Run one arm at a time, and start with `--limit 3` to measure cost and time.
- Run inside a VM or container that only reaches api.anthropic.com. The agents have Bash and internet access on the host, so an upstream fix could leak in, as the header of `swe_bench_pro_v2_bench.mts` warns.

## Grading

Grading is separate from generation and uses Harbor's `patch_replay` agent. See the report for the commands and sanity checks.

## Licence

MIT. See [LICENSE](LICENSE).
