# Design

Why Ares is built the way it is. The README says what it does; this file says why.

## The problem

One model, reading code once, misses most bugs. We saw this on a real codebase: a paid multi-agent review found 10 real problems that a single-pass security review of the same code had missed 8 of. The 8 were missed for three reasons:

- **The reviewer had written the code.** It had already decided the risky parts were safe.
- **The review looked for security only.** It skipped anything that wasn't an attack: wrong totals, races, false messages, and abuse of open endpoints.
- **It traced each request alone.** Nothing checked two actions meeting, promises the code made, or what the tests hid.

Every part of Ares exists to fix one of these.

## What the research says

Ares was rebuilt after reading the published evidence on how models find real bugs. Each source changed something.

| Source | What it found | What Ares does |
| --- | --- | --- |
| Anthropic, "Using LLMs to secure source code" (2026), and its reference harness | Split the code into parts first, or parallel agents find the same shallow bugs. Long checklists make discovery worse. Finding and checking need different agents. A threat model cuts false reports more than anything else. | A recon pass splits the code. Hunter briefs are short and describe a kind of bug, not a checklist. Hunters report anything plausible; separate agents verify. Every agent reads the threat model. |
| ABSENTIA (arXiv 2610.00977) | On access-control bugs, the same model found 3 of 30 when it explored freely and 18 of 30 when sent through the code one route at a time. Asking it to state what a route must guarantee, then break that, cut false reports by a third. | Each hunter gets its entry points and their guarantees, and tries to break them. Hunters note what each part allows, so a later pass can find bugs that need two parts. |
| Cloudflare, "Project Glasswing" (2026) | Many narrow tasks beat one agent trying to cover everything. A second agent with a different prompt, that can't raise its own findings, removes much of the noise. Re-check what hunters touched but didn't cover. | One task per part and per kind of bug. Verifiers only verify. A final pass takes the spots hunters said they covered thinly. |
| OpenSSF, "Finding and Fixing Vulnerabilities Using AI" | Agreement between AI reviewers isn't proof. Ten reviewers once agreed on a bug that didn't exist; one test run disproved it. A proof must fail for the stated reason, pass on harmless input, and stop failing once the bug is fixed. | A bug counts as proven only by a failing test with a passing control. A bug argued from code alone needs two more votes and is labelled as argued. |
| SecPRBench (arXiv 2610.33509) | On 265 real bug-introducing changes, the best agents found about 3 in 4. In 68% of misses the agent was in the right file but gave the wrong cause. Logic bugs were found half the time. A tool that fans out found more; one that holds back found less. | Verifiers judge a finding as written, and report a nearby real bug separately. Ares leans towards reporting and lets verification remove the noise. |
| Semgrep, coding agents on web apps (2025) | The same prompt on the same code finds different bugs each run. | `again` runs once more and skips what the last run found. |

## Decisions

**Review code as it stands, not changes.** A change review assumes the old code is right and says nothing about code that didn't change. Ares reviews every file you name, however old.

**Plain code around the agents.** Anything that must be exact is done in plain code, not by a model following instructions: building the snapshot, checking options, comparing the map with the real file list, re-running proofs, auditing what agents touched, and writing the report. Models do the reading and reasoning.

**A snapshot, not your checkout.** Agents work in a copy of your repository with no history, no remote and no untracked files. They can't see earlier reviews, your notes or half-finished edits. Inside the copy are two commits: everything else, then the files under review. That split exists only so outside tools can be pointed at exactly those files.

**Recon, then hunters, then a combining pass.**
1. One agent maps the code into 3 to 8 parts, each with its files, entry points and what it must guarantee. A second agent looks for entry points the map missed. Plain code then checks the map against git's file list, and any file it left out gets a part of its own.
2. One hunter per part tries to break its guarantees. Seven more each look for one kind of bug across all the code: untrusted input, actions colliding over time, promises not kept, failures and limits, numbers and money, the database, and what tests hide.
3. A final hunter gets what each part allows and where hunters were thin, and looks for bugs that only appear when parts combine.

