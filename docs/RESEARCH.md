# Research notes: nine papers and what Kronos took from them

These notes cover the nine papers in the reading list that came with the request (agent
evaluation, agentic AI surveys, harness self-improvement and multi-agent organisation). For each
one: what it says, how it was read, and what changed in Kronos because of it.

**How they were read.** The sandbox this work was done in cannot reach arxiv.org,
huggingface.co or link.springer.com, so no full PDF was read. Sources were the papers' abstracts
and listings found through web search, third-party summaries, and — for Harness², RRSI and
Agensh — the authors' GitHub repositories (READMEs, `REPRODUCE.md`), which describe the methods in
implementable detail. Figures quoted below come from those sources; where a figure appeared only
in secondary coverage it is marked as such. Paper 3 could only be identified through an
automated literature-scan listing, so it is summarised with that caveat.

---

## 1. Agents Are Systems, Not Models: Rethinking Agentic Evaluation

Wiedmann, Girrbach, Schmid, Akata — arXiv:2610.01618 (Oct 2026).

**What it says.** Evaluations treat "the agent" as a fixed object, but users configure it: what
to tell it, how long to let it run, which model to use. The authors vary five parameters — task
information, reasoning, self-verification, time budget and backbone model — for a coding agent
that must find and operate published specialist models on four scientific tasks.

- About **54 % of outcome variance comes from repeating the same configuration**, not from
  changing it.
- **Information matters most**: more task information outweighed both time budget and model
  size, and also lowered cost and improved calibration.
- Extra time only helps when the agent has enough information or a strong enough model.
- **Prompting an agent to verify barely changed its behaviour; a dedicated verification tool
  changed it substantially** — some behaviours belong in the system, not in the prompt.
- The benchmark and 18,000+ trajectories are released.

**What Kronos does with it.**
- A **`verify` tool** (`packages/core/src/tools/shell.ts`) runs the project's own checks and
  returns PASS/FAIL per check with the failing lines first.
- **Project checks are detected and given to the agent as information**
  (`agent/checks.ts`: package.json scripts with the right package manager, pyproject, Cargo,
  go.mod, Deno, Gemfile, Mix, Maven, Gradle, Makefile targets) and listed in the system prompt.
- **Verification is enforced by the harness, not requested by the prompt**: if a run changed
  files and never ran `verify` afterwards, the loop asks once for verification before the run may
  end (`agent.verifyBeforeFinish`, on by default; only when the project has checks).
- **`kronos eval` repeats every case** and reports the spread next to the mean — see paper 2.

## 2. Large Language Model Agent Evaluation and Benchmarking: A Systematic Survey, Meta-Taxonomy, and Critical Research Roadmap

Nageshwaran, Ezekiel, Tran, Narasimhan — *Artificial Intelligence Review*,
doi:10.1007/s10462-026-11678-4 (Sep 2026, open access).

**What it says.** A PRISMA-ScR mapping review of 259 primary studies (294 in the living corpus).
Its central claim: a benchmark score only means something relative to *which capability* it
measures, *how* it is scored and *where* the agent is tested. It proposes a "dependent-step
test" to tell agentic evaluation (steps depend on earlier actions) from static NLP evaluation,
and a meta-taxonomy with three pillars: capability, scoring paradigm and environment topology.

**What Kronos does with it.** `kronos eval` (`packages/core/src/eval/runner.ts`) makes all three
pillars explicit in a suite file: the **environment** is a fresh workspace built from fixture
files in an isolated runtime (no memory, skills or sessions leak between runs); **scoring** is a
list of typed checks (answer contains / regex, file exists / contains, a shell command that must
pass, a tool-call ceiling); the **configuration** is a model × effort matrix. Reports include
pass rate, its standard deviation across repeats, tokens, cost, time and tool calls per run —
never a single number on its own.

## 3. A Critical Assessment of the Rise of Agentic AI, Its Capabilities, Task Domains and Open Challenges

Listed as Khan, Aljuaid, Ning — *Discover Artificial Intelligence*,
doi:10.1007/s44163-026-02342-5 (Oct 2026). **Identified only through an automated listing; the
abstract shown there belonged to another paper, so treat this summary as unverified.**

**What it says (per the listing and closely related reviews).** A broad survey organised around
capability areas (text, code, media generation, reasoning, retrieval, robotics, multimodal
agency). The recurring open challenges across this literature: reliability and evaluation that
resists metric gaming, coordination costs as agent counts grow, accountability when several
agents contribute to an outcome, fragmented terminology, and new security risks; and the central
tension that more autonomy buys speed and adaptability at the cost of predictability,
auditability and control.

**What Kronos does with it.** That tension is the design brief for the governance pieces:
self-modification is bounded and reversible (skill admission gate, edit budget, history and
rollback — paper 6/9), every autonomous step stays auditable (sessions, usage log, checkpoints,
undo), and multi-agent work leaves a shared, inspectable record (the team board — paper 7).

