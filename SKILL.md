---
name: ares
description: Deep local hunt for bugs in existing code (any folders or files, as they stand), for correctness and logic as well as security. It does not review changes. A recon pass splits the code into slices; one hunter per slice and one per bug shape look for problems; a last hunter looks for combinations; then separate agents try to knock down each finding, by a failing test where they can. Plain-code steps build an isolated snapshot before the run and re-check every proof after it. Runs many agents and uses a lot of plan usage, so run it only when the user types /ares.
argument-hint: "[folders or files…] [at=<ref>] [again] [blind] [thorough] [no-security] [security=low|medium|high] [votes=1|3] [rounds=2] [shapes=a,b] [no-chain] [quick]  |  score <run.json> <reference file>  |  fix <report.json>  |  selftest"
disable-model-invocation: true
---

# /ares

Finds bugs in code as it stands. The user names folders or files and every code file in them is reviewed, however old. It never reviews "what changed": old code is not assumed to be right.

Works in any git repository. The kit is in `{KIT}`. A run uses every tool that is installed, and names the ones that aren't:
- `prepare.mjs` (plain code): builds an isolated snapshot, a kit copy and validated arguments. It then runs, each only if the project has what it needs: the **classic scanners** (Semgrep for code patterns, Gitleaks for committed secrets, OSV-Scanner for vulnerable dependencies); a **real throwaway Postgres** with the project's schema loaded, plus checks read straight from that schema; **hard evidence** (the type checker, test coverage, mutation testing with Stryker, and earlier fix commits); and the project's **test bed**, a local running copy of the app that agents can send real requests to. This step can take a few minutes.
- `security-scan.mjs` (plain code): runs Anthropic's **Claude Security** plugin, unmodified, on the snapshot in a session of its own.
- `other-models.mjs` (plain code): asks **other vendors' coding agents** (OpenAI's Codex CLI, Google's Gemini CLI) to hunt on the snapshot, if they are installed and signed in. This sends the code under review to that vendor; the user allowed that by installing and signing in to the tool.
- `ares.workflow.js`: our agents. A recon pass, one hunter per slice, seven bug-shape hunters, a chain pass, then verifiers that check our findings and everyone else's together, by a failing test or a run against the real database where they can.
- `finish.mjs` (plain code): rebuilds the result from the run's journal, re-runs every proof twice, audits what the agents touched, stops the database, and writes the report, JSON and SARIF.

A project can keep its own settings in `.ares/` at its root. All are optional:
- `project.json`: `app` (`{ "start": "<command that listens on $PORT>", "ready_path": "/health", "notes": "<file>" }`), `mutation` (`{ "files": [...] }`), `database` (`{ "engine": "postgres", "setup": ["<sql files, in order>"] }`), `default_scope` (what to review when no paths are typed), `exclude` (regular expressions for files to leave out), `test_cmd`, `test_dir`, `test_ext`, `reports_dir`, `threat_models` (`[{ "match": "<regex on paths>", "file": "<path>" }]`).
- `project.md`: how to write and run a proving test in this project.
- `lessons.md`: bug shapes found in this project before.
- `accepted.md`: behaviours the owner has looked at and decided are intended, one per bullet, so they aren't raised again.
- A `THREAT_MODEL.md` at the root is picked up when `threat_models` names none.

Without them it still runs: the test command is worked out from the project (Vitest, Jest or pytest), and there is no threat model.

Typing `/ares` is the user's go-ahead for both: the Claude Security scan (which can take tens of minutes and uses a lot of tokens) and our own workflow of roughly 45 to 80 agents (about double with `thorough`). Don't run either for any other reason.

## Rules

- **Stay blind until the run ends.** Before and during the run, don't read earlier reviews of the same code (the project's reports folder), and don't write a context file from what you know about its bugs.
- **Pass the user's options to `prepare.mjs` as flags.** Don't build the workflow's arguments by hand: `prepare.mjs` validates them and exits with an error for anything it doesn't understand. If it fails, show the user its message; don't work around it.
- **Don't fix anything.** This command reports. Fixes happen only when the user asks, each with a regression test.
- **Don't push or post.**
- If this session wrote the code under review, say so in your summary.

## Steps

1. **Work out what to review.**
   - Paths the user typed (folders or files): pass them as `--scope a,b`.
   - Nothing typed: omit `--scope`; `prepare.mjs` uses the project's `default_scope` if it has one. If it has none, prepare says so: ask the user which folders or files to review.
   - It reviews the last commit. If prepare reports uncommitted files in scope, tell the user they were not reviewed and ask whether to commit first.

