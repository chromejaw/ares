#!/usr/bin/env node
// Gathers hard evidence about the code before any agent starts, in plain code. Each part runs only if the project has
// what it needs, and is named in the report either way. Everything it finds goes to the hunters as leads.
//   types     the TypeScript compiler over the JavaScript and TypeScript under review: wrong arguments, missing
//             properties, values that can be undefined
//   coverage  the project's tests run with coverage: functions under review that no test ever runs
//   mutation  Stryker changes the code under review one small piece at a time and runs the tests: a change no test
//             notices marks a rule nothing checks
//   history   earlier fix commits that touched these files, so hunters can ask "was that fix complete, and applied
//             everywhere?" (left out of blind runs)
//
// Usage: node evidence.mjs --prep <folder> [--skip types,coverage,mutation,history] [--mutation-minutes 12]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const die = (m) => { console.error(`ares evidence: ${m}`); process.exit(1) }
const opt = { skip: '', 'mutation-minutes': '12' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) { const n = argv[i].replace(/^--/, ''); if (!['prep', 'skip', 'mutation-minutes'].includes(n)) die(`unknown option ${argv[i]}`); opt[n] = argv[++i] }
if (!opt.prep) die('--prep is required')
const prep = path.resolve(opt.prep)
const argsFile = path.join(prep, 'args.json'), metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const snap = args.root, files = args.files, inScope = new Set(files), skip = opt.skip.split(',').filter(Boolean)
const mod = (p) => fs.existsSync(path.join(snap, 'node_modules', p))
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: snap, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000, ...o })
const out = { types: { status: 'not run', items: [] }, coverage: { status: 'not run', items: [] }, mutation: { status: 'not run', items: [] }, history: { status: 'not run', items: [] } }
const isTest = (f) => /(^|\/)(test|tests|__tests__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
const code = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f))

// ---- types ----
if (skip.includes('types')) out.types.status = 'turned off'
else if (!mod('typescript')) out.types.status = 'TypeScript is not installed in this project'
else if (!code.length) out.types.status = 'no JavaScript or TypeScript under review'
else {
  const r = run(path.join(snap, 'node_modules/.bin/tsc'), ['--noEmit', '--allowJs', '--checkJs', '--skipLibCheck', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2023,dom,dom.iterable', '--types', 'node', '--noImplicitAny', 'false', '--strict', 'false', '--pretty', 'false', ...code])
  // Untyped JavaScript trips these constantly without being wrong: implicit any, unresolved modules, expando properties.
  const NOISE = new Set(['TS7006', 'TS7031', 'TS7005', 'TS7034', 'TS7016', 'TS2307', 'TS7053', 'TS2339', 'TS2322', 'TS2345', 'TS2688', 'TS7015', 'TS18046', 'TS2792', 'TS1259'])
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line)
    if (m && inScope.has(m[1]) && !NOISE.has(m[3])) out.types.items.push({ file: m[1], line: Number(m[2]), rule: m[3], message: m[4].slice(0, 240) })
  }
  out.types.status = 'ran'
}