## 4. From Language Models to Agentic AI: A Survey of Autonomous, Action-Enabled, and Collaborative LLM Agents

Bajoria, Hassija, Chamola, Hussain et al. — *Cognitive Computation* 18:103,
doi:10.1007/s12559-026-10619-1 (Aug 2026). Read: abstract and front matter.

**What it says.** A deployment-oriented survey with a modular reference architecture and a
four-dimensional taxonomy — **autonomy, tool use, collaboration, safety-governance** — that
compares single-agent, tool-augmented and multi-agent frameworks, their trade-offs and recurring
failure modes, and argues for evaluation beyond static benchmarks (behaviour, robustness,
grounding, cost).

**What Kronos does with it.** The taxonomy is used to map Kronos's architecture
(`docs/ARCHITECTURE.md`, "Design map"), which made two gaps visible: collaboration had no shared
state between parallel agents (now the team board) and governance had no control over the
agent's own self-modification (now skill governance).

## 5. Harness²: Recursive Agent Harnessing for an Open World

Google Cloud AI Research & Northwestern — arXiv:2610.14224 (Oct 2026); code:
`google-research/harness2` (Apache-2.0). Read: abstract summaries and the repository README.

**What it says.** Improve the *harness* around a frozen model — system prompt, guardrails,
memory, tool guidance, subagents, skills, scripts, plugins — rather than the weights. Two levels
of recursion:
- **Task level: Propose–Probe–Compose.** An editor proposes general and domain-specific harness
  edits, the candidates are run on the same task, and a composer merges what the contrastive
  evidence supports — without ground-truth verifiers. Parallel mode explores K candidates
  at once; sequential mode refines K times.
- **Harnessing level.** A persistent improvement harness keeps adopted harnesses and
  evidence-backed lessons from every task to guide later refinement.

The README reports gains of up to 11.5 points (WorkBuddy-Bench), 4.5 (JobBench) and 11.8 pp
(Harvey LAB partial pass rate) for GLM-5 and Gemini 3.5 Flash from a single step.

**What Kronos does with it.**
- **Codemaster** now follows Propose–Probe–Compose for non-obvious decisions: propose two or
  three candidates, probe them cheaply side by side (spikes, failing tests, measurements — in
  parallel through `delegate` when independent), compose what the evidence supports
  (`codemasterDirective` in `agent/agent.ts`).
- The harnessing level maps onto Kronos's skills: evidence-backed lessons persist as skills,
  now with governance (paper 6).

## 6. RRSI: Regularized Recursive Self-Improvement of Agent Harnesses

Google Cloud AI Research, UNC, Stanford, WashU — arXiv:2609.24972 (Sep 2026); code:
`google-research/rrsi`. Read: abstract summaries and the repository README.

**What it says.** Evolving a harness on a fixed task set works but **overfits**: gains shrink or
vanish out of distribution. RRSI keeps the edit space open but regularises the search:
- **Proposer**: an annealed **edit budget** caps how many edits one candidate may bundle; the
  proposer is conditioned on the full edit history so **a falsified hypothesis is not redrawn**;
  stalls redirect search to components never exercised.
- **Selector**: a **critic** screens candidates for suite-specific logic (regex denylist + LLM
  review); gains inside the noise band are rejected; **added tokens must be paid for by measured
  gain**; non-compensatory guards.
- **Pruner**: components that stop helping are removed.

Reported (README, frozen Claude Opus 4.8): Terminal-Bench 2.1 74.2 → 80.2, SWE-bench Verified
82.0 → 83.8, plus gains on held-out workspace and engineering suites; the abstract reports up to
+14.1 on the evolve split, up to +4.7 out of distribution, and 30 % fewer policy tokens than
unregularised evolution.

**What Kronos does with it — skill governance** (`skills/registry.ts`, `tools/agentic.ts`):
- **Admission critic.** Skills the agent writes must be reusable: bounded size, a description
  that says when to use the skill, no secrets, **no task-specific values** (temporary paths,
  session/run ids, long hashes, throwaway workspace names — the harness analogue of
  suite-specific logic), and not a duplicate of an existing skill.
- **Edit budget.** Each session may create or change at most `skills.editBudget` skills
  (default 3); the count is stored in the session so a rebuilt agent does not reset it.
- **History.** Every update, patch and delete snapshots the previous version (20 kept per skill);
  `rollback` restores any version, including deleted skills.
- **Falsified changes are not redrawn.** A rollback records what it undid; proposing that exact
  content again is rejected.
- **Pruning.** Outcomes of runs that used each skill are recorded (clean finish with no failed
  verification = ok). Agent-written skills that were never used, went unused for
  `skills.staleAfterDays`, or fail more often than they succeed are offered for review
  (`kronos skills prune`, the Skills page) — removal stays restorable.

## 7. Agensh: Scaling Organizational Intelligence to 1,024 Agents

