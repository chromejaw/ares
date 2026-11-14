#!/usr/bin/env node
// Finishes a /ares run in plain code:
//   1. rebuilds the workflow's result from the run's journal (no hand-copied JSON);
//   2. re-runs every proving test, twice, and demotes any that doesn't hold;
//   3. audits the agents' tool calls for anything outside the snapshot (the blindness check);
//   4. works out which files under review no hunter opened, and what the run used;
//   5. writes the report, the JSON and the proving tests, and removes the snapshot.
//
// Usage:
//   node finish.mjs --prep <folder made by prepare.mjs> --transcripts <run's transcript dir> --dest <output folder> [--keep]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WORKFLOW, runWorkflow, journalAgent, recheckTest, readTranscripts, auditBlindness, neverOpened, totalUsage } from './lib.mjs'

const die = (msg) => { console.error(`ares finish: ${msg}`); process.exit(1) }
const opt = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '')
  if (name === 'keep') opt.keep = true
  else if (['prep', 'transcripts', 'dest', 'fail-on'].includes(name)) opt[name] = argv[++i]
  else die(`unknown option ${argv[i]}`)
}
for (const k of ['prep', 'transcripts', 'dest']) if (!opt[k]) die(`--${k} is required`)
const SEVS = ['critical', 'high', 'medium', 'low']
if (opt['fail-on'] && !SEVS.includes(opt['fail-on'])) die(`--fail-on must be one of ${SEVS.join(', ')}`)

const prep = path.resolve(opt.prep)
const read = (f) => JSON.parse(fs.readFileSync(path.join(prep, f), 'utf8'))
const args = read('args.json')
const meta = read('meta.json')
if (meta.tool !== 'ares') die(`${prep} was not made by prepare.mjs`)
const journal = path.join(opt.transcripts, 'journal.jsonl')
if (!fs.existsSync(journal)) die(`no journal at ${journal}`)

// ---- 1. the result ----
const replay = journalAgent(journal)
const logs = []
const result = await runWorkflow(args, replay.agent, { file: WORKFLOW, onLog: (m) => logs.push(m) })
const incomplete = replay.unknown.length
  ? `The run did not finish: ${replay.unknown.length} agents the workflow needed have no recorded start (${[...new Set(replay.unknown)].slice(0, 6).join(', ')}). This result is partial.`
  : null

// ---- 2. proving tests ----
const snap = args.root
const proofs = []
if (args.test_cmd || args.db || args.app) {
  for (const f of [...result.confirmed]) {
    if (!f.proven_by_test) continue
    const check = f.test_file ? recheckTest({ snap, testCmd: args.test_cmd, file: f.test_file }) : { holds: false, why: 'the verifier named no test file' }
    proofs.push({ id: f.id, title: f.title, test_file: f.test_file, ...check })
    f.proof_recheck = check.why
    if (check.holds) continue
    f.proven_by_test = false
    // A finding settled by one verifier's test alone has nothing left to stand on.
    if (f.votes.filter((v) => v.startsWith('confirmed')).length < 2) {
      result.confirmed = result.confirmed.filter((x) => x !== f)
      result.unproven.push({ ...f, verification: `The proving test did not hold when re-run (${check.why}). One verifier confirmed it on that test alone, so it needs a second look. Original: ${f.verification}` })
    }
  }
}

// ---- 3 and 4. transcripts ----
const agents = readTranscripts(opt.transcripts)
const outside = auditBlindness(agents, { repo: meta.repo, allowed: [prep] })
const unopened = neverOpened(agents, args.files || [])
const usage = totalUsage(agents)

