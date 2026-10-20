// SWE-Bench Pro V2 HARD: six arms on the 51 HARD tasks, run on this machine with the bundled Claude login.
//   solo-*   one model alone: Haiku 5.5 low, Opus 5.5 xhigh, Haiku 4.5 low, Opus 4.8 xhigh
//   combo-*  the notebook's pattern: a big orchestrator with no file tools delegates to a small worker
//            (Read, Edit, Write, Bash, Glob, Grep in the same repository). Workers run one at a time.
// Tasks: the `hard` config of ScaleAI/SWE-bench_Pro (51 tasks, version 2.x; same IDs as v2/hard51_ids.txt).
// Prompts: each task's instruction.md from scaleapi/SWE-bench_Pro-os/v2/tasks, the text the V2 agent sees.
// Grading is separate: Harbor's patch_replay agent regrades the saved patches (see the report).
// Built on @anthropic-ai/claude-agent-sdk 0.2.141 and zod 4. No API key.
//
// Caveat: the agent runs on this machine with Bash and internet access. The V2 agent phase is offline.
// Run it inside a VM or container that only reaches api.anthropic.com, or upstream fixes could leak in.
//
// Usage (in a folder with the SDK and zod installed: npm i @anthropic-ai/claude-agent-sdk@0.2.141 zod@^4):
//   node swe_bench_pro_v2_bench.mts --plan                     list arms and budgets; no clones, no model calls
//   node swe_bench_pro_v2_bench.mts --arm <slug> --limit 3     run one arm on the first three tasks
//   node swe_bench_pro_v2_bench.mts --summary                  cost, time, and status per arm
// Output goes to $SWE_OUT (default: $TMPDIR/swe-bench-pro-v2). Patches land in jobs/sbp-v2-<arm>/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

type Effort = "low" | "xhigh";
type Model = { id: string; effort: Effort };
const HAIKU_55: Model = { id: "claude-haiku-5-5", effort: "low" };
const OPUS_55: Model = { id: "claude-opus-5-5", effort: "xhigh" };
const HAIKU_45: Model = { id: "claude-haiku-4-5", effort: "low" };
const OPUS_48: Model = { id: "claude-opus-4-8", effort: "xhigh" };

type Arm = { slug: string; main: Model; worker?: Model };
const ARMS: Arm[] = [
  { slug: "solo-haiku-5-5-low", main: HAIKU_55 },
  { slug: "solo-opus-5-5-xhigh", main: OPUS_55 },
  { slug: "solo-haiku-4-5-low", main: HAIKU_45 },
  { slug: "solo-opus-4-8-xhigh", main: OPUS_48 },
  { slug: "combo-opus-5-5-xhigh-haiku-5-5-low", main: OPUS_55, worker: HAIKU_55 },
  { slug: "combo-opus-4-8-xhigh-haiku-4-5-low", main: OPUS_48, worker: HAIKU_45 },
];

const DATASET = "ScaleAI/SWE-bench_Pro";
const CONFIG = "hard"; // V2 HARD: the 51-task subset
const TASKS_BASE = "https://raw.githubusercontent.com/scaleapi/SWE-bench_Pro-os/main/v2/tasks";
const OUT = process.env.SWE_OUT || join(process.env.TMPDIR || "/tmp", "swe-bench-pro-v2");
// The Claude Code CLI that carries your login: CLAUDE_CLI if set, otherwise the one on PATH.
// The SDK's bundled CLI printed no messages in one sandbox, so the installed CLI is used instead.
const CLAUDE_CLI = process.env.CLAUDE_CLI || spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim() || "claude";
const RUN_BUDGET_USD = Number(process.env.RUN_BUDGET_USD || 20); // per run; a combo run can spend this on each side
const TIME_LIMIT_MIN = 50; // the V2 protocol's per-task budget
const TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

// Adapted from the notebook: its Managed Agents tools become delegate_to_worker, and each worker
// reports in its final message. Here the workers have the coding tools, not the web tools.
const ORCHESTRATOR_SYSTEM =
  "You are coordinating a team of workers that resolve a software issue in a repository. " +
  "Your workers can read, edit, and search the code and run commands; you cannot. " +
  "Break the task into focused sub-tasks and delegate each one with the delegate_to_worker tool, " +
  "one sub-task per call. Name the files, functions, and expected behavior in each sub-task. " +
  "Workers run one at a time. When a worker reports, decide whether its change resolves the issue " +
  "or whether to delegate a follow-up. If a worker stops with an error or no report, delegate the " +
  "sub-task again. When the repository contains a complete fix, stop and summarize what changed.";

const WORKER_SYSTEM =
  "You are a software engineer working in the repository at the current directory. " +
  "The orchestrator gives you one sub-task. Complete it with your tools: read the relevant code, " +
  "make the smallest correct change, and run any quick check you need. Do not edit test files. " +
  "Your final message is your report: what you changed, where, and what you verified.";