Zhan, Song, Dong, Huang, Lian, Xia, Wei (Microsoft) — arXiv:2609.26781 (Sep 2026); code:
`microsoft/Agensh`. Read: abstract summaries, the README and `REPRODUCE.md`.

**What it says.** A multi-agent harness with **no central orchestrator**: concurrent workers
gather context, **claim and self-assign sub-tasks**, act, share findings, verify, and merge
asynchronously through a shared workspace, a message interface and shared context (a board
service handles "shared context and work claims"). Pandoc build test pass rate rises from
33.89 % with one agent to 55.06 % with 1,024 agents in six hours offline; on the five hardest
ProgramBench tasks, 1 → 128 agents raises mean pass rate from 19.31 % to 28.78 %. As the
organisation grows, cooperation emerges: peer coordination, then integration across workers,
standardised workflows and specialised roles. The reproduction notes add the operational side:
idle watchdogs, sealed archives, and checking for incomplete results before trusting a score.

**What Kronos does with it — the team board** (`agent/board.ts`, `team_board` tool): when
`delegate` starts two or more subagents they form a team with a shared board instead of
reporting only to the parent. Each member's own task is pre-claimed; members **read** the board,
**post** what others need (interfaces, decisions, discovered facts, files they are changing),
**add** and **claim** extra work (claiming another member's item fails, so nobody duplicates
work) and mark items **done**. Posts appear live on the subagent cards in the UI, and the parent
receives the board with the subagents' reports.

## 8. A Team of Gemini 4 Argon Agents Beats Minecraft

Faldor, Singh, Raileanu (Google DeepMind) — arXiv:2610.22319 (Oct 2026). Read: abstract and
secondary coverage.

**What it says.** Four agents in a survival world with one goal — defeat the Ender Dragon —
controlling players through Mineflayer by writing and running short JavaScript programs. No one
assigned roles or wrote game logic. From a random Easy world they wrote 2,783 programs and won in
27 h 14 min, dying 605 times. They coordinated through in-game chat and a shared memory; coverage
reports only 229 chat messages in the whole run (secondary source), with information flowing
mostly through code and shared memory. Caveats: Easy difficulty, privileged API information,
a single run.

**What Kronos does with it.** Two confirmations of the board design: coordination should be
**sparse and shared-state-centred** (a board of items and short posts rather than chatter), and
long-horizon autonomy runs on **actions-as-programs** plus persistence — which Kronos already
has (`execute_code`, `shell`, skills as stored procedures, cron for long-running goals).

## 9. Self-Evolving Agent Harness

Wei, Guan, …, Shen — arXiv:2610.18813 (Oct 2026). Read: abstract and summaries; a conceptual and
theoretical paper.

**What it says.** Harness self-evolution revises prompts, memory, workflows and executable
components while the model stays fixed, and accepted revisions persist. The paper separates
*what* is updated from *how* proposals are generated and admitted, models search as
evolutionary optimisation and analyses reliability with continual PAC learning: an expected
generalisation bound, a **retention bound tied to historical regression budgets**, and a
high-probability **admission rule on fresh validation data** — a candidate replaces the
incumbent only if it beats it on new tasks by more than a confidence margin; if nothing passes,
**the incumbent stays**. It stresses continual validation and independent safeguards for
learning, privileges and consequential actions.

**What Kronos does with it.** The skill **admission gate** and **incumbent-by-default** behaviour:
a change that is not admitted leaves the current skill untouched; every admitted change keeps the
previous version so any regression can be undone; and `kronos eval` provides the fresh,
repeated validation runs needed to compare a harness change against the incumbent before
adopting it.

---

## Summary of changes

| Finding | Paper(s) | Kronos change | Where |
|---|---|---|---|
| A verification *tool* changes behaviour; a prompt does not | 1 | `verify` tool; harness asks for verification before finishing | `tools/shell.ts`, `agent/agent.ts` |
| Information beats budget | 1 | Project checks detected and put in the prompt | `agent/checks.ts`, `agent/prompt.ts` |
| Same config, very different runs; scores depend on capability, scoring, environment | 1, 2 | `kronos eval`: repeats, spread, isolated runtimes, typed checks, config matrix | `eval/runner.ts`, `cli/main.ts` |
| Propose–Probe–Compose | 5 | Codemaster workflow | `agent/agent.ts` |
| Self-improvement overfits without regularisation | 6, 9 | Skill admission gate, edit budget, history + rollback, no redraw of rolled-back changes, pruning | `skills/registry.ts`, `tools/agentic.ts`, `runtime.ts` |
| Decentralised teams scale through shared state and claims | 7, 8 | Team board for delegated subagents | `agent/board.ts`, `tools/agentic.ts` |
| Autonomy vs. control | 3, 4 | Governance kept bounded, reversible and auditable; architecture mapped to autonomy · tool use · collaboration · safety-governance | `docs/ARCHITECTURE.md` |
