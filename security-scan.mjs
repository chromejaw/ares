#!/usr/bin/env node
// Runs Anthropic's Claude Security plugin, unmodified, on the snapshot that prepare.mjs made, then hands its
// findings to /ares.
//
// The plugin scans the repository its session is open in, so this starts a separate headless Claude Code session
// inside the snapshot and asks for a scan of the snapshot's head commit, which adds exactly the files under review, so the plugin scans all of them.
// That keeps the scan as blind as our own hunters, and keeps its report out of the real repository.
//
// Usage:
//   node security-scan.mjs --prep <folder made by prepare.mjs> [--effort low|medium|high] [--model <name>] [--timeout-min <n>]
// Exit codes: 0 ran and ingested; 2 the plugin is not installed; 3 the scan produced no report.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fromClaudeSecurity } from './lib.mjs'

const die = (msg, code = 1) => { console.error(`ares security-scan: ${msg}`); process.exit(code) }
const opt = { effort: 'medium', 'timeout-min': '120', 'claude-bin': 'claude' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '')
  if (!['prep', 'effort', 'model', 'timeout-min', 'claude-bin'].includes(name)) die(`unknown option ${argv[i]}`)
  if (argv[i + 1] === undefined) die(`--${name} needs a value`)
  opt[name] = argv[++i]
}
if (!opt.prep) die('--prep is required')
if (!['low', 'medium', 'high'].includes(opt.effort)) die(`--effort must be low, medium or high, not "${opt.effort}"`)
const timeoutMin = Number(opt['timeout-min'])
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) die('--timeout-min must be a number above 0')

const prep = path.resolve(opt.prep)
const argsFile = path.join(prep, 'args.json')
const metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile) || !fs.existsSync(metaFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'))
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
if (meta.tool !== 'ares') die(`${prep} was not made by prepare.mjs`)
const snap = args.root
const save = (scan) => fs.writeFileSync(metaFile, JSON.stringify({ ...meta, security_scan: scan }, null, 2))

// ---- is the plugin there? ----
const listed = spawnSync(opt['claude-bin'], ['plugin', 'list'], { encoding: 'utf8' })
const block = (listed.stdout || '').split(/\n\s*\n/).find((b) => /claude-security@/.test(b))
if (listed.error || !block || !/enabled/.test(block)) {
  save({ status: 'the plugin is not installed', effort: opt.effort })
  die('the claude-security plugin is not installed or not enabled. Install it with: claude plugin install claude-security@claude-plugins-official', 2)
}
const version = (block.match(/Version:\s*(\S+)/) || [])[1] || 'unknown'

// ---- run the scan in a session of its own, opened in the snapshot ----
const head = spawnSync('git', ['-C', snap, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
if (!/^[0-9a-f]{40}$/.test(head)) die(`can't read the snapshot's head commit in ${snap}`)
const prompt = [
  `/claude-security:claude-security scan changes --commit ${head} --effort ${opt.effort}`,
  '',
  'I understand that this scan may take a long time and use a lot of tokens, and I accept that. Scan only: do not suggest patches, and ask me nothing further.',
].join('\n')
const started = Date.now()
const run = spawnSync(opt['claude-bin'], ['-p', prompt, '--output-format', 'json', ...(opt.model ? ['--model', opt.model] : [])], {
  cwd: snap, encoding: 'utf8', timeout: timeoutMin * 60000, maxBuffer: 1 << 28,
})
fs.writeFileSync(path.join(prep, 'claude-security-session.json'), run.stdout || '')
let session = {}
try { session = JSON.parse(run.stdout) } catch { /* not JSON: keep the raw text in the file above */ }
const base = {
  effort: opt.effort,
  plugin_version: version,
  minutes: Math.round((Date.now() - started) / 6000) / 10,
  session_id: session.session_id || null,
  list_price_usd: typeof session.total_cost_usd === 'number' ? session.total_cost_usd : null,
}

// ---- collect its report ----
const dirs = fs.readdirSync(snap).filter((n) => /^CLAUDE-SECURITY-\d/.test(n)).sort()
const reportDir = dirs.length ? path.join(snap, dirs[dirs.length - 1]) : null
const jsonl = reportDir && path.join(reportDir, 'CLAUDE-SECURITY-RESULTS.jsonl')
const moveOut = () => {
  // Our own hunters must not find this report inside the snapshot.
  for (const d of dirs) {
    const to = path.join(prep, 'claude-security', d)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(path.join(snap, d), to, { recursive: true })
    fs.rmSync(path.join(snap, d), { recursive: true, force: true })
  }
}
if (!jsonl || !fs.existsSync(jsonl)) {
  moveOut()
  const why = run.error && run.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMin} minutes`
    : run.status !== 0 ? `the session exited with code ${run.status}`
    : 'the session ended without writing a results file'
  save({ ...base, status: why, said: String(session.result || run.stderr || '').slice(0, 600) })
  die(`no report: ${why}. What the session said is in ${path.join(prep, 'claude-security-session.json')}`, 3)
}

const { findings, skipped } = fromClaudeSecurity(fs.readFileSync(jsonl, 'utf8'))
let verification = null
const stamp = fs.readdirSync(reportDir).find((n) => /^CLAUDE-SECURITY-REVISION-.*\.json$/.test(n))
if (stamp) { try { verification = JSON.parse(fs.readFileSync(path.join(reportDir, stamp), 'utf8')).verification?.status || null } catch { /* leave it unknown */ } }
moveOut()

fs.writeFileSync(argsFile, JSON.stringify({ ...args, external: (args.external || []).filter((f) => f.by !== 'claude-security').concat(findings) }, null, 2))
save({ ...base, status: 'ran', findings: findings.length, skipped, verification })
console.log(JSON.stringify({ status: 'ran', effort: opt.effort, plugin_version: version, findings: findings.length, skipped: skipped.length, verification, minutes: base.minutes, list_price_usd: base.list_price_usd, report: path.join(prep, 'claude-security') }, null, 2))
