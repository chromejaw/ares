// Shared plain-code helpers for the /ares kit: running the workflow script outside Claude Code
// (to test it, and to rebuild a run's result from its journal), re-checking proving tests, and auditing transcripts.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIT_SRC = path.dirname(fileURLToPath(import.meta.url))
export const WORKFLOW = path.join(KIT_SRC, 'ares.workflow.js')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Runs the workflow script with a stand-in for agent(). `agentFn(prompt, opts)` returns what the agent would.
export async function runWorkflow(args, agentFn, { file = WORKFLOW, onLog = () => {} } = {}) {
  const src = fs.readFileSync(file, 'utf8').replace('export const meta', 'const meta')
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline() is not used by this workflow') }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', src)
  return fn(args, async (p, o) => agentFn(p, o || {}), parallel, pipeline, () => {}, onLog, { total: null, spent: () => 0, remaining: () => Infinity }, async () => null)
}

// A run's journal records every agent's label and result. Replaying them through the script rebuilds the
// script's return value exactly, without anyone copying a large JSON result by hand.
export function journalAgent(journalFile) {
  const labelOf = new Map()
  const byLabel = new Map()
  const order = []
  for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'started' && row.agentId) { labelOf.set(row.agentId, row.label); order.push(row.agentId) }
    if (row.type === 'result' && row.agentId) byLabel.set(row.agentId, row.result)
  }
  const queues = new Map()
  for (const id of order) {
    const label = labelOf.get(id)
    if (!queues.has(label)) queues.set(label, [])
    queues.get(label).push(byLabel.has(id) ? byLabel.get(id) : null)
  }
  const unknown = []
  const agent = (_prompt, opts) => {
    const q = queues.get(opts.label)
    if (!q || !q.length) { unknown.push(opts.label); return null }
    return q.shift()
  }
  return { agent, unknown, started: order.length, finished: byLabel.size }
}

// ---- findings from Claude Security ----
// Reads the plugin's CLAUDE-SECURITY-RESULTS.jsonl (one finding per line) into the shape our hunters return.
// The plugin has already put each of these before its own three-vote panel; ours verifies them again, because
// its verifiers only read and ours can prove a finding with a failing test.
export function fromClaudeSecurity(text) {
  const out = []
  const skipped = []
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    let r
    try { r = JSON.parse(line) } catch { skipped.push(`line ${i + 1}: not JSON`); return }
    const lineNo = Number(r.line)
    if (!r.title || !r.file || !Number.isInteger(lineNo) || lineNo < 1 || !r.description) { skipped.push(`line ${i + 1}: no title, file, line or description`); return }
    const conf = String(r.confidence || '').toLowerCase()
    out.push({
      title: String(r.title),
      file: String(r.file),
      start_line: lineNo,
      claim: String(r.description),
      trigger: [r.exploit_scenario, Array.isArray(r.preconditions) && r.preconditions.length ? `Needs: ${r.preconditions.join('; ')}` : (typeof r.preconditions === 'string' ? `Needs: ${r.preconditions}` : '')].filter(Boolean).join(' ') || 'not stated',
      consequence: String(r.impact || 'not stated'),
      evidence: [r.symbol ? `in ${r.symbol}` : '', r.snippet ? `\`${r.snippet}\`` : ''].filter(Boolean).join(': '),
      fix: String(r.recommendation || ''),
      confidence: ['high', 'medium', 'low'].includes(conf) ? conf : 'medium',
      by: 'claude-security',
      their_severity: String(r.severity || '').toLowerCase(),
      their_id: String(r.claudeSecurityPluginFindingId || r.id || ''),
      cwe: String(r.cwe_id || ''),
    })
  })
  return { findings: out, skipped }
}