**Short briefs.** Each kind of bug is described in one paragraph: what it looks like, not where to look. Long checklists make models match the checklist instead of reading the code.

**Finding and verifying are separate.** Hunters are told to report anything plausible. Verifiers are told to assume each finding is wrong and try to prove it. An agent asked to do both drops real bugs.

**A failing test is the proof.** A verifier writes a test that fails because of the bug, plus one that passes, so a broken setup can't pass as proof. Plain code runs each proof twice: the file must load, one test must fail, one must pass, and both runs must agree. A database finding is proven with a script against a real Postgres. A finding about a running server is proven against a local copy of the app.

**More votes only when needed.** A finding with a proof that holds is settled by one verifier. A finding argued from code gets two more: one checks whether it can really happen, the other whether something already stops it. Two of three decide. The panel can lower a severity, never raise it.

**Salvage.** Most misses are the right place with the wrong explanation. When a verifier rejects a finding but sees the real bug next to it, that bug is verified on its own.

**Severity from what must already be true.** A verifier lists the preconditions first: a role, a setting, a timing. Severity follows from those, not from how alarming the code looks. Between two levels, the lower one wins.

**Every tool is checked by Ares agents.** Claude Security, other companies' models, and the scanners all feed findings or leads into the same verification. Nothing reaches the report on another tool's word alone.

**Scanners give leads, not findings.** Pattern scanners are noisy. Their flags go to hunters to check against the code. Committed secrets and vulnerable dependencies are facts, so they go straight into the report.

**Other companies' models.** Every Ares agent is Claude, so a mistake Claude tends to make could pass both the hunter and the verifier. Codex and Gemini hunt too when they're installed and signed in. This sends the reviewed code to those companies, so it only happens if you've set those tools up.

**Claude Security runs unmodified.** Its licence allows running it but not copying it, so Ares runs it in its own session inside the snapshot and reads its results file. Its workflow isn't called directly, because it changes between releases.

**Blind runs.** For measuring Ares against a known answer, `blind` leaves out the threat model and past lessons, since a person who knew the answers may have written them.

**Memory.** `lessons.md` holds kinds of bugs found in a project before, and `accepted.md` holds behaviour the owner has decided is intended. Each finding has a stable id, so a report says which findings are new.

## How blind a run is

Three things keep agents from seeing earlier findings:
- **The snapshot** has no history and no link to your repository, and no prompt contains a path into it. A test checks this.
- **The kit copy** agents read contains only their briefs, never this file or the README.
- **An audit after the run** reports any tool call that went outside the snapshot, to earlier reviews, or to the network.

One thing is not enforced: an agent could still read any file on the machine if it went looking. Stopping that needs an operating-system sandbox. The audit is the check that it didn't happen.

## Cost

A full review runs roughly 45 to 80 agents on about 3,000 lines of code, and about twice that with `thorough`. That is an estimate from the workflow's shape. On a Claude plan this uses your plan's allowance rather than money. Every run records the tokens it used.

Lighter runs: `quick` (Ares agents only), `votes=1`, `no-chain`, or a smaller set of folders.

## Measuring it

`/ares selftest` runs Ares blind on a small shop with eight planted bugs, then scores the report against an answer key that agents never see. A bug only counts if Ares gives the right cause; the right file isn't enough.

The planted bugs cover the kinds Ares hunts for: reading other users' data, a role check that lets the wrong role in, path traversal, rounding that loses money, an expiry check that is always true, an off-by-one in paging, a refund that can be paid twice, and a failure after payment that tells the customer they weren't charged.

## Known gaps

- **Hosted services can't be tested.** Ares has a real Postgres and a local copy of the app, but not third-party services. Findings that depend on them are argued, and say so.
- **Verification is still Claude.** Other models hunt; only Claude verifies.
- **Unwritten intent.** Ares checks guarantees that are written down or that recon can infer. A threat model closes most of this gap.
- **Absence can't be proven.** A clean report means nothing was found. Runs vary, and the research puts the miss rate for logic bugs near half for one pass.
- **Coverage and mutation testing need Vitest today.** Proving tests work with Vitest, Jest, pytest and Node's test runner.
