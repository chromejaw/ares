#!/usr/bin/env node
// Runs whatever classic scanners are installed over the snapshot, in plain code, before any agent starts:
//   Semgrep (code patterns), Gitleaks (committed secrets), OSV-Scanner (known-vulnerable dependencies).
// Their output is used two ways: as leads for the hunters (scanners are noisy, so agents check each one), and as a
// section of the final report (secrets and vulnerable dependencies are facts, not opinions).
// A scanner that isn't installed is skipped and named. Nothing here uploads code: Semgrep downloads rule packs and
// OSV-Scanner sends package names and versions.
//
// Usage: node scan.mjs --prep <folder made by prepare.mjs> [--skip semgrep,gitleaks,osv]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const die = (m) => { console.error(`ares scan: ${m}`); process.exit(1) }
const opt = { skip: '' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) { const n = argv[i].replace(/^--/, ''); if (!['prep', 'skip'].includes(n)) die(`unknown option ${argv[i]}`); opt[n] = argv[++i] }
if (!opt.prep) die('--prep is required')
const prep = path.resolve(opt.prep)
const argsFile = path.join(prep, 'args.json'), metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const snap = args.root, files = new Set(args.files), skip = opt.skip.split(',').filter(Boolean)
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0
const run = (bin, a, o = {}) => spawnSync(bin, a, { cwd: snap, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000, ...o })
const tmp = (n) => path.join(os.tmpdir(), `dr-scan-${process.pid}-${n}.json`)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } finally { fs.rmSync(f, { force: true }) } }
const rel = (p) => path.relative(snap, path.resolve(snap, p))
const out = { ran: [], skipped: [], code: [], secrets: [], dependencies: [] }
const want = (name, bin) => { if (skip.includes(name)) { out.skipped.push(`${name}: turned off`); return false } if (!has(bin)) { out.skipped.push(`${name}: not installed`); return false } return true }

if (want('semgrep', 'semgrep')) {
  const f = tmp('semgrep')
  const list = path.join(os.tmpdir(), `dr-scan-${process.pid}-targets.txt`)
  const r = run('semgrep', ['scan', '--config', 'p/default', '--config', 'p/secrets', '--metrics', 'off', '--quiet', '--json', '--output', f, '--no-git-ignore', ...args.files])
  fs.rmSync(list, { force: true })
  const j = readJson(f)
  if (!j) out.skipped.push(`semgrep: did not finish (${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 160)})`)
  else {
    out.ran.push('semgrep')
    for (const x of j.results || []) if (files.has(rel(x.path))) out.code.push({ file: rel(x.path), line: x.start?.line || 1, rule: String(x.check_id || '').split('.').slice(-1)[0], severity: String(x.extra?.severity || '').toLowerCase(), message: String(x.extra?.message || '').replace(/\s+/g, ' ').slice(0, 300) })
  }
}

if (want('gitleaks', 'gitleaks')) {
  const f = tmp('gitleaks')
  const r = run('gitleaks', ['dir', '.', '--report-format', 'json', '--report-path', f, '--no-banner', '--redact', '--exit-code', '0'])
  const j = readJson(f)
  if (!Array.isArray(j)) out.skipped.push(`gitleaks: did not finish (${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 160)})`)
  else {
    out.ran.push('gitleaks')
    // Every tracked file is checked, not only the ones under review: a committed key matters wherever it sits.
    for (const x of j) { const file = rel(x.File || ''); if (!file.startsWith('node_modules')) out.secrets.push({ file, line: x.StartLine || 1, rule: x.RuleID || '', under_review: files.has(file), message: String(x.Description || '').slice(0, 200) }) }
  }
}

if (want('osv', 'osv-scanner')) {
  const r = run('osv-scanner', ['scan', 'source', '--recursive', '--format', 'json', '.'])
  let j = null
  try { j = JSON.parse(r.stdout) } catch { /* not JSON */ }
  if (!j && /No package sources found/.test(r.stderr || '')) out.ran.push('osv-scanner')   // no lockfiles: nothing to check
  else if (!j) out.skipped.push(`osv-scanner: did not finish (${String(r.stderr || r.error || '').trim().split('\n').pop().slice(0, 160)})`)
  else {
    out.ran.push('osv-scanner')
    for (const res of j.results || []) for (const p of res.packages || []) for (const v of p.vulnerabilities || []) {
      const sev = (v.database_specific?.severity || '').toLowerCase()
      out.dependencies.push({ lockfile: rel(res.source?.path || ''), package: p.package?.name, version: p.package?.version, id: v.id, aliases: (v.aliases || []).slice(0, 3), severity: sev, summary: String(v.summary || '').slice(0, 200) })
    }
  }
}

fs.writeFileSync(path.join(prep, 'scanners.json'), JSON.stringify(out, null, 2))
let leads = null
if (out.code.length || out.secrets.some((s) => s.under_review)) {
  const lines = ['# Leads from automated scanners', '', 'Each line is something a pattern-matching tool flagged. Many are false. Check each against the code; none is a finding until you have traced it.', '']
  for (const x of out.code) lines.push(`- ${x.file}:${x.line} [semgrep ${x.rule}] ${x.message}`)
  for (const x of out.secrets.filter((s) => s.under_review)) lines.push(`- ${x.file}:${x.line} [gitleaks ${x.rule}] ${x.message} (value withheld)`)
  leads = path.join(args.kit, 'leads.md')
  fs.writeFileSync(leads, lines.join('\n') + '\n')
}
const next = { ...args }; delete next.leads; if (leads) next.leads = leads
fs.writeFileSync(argsFile, JSON.stringify(next, null, 2))
fs.writeFileSync(metaFile, JSON.stringify({ ...meta, scanners: { ran: out.ran, skipped: out.skipped, code: out.code.length, secrets: out.secrets.length, dependencies: out.dependencies.length } }, null, 2))
console.log(JSON.stringify({ ran: out.ran, skipped: out.skipped, code_leads: out.code.length, secrets: out.secrets.length, vulnerable_dependencies: out.dependencies.length }, null, 2))