2. **Run prepare**, from the repository root, with a new folder in your scratchpad as `--out`:

   ```
   node {KIT}/prepare.mjs [--scope <paths>] --out <scratchpad>/dr-<name>-<time> [flags]
   ```

   If it exits 4, the scope is too big for one run and it has printed the parts it splits into. Show the user the parts and how many runs that is; if they agree, do steps 2 to 6 once per part with `--scope <that part's paths>` and `--slug <name>-part<n>`, one after another, then give one combined summary.

   The user's words map to flags:
   | They typed | Flag |
   | --- | --- |
   | `at=<branch or commit>` | `--at <ref>` (review that commit instead of the last one) |
   | `blind` | `--blind` (no threat model, no lessons: for scoring against a known answer) |
   | `again` | `--again <newest earlier ares-<slug>-*.json for this target>` |
   | `thorough` | `--rounds 2 --votes 3 --second-model <a model other than this session's: opus if you are Fable, otherwise fable>` |
   | `no-security` | skip the Claude Security scan in step 3 |
   | `no-other-models` | skip the other vendors' agents in step 3 |
   | `no-scan` | `--no-scan` |
   | `no-db` | `--no-db` |
   | `no-evidence` | `--no-evidence` |
   | `no-app` | `--no-app` |
   | `quick` | `--no-evidence --no-scan` and skip step 3 (our hunters and verifiers only) |
   | `security=low`, `medium` or `high` | `--effort` for step 3 (default `medium`; `high` with `thorough`) |
   | `votes=1` or `votes=3` | `--votes 1` or `--votes 3` |
   | `rounds=2` | `--rounds 2` |
   | `shapes=a,b` | `--shapes a,b` |
   | `no-chain` | `--no-chain` |

   It prints the path of `args.json`, of the workflow script, and of the folder reports go in. Tell the user in a line or two what will run: the scope, files, lines, which scanners ran and which aren't installed, what the evidence step found (type flags, untested code, how many code changes the tests failed to notice), whether the test bed is up, whether a real database is up (if prepare says the schema did not load, tell the user that first: it is a finding in itself, and the run goes on without a database), which other vendors' tools are installed, whether a threat model was found, whether tests can run. If no threat model was found and the run isn't blind, say that one would cut false findings.

3. **Run the outside reviewers** on the snapshot, as one background command, and wait for it to exit; don't poll. It can take tens of minutes.

   ```
   node {KIT}/security-scan.mjs --prep <the --out folder> --effort <medium, or what the user chose> ; node {KIT}/other-models.mjs --prep <the --out folder>
   ```

   Leave out the first part for `no-security` and the second for `no-other-models`.
   - Claude Security, exit 0: its findings are now in `args.json`. Exit 2: the plugin isn't installed; tell the user the install command it printed. Exit 3: it produced no report; tell the user its one-line reason. Either way, carry on.
   - Other vendors: it prints, per tool, whether it ran, isn't installed, or failed (usually not signed in). Tell the user in one line.
   - Never run any of these on the real checkout to make up for a failure here.

4. **Call the Workflow tool** with `scriptPath` set to the workflow path prepare printed, and `args` set to the parsed contents of `args.json` as it is now (re-read it after step 3), as a JSON object, unchanged. It runs in the background and returns a transcript directory: keep that path. Wait for its notification; don't poll and don't guess its result.

5. **Run finish** when the workflow's notification arrives:

   ```
   node {KIT}/finish.mjs --prep <the --out folder> --transcripts <transcript directory> --dest <the reports_dir prepare printed>
   ```

   It writes `ares-<slug>-<date>.md`, `.json`, `.sarif` and a `-tests/` folder, stops the database and the test bed, and removes the snapshot. Add `--fail-on high` (or another severity) only if the user wants a non-zero exit for scripts. Read the `.md` it wrote.

6. **Tell the user**, shortest useful form, from that report:
   - how many were confirmed, by severity, and how many of those are proven by a failing test that held on re-run;
   - each confirmed finding in one or two lines with `file:line`, and who found it (our hunters, Claude Security, or both);
   - which tools took part and which didn't, and why: Claude Security, other vendors' agents, each scanner, the real database;
   - what the tools found on their own: committed secrets, vulnerable dependencies, how well the tests guard the code, what the real database says about the schema;
   - what was not covered: hunters that failed, files no hunter opened, thin spots, unproven findings;
   - the checks on the run itself: proofs that didn't hold, and any tool call outside the snapshot (a blind run with any is not blind: say so plainly);
   - if the report says the run did not finish, say that first;
   - where the files are, and that one run is not the whole picture: on a first review of an area, suggest `/ares <target> again`.

## Scoring against another review

`/ares score <run.json> <reference file>`: start one subagent (general-purpose, fresh context), give it `{KIT}/score.md` and the two file paths, and relay its table. Then check each `extra` against the code yourself before calling it real. Save the comparison next to the run's report as `<name>-score.md`. Only score a run made with `blind`.

## Fixing what a run found

`/ares fix <report.json>` (or "fix these" right after a run). Work through the confirmed findings, most severe first, one at a time:
1. Read the finding and check it against the current code. If it no longer applies, say so and move on.
2. Turn its proving test (in the report's `-tests/` folder) into a regression test in the project's own test folder, in the project's style. If it was only argued, write the test first. Run it and see it fail for the stated reason.
3. Make the smallest change that fixes the root cause, not the one call site. No refactoring.
4. Run that test, then the whole suite. Look for the same mistake elsewhere (the finding's "also at" list is a start) and fix those too.
5. If the user says a finding is intended behaviour, don't fix it: add a bullet to `.ares/accepted.md` saying what and why.
Commit as the project's rules say. Afterwards suggest `/ares <same scope> again` to check the fixes and look for what is left.

## Checking the tool itself

`/ares selftest`: `node {KIT}/selftest.mjs` makes a throwaway project with eight planted bugs and prints `repo`, `answers` and `reports`. Run steps 2 to 6 with that `repo` as the working directory for every command, `--scope src --blind`, and `--dest <reports>`. Don't open the answers file until the run has finished. Then score the report against it as in "Scoring against another review", and tell the user: how many of the eight were confirmed with the right cause, how many were proven by a failing test, and anything confirmed that isn't in the answers (check each against the code: the project is small, and a real extra bug is possible).

## After fixes

When findings from a run are fixed, add each one's **shape** (not the instance) to the project's `.ares/lessons.md`, and fill the `evidence` column of the area's threat model. The next run reads both.
