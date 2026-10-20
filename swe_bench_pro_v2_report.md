# SWE-Bench Pro V2 HARD: six arms

**Status:** the benchmark is written and checked. It has not been run. There are no patches, scores, or costs yet.

## The benchmark

- Dataset: `ScaleAI/SWE-bench_Pro`, config `hard`. That is V2 HARD: 51 tasks, version 2.0.0. The IDs match `v2/hard51_ids.txt` in the official `scaleapi/SWE-bench_Pro-os` repo.
- The official V2 README says these 51 tasks were chosen because at least two of five model families failed each one. Claude Opus 5 is one of the five. So absolute scores on this set will look low, especially for Claude models. Compare the six arms with each other, not against published scores.
- Each task is a real issue from an open-source repository. The agent gets the task text and the repository at the base commit, and it writes a patch.
- The official harness grades the patch. It applies the patch in a fresh sandbox and runs the hidden tests.

## The six arms

**Solo arms.** One model works alone on every task.

| Arm | Model | Effort |
|---|---|---|
| `solo-haiku-5-5-low` | Haiku 5.5 | low |
| `solo-opus-5-5-xhigh` | Opus 5.5 | xhigh |
| `solo-haiku-4-5-low` | Haiku 4.5 | low |
| `solo-opus-4-8-xhigh` | Opus 4.8 | xhigh |

**Combination arms.** This is the design pattern from the notebook `CMA_plan_big_execute_small`. A large orchestrator plans and delegates. Small workers do the reading and editing.

| Arm | Orchestrator | Workers |
|---|---|---|
| `combo-opus-5-5-xhigh-haiku-5-5-low` | Opus 5.5, xhigh | Haiku 5.5, low |
| `combo-opus-4-8-xhigh-haiku-4-5-low` | Opus 4.8, xhigh | Haiku 4.5, low |

How a combination run works:
- The orchestrator has no file tools. Its only tool is `delegate_to_worker`, which takes one sub-task.
- Each call starts a new worker in the same repository. The worker has Read, Edit, Write, Bash, Glob, and Grep. Its final message is its report.
- Workers run one at a time, so two workers never edit the repository at once.
- The orchestrator decides when the fix is done. The patch is the repository's `git diff` at the end.

## What changed from the notebook

- The notebook's workers search the web. Here they work on code, so they get coding tools.
- The notebook runs workers in parallel. Here they run one at a time, because parallel edits would collide.
- The notebook caps the whole team's spend. Here the orchestrator and the workers each have a cap of `RUN_BUDGET_USD`, which defaults to $20. A combination run can therefore spend up to $40.
- The notebook has no time limit. Here every run shares the V2 limit of 50 minutes.

## How generation works

1. Read the 51 tasks from the dataset's `hard` config.
2. For each task, check out the base commit in its own worktree.
3. Send the task's `instruction.md`, with one line added: the repository is the working directory, not `/app`.
4. Run the arm's agents with the bundled Claude login. No API key is used.
5. Stop at 50 minutes or at the budget cap.
6. Save `git diff` against the base commit as the patch, in the layout Harbor's `patch_replay` agent reads.

## How this differs from the official protocol

- The official agent runs offline in a sandbox. This run uses this machine, with Bash and internet access, so an agent could find the upstream fix online. Until the run is offline, its numbers can't be compared with official V2 results.
- The repository comes from GitHub at the base commit, not from the V2 image. The commits are the same.
- The solo arms use the default Claude Code system prompt. The combination arms use the prompts above.
- The dataset's `before_repo_set_cmd` is not run. In V2 it applies the test patch, and the agent must not see the tests.

## Checks done

- Type check against SDK 0.2.141 and zod 4: passes.
- Plan mode lists all six arms and all 51 tasks from the live `hard` config.
- Not run: any arm, grading, cost, or time.

## Cost and time

Earlier estimates covered the solo arms only. Per-task cost depends on how many turns an agent takes and how many tokens it reads, and nothing has been measured yet. For the combination arms, the orchestrator's cost is close to a solo run of the same large model. The workers add Haiku-priced tokens on top. Run a pilot first, then estimate.

## How to run

Generate patches. Run these at the repository root:

```
npm i @anthropic-ai/claude-agent-sdk@0.2.141 zod@^4
node swe_bench_pro_v2_bench.mts --plan
node swe_bench_pro_v2_bench.mts --arm solo-haiku-5-5-low --limit 3
node swe_bench_pro_v2_bench.mts --summary
```

Run one arm at a time. Use `--limit 3` first to measure cost and time. Output goes to `$TMPDIR/swe-bench-pro-v2` by default. Set `SWE_OUT` to change it. The script runs the `claude` command from your PATH. Set `CLAUDE_CLI` to use a different install.

Grade the patches. Clone `scaleapi/SWE-bench_Pro-os` first, then run this from its root, once per arm:

```
uv tool install 'harbor[modal]>=0.22' && modal setup
PYTHONPATH=v2/tooling harbor run -p v2/tasks $(sed 's/^/-i /' v2/hard51_ids.txt) -e modal -n 20 -a patch_replay:PatchReplayAgent -m replay --ak source_job=<SWE_OUT>/jobs/sbp-v2-<arm> --job-name sbp-v2-hard-<arm>-regrade
```

Before you trust any grade, run the sanity checks on the same 51 tasks. The reference patch should resolve all of them, and an empty patch should resolve none:

```
harbor run -p v2/tasks $(sed 's/^/-i /' v2/hard51_ids.txt) -e modal -n 20 -a oracle --job-name sbp-v2-hard-oracle
harbor run -p v2/tasks $(sed 's/^/-i /' v2/hard51_ids.txt) -e modal -n 20 -a nop --job-name sbp-v2-hard-nop
```

## Results

Pending. Nothing has been run yet.