// ---- findings from another vendor's coding agent ----
// The first JSON array in a reply, wherever it sits.
export function findingsFrom(text, by) {
  const start = text.indexOf('['); if (start < 0) return null
  for (let end = text.lastIndexOf(']'); end > start; end = text.lastIndexOf(']', end - 1)) {
    let arr; try { arr = JSON.parse(text.slice(start, end + 1)) } catch { continue }
    if (!Array.isArray(arr)) return null
    return arr.filter((f) => f && f.title && f.file && f.claim).map((f) => ({
      title: String(f.title), file: String(f.file), start_line: Number.isInteger(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : 1, claim: String(f.claim),
      trigger: String(f.trigger || 'not stated'), consequence: String(f.consequence || 'not stated'), fix: String(f.fix || ''),
      confidence: ['high', 'medium', 'low'].includes(String(f.confidence).toLowerCase()) ? String(f.confidence).toLowerCase() : 'medium', by,
    }))
  }
  return null
}

// ---- proving tests ----
// A test proves a finding only if it fails because of the bug (at least one failing assertion), has a control
// that passes, loads cleanly, and does the same thing twice.
export function recheckTest({ snap, testCmd = '', file, timeoutMs = 180000 }) {
  const rel = file.startsWith(snap) ? path.relative(snap, file) : file
  const abs = path.join(snap, rel)
  if (!fs.existsSync(abs)) return { holds: false, why: 'the test file does not exist' }
  if (path.relative(snap, abs).startsWith('..')) return { holds: false, why: 'the test file is outside the snapshot' }
  // A database proof is a shell script: it must exit 1 and print both markers, twice.
  if (/\.(db|live)\.sh$/.test(rel)) {
    const runs = []
    for (let i = 0; i < 2; i++) {
      const r = spawnSync('sh', [rel], { cwd: snap, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 })
      runs.push({ exit: r.status, timed_out: !!(r.error && r.error.code === 'ETIMEDOUT'), bug: /BUG SHOWN/.test(r.stdout || ''), control: /CONTROL OK/.test(r.stdout || '') })
    }
    const why = runs.some((x) => x.timed_out) ? 'the script timed out'
      : runs.some((x) => x.exit === 0) ? 'the script exits 0, so it shows no bug'
      : runs.some((x) => x.exit !== 1) ? 'the script failed to run (it must exit 1 when the bug shows)'
      : runs.some((x) => !x.bug) ? 'the script never printed BUG SHOWN'
      : runs.some((x) => !x.control) ? 'there is no passing control case (CONTROL OK)'
      : null
    return { holds: !why, why: why || 'shows the bug for real twice (against the database or the running test bed), with a passing control', runs }
  }
  const vitest = /vitest/.test(testCmd || '') || /^node --test\b/.test(testCmd || '')   // runners whose pass and fail counts we can read
  const runs = []
  for (let i = 0; i < 2; i++) {
    const report = path.join(os.tmpdir(), `dr-recheck-${process.pid}-${i}.json`)
    if (!testCmd) return { holds: false, why: 'no test runner was available, so a test file proves nothing here' }
    if (/^node --test\b/.test(testCmd)) {
      // Node's own runner: read its pass and fail counts from TAP output.
      const r = spawnSync(`${testCmd} --test-reporter=tap ${JSON.stringify(rel)}`, { cwd: snap, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 })
      const num = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout || ''); return m ? Number(m[1]) : null }
      runs.push({ exit: r.status, timed_out: !!(r.error && r.error.code === 'ETIMEDOUT'), failed: num('fail'), passed: num('pass'), loaded: (num('tests') || 0) > 0 && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(r.stdout || '') })
      continue
    }
    const cmd = vitest ? `${testCmd} ${JSON.stringify(rel)} --reporter=json --outputFile=${JSON.stringify(report)}` : `${testCmd} ${JSON.stringify(rel)}`
    const r = spawnSync(cmd, { cwd: snap, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 })
    let failed = null, passed = null, loaded = null
    if (vitest && fs.existsSync(report)) {
      try {
        const j = JSON.parse(fs.readFileSync(report, 'utf8'))
        failed = j.numFailedTests; passed = j.numPassedTests
        loaded = j.numTotalTests > 0
      } catch { /* fall through to the exit code */ }
      fs.rmSync(report, { force: true })
    }
    runs.push({ exit: r.status, timed_out: !!(r.error && r.error.code === 'ETIMEDOUT'), failed, passed, loaded })
  }
  const [x, y] = runs
  const why = x.timed_out || y.timed_out ? 'the test timed out'
    : x.exit === 0 || y.exit === 0 ? 'the test passes, so it shows no bug'
    : vitest && (x.loaded === false || y.loaded === false) ? 'the test file failed to load, so no assertion ran'
    : vitest && x.failed === null ? 'the test report could not be read'
    : vitest && !(x.failed >= 1 && y.failed >= 1) ? 'no assertion failed'
    : vitest && !(x.passed >= 1 && y.passed >= 1) ? 'there is no passing control case'
    : vitest && (x.failed !== y.failed || x.passed !== y.passed) ? 'two runs gave different results'
    : null
  return { holds: !why, why: why || (vitest ? 'fails the same way twice, with a passing control' : 'fails twice (assertions not analysed for this runner)'), runs }
}