type Row = { repo: string; instance_id: string; base_commit: string; version: string; hard: boolean };
type Thread = {
  role: "solo" | "orchestrator" | "worker";
  model: string;
  status: string;
  costUsd: number;
  turns: number;
  text: string;
  error?: string;
};
type Meta = {
  task_name: string;
  arm: string;
  status: string;
  costUsd: number;
  turns: number;
  minutes: number;
  delegations: number;
  threads: Thread[];
  error?: string;
};
type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Number(arg("--limit", "51"));
const OFFSET = Number(arg("--offset", "0"));

// curl follows the system proxy settings, so this works where Node's fetch may not.
function run(cmd: string, cmdArgs: string[], cwd?: string): { stdout: string } {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")}: ${r.stderr || r.error?.message}`);
  return { stdout: r.stdout };
}

// Retries cover the 503s the dataset server returns now and then.
function curlText(url: string): string {
  return run("curl", ["-fsSL", "--max-time", "300", "--retry", "5", "--retry-all-errors", "--retry-delay", "10", url]).stdout;
}

function loadRows(offset: number, limit: number): Row[] {
  const rows: Row[] = [];
  for (let o = offset; o < offset + limit; o += 100) {
    const length = Math.min(100, offset + limit - o);
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
      `&config=${CONFIG}&split=test&offset=${o}&length=${length}`;
    const body = JSON.parse(curlText(url)) as { rows: { row: Row }[] };
    for (const { row } of body.rows) {
      if (!row.version.startsWith("2.") || !row.hard) throw new Error(`${row.instance_id} is not a V2 HARD task`);
      rows.push(row);
    }
  }
  return rows;
}

// One bare clone per repository; each run gets its own worktree at the base commit.
// V2's before_repo_set_cmd applies the test patch, so it is not run here: the agent must not see the tests.
function bareRepo(repo: string): string {
  const dir = join(OUT, "repos", `${repo.replace("/", "__")}.git`);
  if (!existsSync(dir)) run("git", ["clone", "--bare", `https://github.com/${repo}.git`, dir]);
  return dir;
}

function checkout(bare: string, commit: string, dir: string) {
  mkdirSync(dirname(dir), { recursive: true });
  run("git", ["--git-dir", bare, "worktree", "add", "--detach", dir, commit]);
}

function patchOf(dir: string, commit: string): string {
  run("git", ["add", "-A"], dir);
  return run("git", ["diff", "--cached", commit], dir).stdout;
}

function teardown(bare: string, dir: string) {
  try {
    run("git", ["--git-dir", bare, "worktree", "remove", "--force", dir]);
  } catch {
    // already gone
  }
}

// One agent thread: a fresh query with its own cost and turn count, like a thread in the notebook.
async function runThread(
  role: Thread["role"],
  model: Model,
  prompt: string,
  dir: string,
  ac: AbortController,
  extra: QueryOptions,
): Promise<Thread> {
  let final: Extract<SDKMessage, { type: "result" }> | undefined;
  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: dir,
        pathToClaudeCodeExecutable: CLAUDE_CLI,
        model: model.id,
        effort: model.effort,
        permissionMode: "bypassPermissions",
        settingSources: [], // no project settings or CLAUDE.md from the repository
        abortController: ac,
        ...extra,
      },
    })) {
      if (msg.type === "result") final = msg;
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  }
  const result = final;
  if (!result) {
    return { role, model: model.id, status: ac.signal.aborted ? "timeout" : "no-result", costUsd: 0, turns: 0, text: "" };
  }
  return {
    role,
    model: model.id,
    status: result.subtype,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    text: result.subtype === "success" ? result.result : "",
    error: result.subtype === "success" ? undefined : result.errors.join("; "),
  };
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

// The combo arm: the orchestrator's only tool runs one worker in the same repository and returns its report.
async function runCombo(arm: Arm, prompt: string, dir: string, ac: AbortController): Promise<Thread[]> {
  const workers: Thread[] = [];
  const spent = { usd: 0 };
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const server = createSdkMcpServer({
    name: "team",
    version: "1.0.0",
    tools: [
      tool(
        "delegate_to_worker",
        "Hand one sub-task to a worker. The worker reads, edits, and tests code in the repository and sends its report back as this tool's result.",
        { subtask: z.string().describe("One focused sub-task: the files, functions, and expected behavior") },
        async ({ subtask }) =>
          oneAtATime(async () => {
            if (spent.usd >= RUN_BUDGET_USD) {
              return textResult("The worker budget is spent. Finish with the changes you have.");
            }
            const worker = await runThread("worker", arm.worker as Model, subtask, dir, ac, {
              systemPrompt: WORKER_SYSTEM,
              tools: TOOLS,
              maxBudgetUsd: Math.max(0.01, RUN_BUDGET_USD - spent.usd),
            });
            spent.usd += worker.costUsd;
            workers.push(worker);
            return textResult(worker.text || "The worker stopped without a report. Delegate this sub-task again.");
          }),
      ),
    ],
  });
  const orchestrator = await runThread("orchestrator", arm.main, prompt, dir, ac, {
    systemPrompt: ORCHESTRATOR_SYSTEM,
    tools: [], // no built-in tools: the orchestrator can only delegate
    mcpServers: { team: server },
    allowedTools: ["mcp__team__delegate_to_worker"],
    maxBudgetUsd: RUN_BUDGET_USD,
  });
  return [orchestrator, ...workers];
}