// A stable id per finding, so the same problem can be recognised from one run to the next even when lines move.
const fingerprint = (f) => createHash('sha256').update(`${f.file}|${String(f.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 12)
for (const list of [result.confirmed, result.unproven]) for (const f of list) f.fingerprint = fingerprint(f)
// Which confirmed findings were already in an earlier report for this project and scope name?
const destDir = path.resolve(opt.dest)
const earlier = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter((n) => n.startsWith(`ares-${meta.slug}-`) && n.endsWith('.json')).sort((x, y) => fs.statSync(path.join(destDir, x)).mtimeMs - fs.statSync(path.join(destDir, y)).mtimeMs) : []
const seenBefore = new Map()
for (const n of earlier) { try { for (const f of JSON.parse(fs.readFileSync(path.join(destDir, n), 'utf8')).confirmed || []) if (f.fingerprint && !seenBefore.has(f.fingerprint)) seenBefore.set(f.fingerprint, n.replace(/\.json$/, '')) } catch { /* not one of ours */ } }
for (const f of result.confirmed) f.first_seen = seenBefore.get(f.fingerprint) || null

// ---- 5. output ----
const now = new Date()
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
let name = `ares-${meta.slug}-${day}`
for (let n = 2; fs.existsSync(path.join(path.resolve(opt.dest), `${name}.json`)); n++) name = `ares-${meta.slug}-${day}-${n}`
const dest = path.resolve(opt.dest)
fs.mkdirSync(dest, { recursive: true })

const scan0 = fs.existsSync(path.join(prep, 'scanners.json')) ? JSON.parse(fs.readFileSync(path.join(prep, 'scanners.json'), 'utf8')) : null
const full = {
  ...result,
  run: { ...meta, finished_at: new Date().toISOString(), incomplete, log: logs },
  scanners: scan0,
  checks: {
    proofs_rechecked: proofs,
    outside_reads: outside,
    files_no_hunter_opened: unopened,
  },
  usage,
}
fs.writeFileSync(path.join(dest, `${name}.json`), JSON.stringify(full, null, 2))

const testsDir = path.join(dest, `${name}-tests`)
const copied = []
if ((args.test_cmd || args.db || args.app) && fs.existsSync(path.join(snap, args.test_dir || 'test'))) {
  args.test_dir = args.test_dir || 'test'
  for (const f of fs.readdirSync(path.join(snap, args.test_dir)).filter((n) => n.startsWith('_dr_'))) {
    fs.mkdirSync(testsDir, { recursive: true })
    fs.copyFileSync(path.join(snap, args.test_dir, f), path.join(testsDir, f))
    copied.push(f)
  }
}

const secDir = path.join(prep, 'claude-security')
if (fs.existsSync(secDir)) fs.cpSync(secDir, path.join(dest, `${name}-claude-security`), { recursive: true })

const loc = (f) => `${f.file}:${f.start_line}${f.end_line && f.end_line !== f.start_line ? `-${f.end_line}` : ''}`
const md = []
md.push(`# Ares: ${meta.slug}, ${day}`, '')
md.push(`${meta.scope.join(', ')} at \`${meta.at_sha.slice(0, 10)}\` (${meta.at}): ${meta.files} files, ${meta.lines} lines.${meta.uncommitted ? ` ${meta.uncommitted} files in scope had uncommitted edits that were NOT reviewed.` : ''}`)
md.push(`Slices: ${result.coverage.slices.length}. Rounds: ${result.stats.rounds}. Votes: ${result.stats.votes}. Tests available to verifiers: ${meta.tests ? 'yes' : 'no'}. Threat model: ${meta.threat_model || 'none'}. Blind: ${meta.blind ? 'yes' : 'no'}.`)
const sec = meta.security_scan
md.push(`Claude Security: ${!sec ? 'not run' : sec.status === 'ran' ? `ran at ${sec.effort} effort, ${sec.findings} findings taken in and verified again here${sec.verification ? ` (its own stamp: ${sec.verification})` : ''}` : `did not produce a report (${sec.status})`}.`)
const scan = fs.existsSync(path.join(prep, 'scanners.json')) ? JSON.parse(fs.readFileSync(path.join(prep, 'scanners.json'), 'utf8')) : null
const om = meta.other_models || {}
const omLine = Object.entries(om).map(([n, x]) => `${n}: ${x.status === 'ran' ? `${x.findings} findings taken in` : x.status}`).join('; ')
md.push(`Other vendors' models: ${omLine || 'not run'}.`)
md.push(`Scanners: ${scan ? `${scan.ran.join(', ') || 'none ran'}${scan.skipped.length ? ` (skipped: ${scan.skipped.join('; ')})` : ''}` : 'not run'}.`)
const dbm = meta.database
md.push(`Real database for proofs: ${!dbm ? 'none declared by the project' : dbm.status === 'running' ? `Postgres ${dbm.version}, schema loaded` : dbm.status}.`)
const ev = meta.evidence
md.push(`Evidence gathered first: ${ev ? `type check ${ev.types}; coverage ${ev.coverage}; mutation testing ${ev.mutation}; fix history ${ev.history}` : 'not run'}.`)
md.push(`Running test bed: ${!meta.app ? 'none declared by the project' : meta.app.status === 'running' ? 'yes, hunters and verifiers could send it real requests' : meta.app.status}.`)
md.push(`Agents: ${usage.agents}. Tokens: ${usage.input + usage.cache_write + usage.cache_read} in (${usage.cache_read} from cache), ${usage.output} out.`, '')
if (incomplete) md.push(`> **${incomplete}**`, '')

const provenCount = result.confirmed.filter((f) => f.proven_by_test).length
md.push(`## Confirmed (${result.confirmed.length}, ${provenCount} proven by a failing test)`, '')
result.confirmed.forEach((f, i) => {
  md.push(`### ${i + 1}. ${f.title}  [${f.severity}]  ${loc(f)}`)
  md.push(f.first_seen ? `Still open: first reported in ${f.first_seen}. Id ${f.fingerprint}.` : `${earlier.length ? 'New since the last report. ' : ''}Id ${f.fingerprint}.`)
  md.push(`Found by: ${f.found_by.join(', ')}. Proof: ${f.proven_by_test ? `failing test \`${path.basename(f.test_file)}\`, re-run and it holds` : `argued from code, not run (votes: ${f.votes.join(', ')})`}.`)
  if (f.proof_recheck && !f.proven_by_test) md.push(`The verifier's test did not hold on re-run: ${f.proof_recheck}.`)
  if (f.comment) md.push('', f.comment)
  md.push('', `**Trigger:** ${f.trigger}`, '', `**Consequence:** ${f.consequence}`, '', `**Needs:** ${f.preconditions.length ? f.preconditions.join('; ') : 'nothing'}`, '', `**Verification:** ${f.verification}`)
  if (f.also_at.length) md.push('', `**Also at:** ${f.also_at.join('; ')}`)
  md.push('')
})
if (!result.confirmed.length) md.push('None.', '')

md.push(`## Not proven either way (${result.unproven.length})`, '')
for (const f of result.unproven) md.push(`- **${f.title}** (${loc(f)}; votes: ${f.votes.join(', ') || 'none'}). ${f.verification}`)
if (!result.unproven.length) md.push('None.')
md.push('', `## Refuted (${result.refuted.length})`, '')
for (const f of result.refuted) md.push(`- ${f.title} (${f.file}:${f.start_line}): ${f.reason}`)
if (!result.refuted.length) md.push('None.')

md.push('', '## Not covered', '')
const failedHunters = result.coverage.hunters.filter((h) => h.failed).map((h) => h.by)
md.push(`- Hunters that did not finish: ${failedHunters.length ? failedHunters.join(', ') : 'none'}.`)
md.push(`- Files under review no hunter opened: ${unopened.length ? unopened.join(', ') : 'none'}.`)
md.push(`- Findings dropped without verification: ${result.dropped_unverified.length ? result.dropped_unverified.join('; ') : 'none'}.`)
for (const t of result.coverage.thin) md.push(`- Thin (${t.by}): ${t.note}`)

if (dbm && dbm.problems && dbm.problems.length) {
  md.push('', '## The schema does not load', '', 'The project\'s database setup failed on a real Postgres, so no database finding could be run. Fix this first.', '')
  for (const p of dbm.problems) md.push(`- \`${p.file}\`: ${p.error}`)
}
if (scan) {
  md.push('', '## From the scanners', '')
  const real = scan.secrets.filter((s) => !/(^|\/)(test|tests|fixtures|__tests__)\//.test(s.file))
  md.push(`- Possible committed secrets: ${scan.secrets.length}${scan.secrets.length ? ` (${real.length} outside test folders). Values are withheld; check each and rotate any that are real.` : '.'}`)
  for (const s of scan.secrets.slice(0, 40)) md.push(`  - ${s.file}:${s.line} (${s.rule})`)
  const order = ['critical', 'high', 'moderate', 'medium', 'low', '']
  const byPkg = new Map()
  for (const d of scan.dependencies) { const k = `${d.package}@${d.version}`; if (!byPkg.has(k)) byPkg.set(k, { package: d.package, version: d.version, files: new Set(), ids: new Set(), worst: d.severity }); const x = byPkg.get(k); x.files.add(d.lockfile); x.ids.add(d.id); if (order.indexOf(d.severity) < order.indexOf(x.worst)) x.worst = d.severity }
  for (const x of byPkg.values()) { x.n = x.ids.size; x.lockfile = [...x.files].join(', ') }
  const pkgs = [...byPkg.values()].sort((a, b) => order.indexOf(a.worst) - order.indexOf(b.worst) || b.n - a.n)
  md.push(`- Dependencies with known vulnerabilities: ${pkgs.length} packages. Update these; the worst first.`)
  for (const d of pkgs.slice(0, 40)) md.push(`  - ${d.package}@${d.version}: ${d.n} ${d.n === 1 ? 'advisory' : 'advisories'}${d.worst ? `, worst ${d.worst}` : ''} (${d.lockfile})`)
  md.push(`- Code patterns flagged: ${scan.code.length}. These went to the hunters as leads; the ones that held up are among the findings above.`)
}
const evFile = path.join(prep, 'evidence.json')
if (fs.existsSync(evFile)) {
  const e = JSON.parse(fs.readFileSync(evFile, 'utf8'))
  const untested = e.coverage.items.filter((x) => x.never_loaded || x.untested_function_count)
  if (untested.length || e.mutation.total) {
    md.push('', '## How well the tests guard this code', '')
    if (e.mutation.total) md.push(`- Mutation testing: the tests noticed ${e.mutation.caught} of ${e.mutation.total} small changes made to the code (${Math.round(e.mutation.caught / e.mutation.total * 100)}%). The rest went to the hunters as lines to check by hand.`)
    for (const x of untested) md.push(x.never_loaded ? `- \`${x.file}\`: no test loads it.` : `- \`${x.file}\`: ${x.untested_function_count} of ${x.function_count} functions never run in tests.`)
  }
}
const lintFile = path.join(prep, 'db-lint.json')
if (fs.existsSync(lintFile)) {
  const lint = JSON.parse(fs.readFileSync(lintFile, 'utf8')).filter((x) => !['row-level security with no policy', 'granted to signed-in users'].includes(x.check))
  if (lint.length) { md.push('', '## What the real database says about the schema', '', 'Facts read from the loaded schema. Each is worth a look; none is a confirmed bug by itself.', ''); for (const x of lint) md.push(`- ${x.note}`) }
}
md.push('', '## Checks on the run itself', '')
md.push(`- Proving tests re-run: ${proofs.length}; held: ${proofs.filter((p) => p.holds).length}.`)
for (const p of proofs.filter((x) => !x.holds)) md.push(`  - ${p.id} ${p.title}: ${p.why}.`)
md.push(`- Tool calls outside the snapshot and kit: ${outside.length ? `${outside.length}. This run was NOT fully blind.` : 'none.'}`)
for (const o of outside.slice(0, 20)) md.push(`  - ${o.agent} (${o.tool}, ${o.why}): \`${o.call.replace(/`/g, "'")}\``)