// ---- coverage ----
const vitest = /vitest/.test(args.test_cmd || '')
if (skip.includes('coverage')) out.coverage.status = 'turned off'
else if (!vitest) out.coverage.status = 'needs Vitest as the test runner'
else if (!mod('@vitest/coverage-v8') && !mod('@vitest/coverage-istanbul')) out.coverage.status = 'no Vitest coverage package installed (npm i -D @vitest/coverage-v8)'
else {
  const dir = path.join(prep, 'coverage')
  const r = run('npx', ['vitest', 'run', '--coverage', '--coverage.reporter=json', '--coverage.reportOnFailure=true', `--coverage.reportsDirectory=${dir}`, ...code.map((f) => `--coverage.include=${f}`)])
  let j = null
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'coverage-final.json'), 'utf8')) } catch { /* no report */ }
  if (!j) out.coverage.status = `the tests did not produce a coverage report (${String(r.stderr || '').trim().split('\n').pop().slice(0, 160)})`
  else {
    out.coverage.status = r.status === 0 ? 'ran' : 'ran, with failing tests'
    const seen = new Set()
    for (const [abs, c] of Object.entries(j)) {
      const f = path.relative(snap, abs); if (!inScope.has(f)) continue
      seen.add(f)
      const fns = Object.entries(c.fnMap || {}), dead = fns.filter(([k]) => !c.f[k])
      const st = Object.keys(c.s || {}), hit = st.filter((k) => c.s[k]).length
      out.coverage.items.push({ file: f, statements: st.length ? Math.round(hit / st.length * 100) : 100, untested_functions: dead.map(([, fn]) => ({ name: fn.name, line: fn.loc?.start?.line || fn.decl?.start?.line || 1 })).filter((x) => x.name && !/^\(anonymous/.test(x.name)).slice(0, 40), untested_function_count: dead.length, function_count: fns.length })
    }
    for (const f of code) if (!seen.has(f)) out.coverage.items.push({ file: f, statements: 0, untested_functions: [], untested_function_count: null, function_count: null, never_loaded: true })
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- mutation ----
const mutFiles = (meta.project_mutation?.files || code).filter((f) => inScope.has(f) && /\.[cm]?[jt]s$/.test(f))
if (skip.includes('mutation')) out.mutation.status = 'turned off'
else if (!mod('@stryker-mutator/core')) out.mutation.status = 'Stryker is not installed in this project (npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner)'
else if (!vitest || !mod('@stryker-mutator/vitest-runner')) out.mutation.status = 'needs Vitest and @stryker-mutator/vitest-runner'
else if (!mutFiles.length) out.mutation.status = 'no files to mutate'
else {
  const conf = path.join(snap, 'stryker.ares.json'), report = path.join(prep, 'mutation.json')
  fs.writeFileSync(conf, JSON.stringify({ testRunner: 'vitest', mutate: mutFiles, reporters: ['json'], jsonReporter: { fileName: report }, coverageAnalysis: 'perTest', mutator: { excludedMutations: ['StringLiteral', 'ObjectLiteral', 'Regex', 'ArrayDeclaration'] }, tempDirName: '.stryker-tmp', cleanTempDir: 'always', disableTypeChecks: false, concurrency: 4, timeoutMS: 20000, ignoreStatic: true, symlinkNodeModules: true, logLevel: 'error' }))
  const r = run('npx', ['stryker', 'run', conf], { timeout: Number(opt['mutation-minutes']) * 60000 })
  fs.rmSync(conf, { force: true })
  let j = null
  try { j = JSON.parse(fs.readFileSync(report, 'utf8')) } catch { /* no report */ }
  if (!j) out.mutation.status = r.error?.code === 'ETIMEDOUT' ? `stopped after ${opt['mutation-minutes']} minutes without finishing (set fewer files in "mutation": { "files": [...] })` : `Stryker did not produce a report (${String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200)})`
  else {
    let total = 0, killed = 0
    for (const [f, d] of Object.entries(j.files || {})) {
      const src = String(d.source || '').split('\n')
      for (const m of d.mutants || []) {
        if (['Ignored', 'CompileError', 'RuntimeError'].includes(m.status)) continue
        total++
        if (m.status === 'Killed' || m.status === 'Timeout') { killed++; continue }
        const line = m.location?.start?.line || 1
        out.mutation.items.push({ file: f, line, status: m.status === 'NoCoverage' ? 'no test runs it' : 'tests still pass', change: `${m.mutatorName}: ${String(m.replacement ?? '').replace(/\s+/g, ' ').slice(0, 80) || '(removed)'}`, code: (src[line - 1] || '').trim().slice(0, 140) })
      }
    }
    out.mutation.status = 'ran'; out.mutation.total = total; out.mutation.caught = killed
  }
  fs.rmSync(report, { force: true }); fs.rmSync(path.join(snap, '.stryker-tmp'), { recursive: true, force: true })
}

// ---- history ----
if (skip.includes('history')) out.history.status = 'turned off'
else if (meta.blind) out.history.status = 'left out of a blind run'
else {
  const r = spawnSync('git', ['-C', meta.repo, 'log', '-i', '-E', '--grep=fix|bug|security|vuln|regress|revert|hotfix', '--format=%h%x09%ad%x09%s%x09%b%x1e', '--date=short', '-n', '60', meta.at_sha, '--', ...files], { encoding: 'utf8', maxBuffer: 1 << 26 })
  for (const rec of (r.stdout || '').split('\x1e')) { const [h, d, s, b] = rec.trim().split('\t'); if (h && s) out.history.items.push({ commit: h, date: d, subject: s, body: (b || '').replace(/Co-Authored-By:.*/gi, '').trim().slice(0, 1200) }) }
  out.history.status = 'ran'
}

// ---- write it down ----
fs.writeFileSync(path.join(prep, 'evidence.json'), JSON.stringify(out, null, 2))
const sections = []
if (out.types.items.length) sections.push(`## What the type checker says\n\n${out.types.items.slice(0, 80).map((x) => `- ${x.file}:${x.line} [${x.rule}] ${x.message}`).join('\n')}`)
const cov = out.coverage.items.filter((x) => x.never_loaded || x.untested_function_count)
if (cov.length) sections.push(`## Code no test runs\n\nUntested code is where bugs survive. These are not findings; they are where to look harder.\n\n${cov.map((x) => x.never_loaded ? `- ${x.file}: no test loads this file at all` : `- ${x.file}: ${x.untested_function_count} of ${x.function_count} functions never run in tests${x.untested_functions.length ? ` (${x.untested_functions.slice(0, 12).map((f) => `${f.name}:${f.line}`).join(', ')})` : ''}`).join('\n')}`)
if (out.mutation.items.length) {
  const by = new Map(); for (const m of out.mutation.items) { const k = `${m.file}:${m.line}`; if (!by.has(k)) by.set(k, { ...m, changes: [] }); by.get(k).changes.push(m.change) }
  sections.push(`## Lines the tests don't really check\n\nA tool changed each of these lines (flipped a condition, removed a statement) and every test still passed, so no test would notice if the line were wrong. Read each one and work out by hand whether it IS wrong.\n\n${[...by.values()].slice(0, 150).map((m) => `- ${m.file}:${m.line} (${m.status}; ${m.changes.slice(0, 3).join(' | ')}): \`${m.code.replace(/`/g, "'")}\``).join('\n')}`)
}
let history = null
if (out.history.items.length) {
  history = path.join(args.kit, 'history.md')
  fs.writeFileSync(history, `# Earlier fixes in this code\n\nEach entry is a past commit that fixed something in the files under review. For each: was the fix complete, was it applied everywhere the same mistake occurs, and did it introduce something new?\n\n${out.history.items.map((x) => `## ${x.commit} (${x.date}) ${x.subject}\n\n${x.body}`).join('\n\n')}\n`)
}
const next = { ...args }
if (sections.length) {
  const leads = path.join(args.kit, 'leads.md')
  const head = fs.existsSync(leads) ? fs.readFileSync(leads, 'utf8') : '# Leads from automated tools\n\nEach line is something a tool flagged. Many are fine. Check each against the code; none is a finding until you have traced it.\n'
  fs.writeFileSync(leads, `${head}\n${sections.join('\n\n')}\n`)
  next.leads = leads
}
if (history) next.history = history; else delete next.history
fs.writeFileSync(argsFile, JSON.stringify(next, null, 2))
const brief = { types: `${out.types.status}${out.types.status === 'ran' ? `, ${out.types.items.length} flagged` : ''}`, coverage: `${out.coverage.status}${out.coverage.items.length ? `, ${cov.length} files with untested code` : ''}`, mutation: `${out.mutation.status}${out.mutation.total ? `, tests caught ${out.mutation.caught} of ${out.mutation.total} changes` : ''}`, history: `${out.history.status}${out.history.items.length ? `, ${out.history.items.length} earlier fixes` : ''}` }
fs.writeFileSync(metaFile, JSON.stringify({ ...meta, evidence: brief }, null, 2))
console.log(JSON.stringify(brief, null, 2))