// Same layout patch_replay reads: jobs/sbp-v2-<arm>/<instance_id>/{result.json, agent/model.patch}.
function saveJob(slug: string, instanceId: string, meta: Meta, patch: string) {
  const dir = join(OUT, "jobs", `sbp-v2-${slug}`, instanceId);
  mkdirSync(join(dir, "agent"), { recursive: true });
  writeFileSync(join(dir, "agent", "model.patch"), patch);
  writeFileSync(join(dir, "result.json"), JSON.stringify(meta, null, 2));
}

async function runTask(arm: Arm, row: Row, instruction: string): Promise<Meta> {
  const bare = bareRepo(row.repo);
  const dir = join(OUT, "trees", arm.slug, row.instance_id);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIME_LIMIT_MIN * 60_000);
  const started = Date.now();
  const prompt = `${instruction}\n\nIn this run the repository is your current working directory, not /app.`;
  const meta: Meta = {
    task_name: row.instance_id,
    arm: arm.slug,
    status: "error",
    costUsd: 0,
    turns: 0,
    minutes: 0,
    delegations: 0,
    threads: [],
  };
  let patch = "";
  try {
    checkout(bare, row.base_commit, dir);
    meta.threads = arm.worker
      ? await runCombo(arm, prompt, dir, ac)
      : [await runThread("solo", arm.main, prompt, dir, ac, { tools: TOOLS, maxBudgetUsd: RUN_BUDGET_USD })];
    meta.status = meta.threads[0].status;
    meta.costUsd = meta.threads.reduce((s, t) => s + t.costUsd, 0);
    meta.turns = meta.threads.reduce((s, t) => s + t.turns, 0);
    meta.delegations = meta.threads.filter((t) => t.role === "worker").length;
    meta.error = meta.threads.find((t) => t.error)?.error;
    patch = patchOf(dir, row.base_commit);
  } catch (err) {
    meta.error = String(err);
  } finally {
    clearTimeout(timer);
    meta.minutes = (Date.now() - started) / 60000;
    saveJob(arm.slug, row.instance_id, meta, patch);
    teardown(bare, dir);
  }
  return meta;
}

async function generate(arm: Arm, rows: Row[]) {
  for (const row of rows) {
    const instruction = curlText(`${TASKS_BASE}/${row.instance_id}/instruction.md`);
    const meta = await runTask(arm, row, instruction);
    console.log(
      `[${arm.slug}] ${row.instance_id}  ${meta.status}  $${meta.costUsd.toFixed(2)}  ` +
        `${meta.minutes.toFixed(1)} min  delegations ${meta.delegations}`,
    );
  }
}

function plan(rows: Row[]) {
  console.log(`dataset ${DATASET}, config ${CONFIG} (V2 HARD): ${rows.length} tasks from offset ${OFFSET}`);
  console.log(`output: ${OUT}   per-run budget: $${RUN_BUDGET_USD}   time limit: ${TIME_LIMIT_MIN} min per task`);
  for (const arm of ARMS) {
    const who = arm.worker
      ? `orchestrator ${arm.main.id} (${arm.main.effort}), workers ${arm.worker.id} (${arm.worker.effort})`
      : `alone: ${arm.main.id} (${arm.main.effort})`;
    console.log(`  ${arm.slug}  ${who}`);
  }
  for (const r of rows) console.log(`  ${r.instance_id}  ${r.repo}  ${r.base_commit.slice(0, 10)}`);
  console.log(`prompt: ${TASKS_BASE}/<instance_id>/instruction.md`);
  console.log("plan only: no clones and no model calls");
}

function summary() {
  for (const arm of ARMS) {
    const dir = join(OUT, "jobs", `sbp-v2-${arm.slug}`);
    if (!existsSync(dir)) continue;
    const metas: Meta[] = readdirSync(dir).map((id) => JSON.parse(readFileSync(join(dir, id, "result.json"), "utf8")));
    const cost = metas.reduce((s, m) => s + m.costUsd, 0);
    const minutes = metas.reduce((s, m) => s + m.minutes, 0);
    const notSuccess = metas.filter((m) => m.status !== "success").length;
    console.log(
      `${arm.slug.padEnd(36)} tasks ${metas.length}  cost $${cost.toFixed(2)}  ` +
        `mean $${(cost / metas.length).toFixed(2)}  minutes ${minutes.toFixed(1)}  not success ${notSuccess}`,
    );
  }
}

async function main() {
  if (args.includes("--summary")) return summary();
  const rows = loadRows(OFFSET, LIMIT);
  if (args.includes("--plan")) return plan(rows);
  const slug = arg("--arm", "");
  const arm = ARMS.find((a) => a.slug === slug);
  if (!arm) throw new Error(`pick one arm with --arm: ${ARMS.map((a) => a.slug).join(", ")}`);
  await generate(arm, rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