md.push('', '## What was looked at', '')
for (const s of result.coverage.slices) {
  md.push(`- **${s.name}**: ${s.files.join(', ') || 'no files listed'}`)
  for (const e of s.entry_points) md.push(`  - ${e}`)
}
fs.writeFileSync(path.join(dest, `${name}.md`), md.join('\n') + '\n')

// The same findings as SARIF, for code-scanning dashboards and editors.
const level = { critical: 'error', high: 'error', medium: 'warning', low: 'note' }
const sarif = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'ares', informationUri: 'https://github.com', rules: result.confirmed.map((f) => ({ id: f.id, shortDescription: { text: f.title }, properties: { severity: f.severity, proven_by_test: f.proven_by_test } })) } },
    results: result.confirmed.map((f) => ({
      ruleId: f.id, level: level[f.severity] || 'warning',
      message: { text: `${f.title}. ${f.comment || f.claim}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: Math.max(1, f.start_line || 1), endLine: Math.max(1, f.end_line || f.start_line || 1) } } }],
    })),
  }],
}
fs.writeFileSync(path.join(dest, `${name}.sarif`), JSON.stringify(sarif, null, 2))

if (meta.app && meta.app.pid) { try { process.kill(-meta.app.pid, 'SIGTERM') } catch { /* already gone */ } }
if (meta.database && meta.database.status === 'running') spawnSync(path.join(meta.database.bin, 'pg_ctl'), ['-D', path.join(prep, 'pg'), '-m', 'immediate', 'stop'], { encoding: 'utf8' })
if (!opt.keep) fs.rmSync(prep, { recursive: true, force: true })

console.log(JSON.stringify({
  report: path.join(dest, `${name}.md`),
  json: path.join(dest, `${name}.json`),
  sarif: path.join(dest, `${name}.sarif`),
  tests: copied.length ? testsDir : null,
  claude_security: sec ? sec.status : 'not run',
  confirmed: result.confirmed.length,
  proven_by_test: provenCount,
  unproven: result.unproven.length,
  refuted: result.refuted.length,
  incomplete,
  proofs_that_did_not_hold: proofs.filter((p) => !p.holds).length,
  outside_reads: outside.length,
  files_no_hunter_opened: unopened.length,
  agents: usage.agents,
  tokens_out: usage.output,
}, null, 2))

// For scripts and CI: a non-zero exit when something at or above the chosen severity was confirmed.
if (opt['fail-on']) {
  const bar = SEVS.indexOf(opt['fail-on'])
  if (result.confirmed.some((f) => SEVS.indexOf(f.severity) <= bar)) process.exit(2)
}