// ---- transcripts ----
export function readTranscripts(dir) {
  const agents = []
  for (const f of fs.readdirSync(dir).filter((n) => /^agent-.*\.jsonl$/.test(n))) {
    let label = f
    try { label = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')).description || f } catch { /* keep the file name */ }
    const calls = []
    const usage = { input: 0, cache_write: 0, cache_read: 0, output: 0 }
    const seenMsg = new Set()
    const seenCall = new Set()
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const m = row.message
      if (!m) continue
      if (m.usage && m.id && !seenMsg.has(m.id)) {
        seenMsg.add(m.id)
        usage.input += m.usage.input_tokens || 0
        usage.cache_write += m.usage.cache_creation_input_tokens || 0
        usage.cache_read += m.usage.cache_read_input_tokens || 0
        usage.output += m.usage.output_tokens || 0
      }
      if (Array.isArray(m.content)) for (const b of m.content) {
        if (!b || b.type !== 'tool_use') continue
        // A transcript can hold the same call on more than one row.
        if (b.id) { if (seenCall.has(b.id)) continue; seenCall.add(b.id) }
        calls.push({ tool: b.name, input: JSON.stringify(b.input || {}) })
      }
    }
    agents.push({ file: f, label, calls, usage })
  }
  return agents
}

// Did any agent look outside the snapshot and the kit copy? Prevention is by giving agents no path into the real
// repository; this is the check that it held.
export function auditBlindness(agents, { repo, allowed = [] }) {
  const hits = []
  const repoRe = new RegExp(`${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!/node_modules)(?![A-Za-z0-9._-])`)
  const words = [/ultrareview/i, /ares-[\w.-]+\.(md|json)/, /(^|\/)reviews\//, /FINDINGS\.md/, /\bgh\s+(pr|api|issue)\b/, /\bcurl\s(?![^|;&]*(127\.0\.0\.1|localhost))/, /\bwget\s/]
  for (const ag of agents) {
    for (const c of ag.calls) {
      if (c.tool === 'StructuredOutput') continue
      const text = allowed.reduce((t, p) => t.split(p).join(''), c.input)
      const why = c.tool === 'WebFetch' || c.tool === 'WebSearch' ? 'used the network'
        : repoRe.test(text) ? 'touched the real repository'
        : (words.find((w) => w.test(text)) ? 'mentioned an earlier review or the network' : null)
      if (why) hits.push({ agent: ag.label, tool: c.tool, why, call: c.input.slice(0, 240) })
    }
  }
  return hits
}

// Which files under review did no hunter open? Reported by the agents' own tool calls, not by what they say they read.
export function neverOpened(agents, changed) {
  const text = agents.filter((ag) => /^(hunt|recon)/.test(ag.label)).flatMap((ag) => ag.calls.filter((c) => c.tool !== 'StructuredOutput').map((c) => c.input)).join('\n')
  return changed.filter((f) => !text.includes(f) && !text.includes(JSON.stringify(f).slice(1, -1)))
}

export function totalUsage(agents) {
  const t = { input: 0, cache_write: 0, cache_read: 0, output: 0 }
  for (const ag of agents) for (const k of Object.keys(t)) t[k] += ag.usage[k]
  return { ...t, agents: agents.length }
}
