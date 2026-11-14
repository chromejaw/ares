#!/usr/bin/env node
// Builds everything a /ares run needs, in plain code, so no step depends on a model following prose.
// /ares hunts for bugs in code as it stands: you name folders or files, and every file in them is reviewed.
// It does not review changes.
//   - an isolated snapshot of the repository (no history, no link back to it);
//   - a copy of the kit without anything that describes earlier findings;
//   - the list of files under review;
//   - args.json, typed and validated, ready to hand to the Workflow tool.
//
// Usage:
//   node prepare.mjs --scope <paths> --out <new dir> [options]
// Options:
//   --scope a,b             folders or files to review (default: "default_scope" in the project's .ares/project.json)
//   --at <ref>              the commit to review (default: HEAD). Uncommitted edits are not reviewed.
//   --slug <name>           name used for output files (default: from the first scope path)
//   --context <file>        optional notes from the owner on what this code is for
//   --shapes a,b            bug-shape hunters to run (default: all)
//   --votes 1|3|adaptive    verifiers per finding (default: adaptive)
//   --rounds 1|2|3          hunt again, told what is already known (default: 1)
//   --no-chain              skip the last hunter
//   --verify-parallel <n>   verifiers running at once (default: 3 when tests can run, else 6)
//   --second-model <m>      model for second-opinion verifiers: sonnet|opus|haiku|fable
//   --again <result.json>   an earlier run's result; its confirmed findings are passed as already known
//   --blind                 no threat model and no lessons (for scoring against a known answer)
//   --no-tests              verifiers may not run tests
//   --no-scan               don't run the classic scanners (Semgrep, Gitleaks, OSV-Scanner)
//   --no-db                 don't start a real database for proofs
//   --no-evidence           don't run the type checker, coverage, mutation testing or fix history
//   --no-app                don't start the project's test bed
//   --max-lines <n>         refuse a larger scope (default: 8000)
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT_SRC = path.dirname(fileURLToPath(import.meta.url))
const SHAPES = ['inputs', 'sequences', 'promises', 'failures', 'numbers', 'database', 'tests']
const MODELS = ['sonnet', 'opus', 'haiku', 'fable']
const die = (msg) => { console.error(`ares prepare: ${msg}`); process.exit(1) }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim()
const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)

// ---- options ----
const VALUE = ['scope', 'at', 'out', 'slug', 'context', 'shapes', 'votes', 'rounds', 'verify-parallel', 'second-model', 'again', 'max-lines']
const FLAG = ['no-chain', 'blind', 'no-tests', 'no-scan', 'no-db', 'no-evidence', 'no-app']
const opt = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, '')
  if (!argv[i].startsWith('--')) die(`unexpected "${argv[i]}"`)
  if (FLAG.includes(name)) opt[name] = true
  else if (VALUE.includes(name)) { if (argv[i + 1] === undefined) die(`--${name} needs a value`); opt[name] = argv[++i] }
  else die(`unknown option --${name}`)
}
if (!opt.out) die('--out is required')

const shapes = opt.shapes ? csv(opt.shapes) : SHAPES
const badShape = shapes.filter((s) => !SHAPES.includes(s))
if (badShape.length) die(`unknown shape: ${badShape.join(', ')}. Known: ${SHAPES.join(', ')}`)
const votes = opt.votes === undefined || opt.votes === 'adaptive' ? 'adaptive' : Number(opt.votes)
if (votes !== 'adaptive' && votes !== 1 && votes !== 3) die(`--votes must be 1, 3 or adaptive, not "${opt.votes}"`)
const rounds = opt.rounds === undefined ? 1 : Number(opt.rounds)
if (![1, 2, 3].includes(rounds)) die(`--rounds must be 1, 2 or 3, not "${opt.rounds}"`)
if (opt['second-model'] && !MODELS.includes(opt['second-model'])) die(`--second-model must be one of ${MODELS.join(', ')}`)
const maxLines = opt['max-lines'] === undefined ? 8000 : Number(opt['max-lines'])
if (!Number.isInteger(maxLines) || maxLines < 1) die(`--max-lines must be a whole number`)

// ---- what to review ----
const repo = git(process.cwd(), '-c', 'core.quotepath=false', 'rev-parse', '--show-toplevel')
// Per-project settings live in the project, in .ares/ (all optional): project.json, project.md, lessons.md.
// The kit itself knows nothing about any one project.
const CONFIG = path.join(repo, '.ares')
const projectFile = path.join(CONFIG, 'project.json')
let project = {}
if (fs.existsSync(projectFile)) { try { project = JSON.parse(fs.readFileSync(projectFile, 'utf8')) } catch (e) { die(`${projectFile} is not valid JSON: ${e.message}`) } }
const at = opt.at || 'HEAD'
let atSha
try { atSha = git(repo, 'rev-parse', '--verify', `${at}^{commit}`) } catch { die(`can't find "${at}" in this repository`) }
const scope = (opt.scope ? csv(opt.scope) : project.default_scope || []).map((p) => p.replace(/\/+$/, ''))
if (!scope.length) die('say what to review: --scope <folders or files>, or set "default_scope" in .ares/project.json')
// Files that are never reviewed: not code, or someone else's code (project.json "exclude", regular expressions).
const NOT_CODE = /\.(md|txt|png|jpe?g|gif|svg|ico|webp|avif|mp4|webm|mp3|wav|glb|gltf|bin|woff2?|ttf|otf|lock|map|pdf|zip)$/i
const exclude = (project.exclude || []).map((x) => new RegExp(x))
const tracked = git(repo, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', atSha, '--', ...scope).split('\n').filter(Boolean)
for (const p of scope) if (!tracked.some((f) => f === p || f.startsWith(p + '/'))) die(`nothing is tracked at "${p}" in ${at}`)
const left = tracked.filter((f) => NOT_CODE.test(f) || exclude.some((x) => x.test(f)))
const files = tracked.filter((f) => !left.includes(f)).sort()
if (!files.length) die(`no code to review in ${scope.join(', ')}`)
const lineCount = (f) => { const t = execFileSync('git', ['show', `${atSha}:${f}`], { cwd: repo, maxBuffer: 1 << 28 }); let n = 0; for (const c of t) if (c === 10) n++; return n }
const perFile = files.map((f) => [f, lineCount(f)])
const lines = perFile.reduce((n, [, c]) => n + c, 0)
if (lines > maxLines) {
  // Too big for one run: split it into parts that each fit, keeping folders together, so it can be run part by part.
  const split = (paths) => {
    const size = (p) => perFile.filter(([f]) => f === p || f.startsWith(p + '/')).reduce((n, [, c]) => n + c, 0)
    const out = []
    for (const p of paths) {
      if (size(p) <= maxLines) { out.push({ path: p, lines: size(p) }); continue }
      const kids = [...new Set(perFile.filter(([f]) => f.startsWith(p + '/')).map(([f]) => p + '/' + f.slice(p.length + 1).split('/')[0]))]
      if (!kids.length || (kids.length === 1 && kids[0] === p)) out.push({ path: p, lines: size(p) })   // one huge file: its own part
      else out.push(...split(kids))
    }
    return out
  }
  const parts = []
  for (const x of split(scope).filter((x) => x.lines > 0).sort((p, q) => q.lines - p.lines)) {
    const fit = parts.find((p) => p.lines + x.lines <= maxLines)
    if (fit) { fit.scope.push(x.path); fit.lines += x.lines } else parts.push({ scope: [x.path], lines: x.lines })
  }
  console.log(JSON.stringify({ too_big: true, lines, files: files.length, limit: maxLines, parts }, null, 2))
  console.error(`ares prepare: ${lines} lines in ${files.length} files is over the limit of ${maxLines} for one run. It splits into ${parts.length} parts (printed above): run each with --scope <its paths>.`)
  process.exit(4)
}
const uncommitted = at === 'HEAD' ? git(repo, 'status', '--porcelain', '--', ...scope).split('\n').filter(Boolean).length : 0

// ---- output folder ----
if (fs.existsSync(path.resolve(opt.out))) die(`${path.resolve(opt.out)} already exists. Give a new folder.`)
// The real path, with symlinks resolved, so every tool that reports absolute paths agrees with us on where the snapshot is.
fs.mkdirSync(path.resolve(opt.out), { recursive: true })
const out = fs.realpathSync(path.resolve(opt.out))
if (out === repo || out.startsWith(repo + path.sep)) { fs.rmSync(out, { recursive: true, force: true }); die(`--out must be outside the repository, so reviewers can't see its untracked files`) }
const snap = path.join(out, 'snap')
const kit = path.join(out, 'kit')

// ---- snapshot: two commits with no history. The first is the repository without the files under review; the
// second adds them. Agents read the second; the pair is what lets Claude Security scan exactly these files. ----
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const sgit = (...a) => git(snap, '-c', 'user.name=ares', '-c', 'user.email=ares@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false', ...a)
fs.mkdirSync(snap)
sh(`git -C ${q(repo)} archive ${atSha} | tar -x -C ${q(snap)}`)
for (const f of files) fs.rmSync(path.join(snap, f), { force: true })
sgit('init', '-q', '-b', 'review')
sgit('add', '-A', '-f', '.')
sgit('commit', '-q', '--allow-empty', '-m', 'everything else')
sgit('tag', 'dr-base')
sh(`git -C ${q(repo)} archive ${atSha} | tar -x -C ${q(snap)}`)
sgit('add', '-A', '-f', '.')
sgit('commit', '-q', '--allow-empty', '-m', 'the code under review')

// The second commit must add exactly the files under review, no more and no fewer.
const added = sgit('diff', '--name-only', 'dr-base', 'HEAD').split('\n').filter(Boolean).sort()
if (added.length !== files.length || added.some((f, i) => f !== files[i])) die(`the snapshot holds ${added.length} files under review where ${files.length} were expected. Not safe to review.`)

// ---- project settings ----
let testCmd = null
// How to run one test file. From project.json if it says, otherwise worked out from what the project uses.
function detectTests() {
  if (project.test_cmd) return { cmd: project.test_cmd, dir: project.test_dir || 'test', ext: project.test_ext || 'test.js' }
  const firstDir = (names) => names.find((d) => fs.existsSync(path.join(snap, d)))
  const pkgFile = path.join(snap, 'package.json')
  if (fs.existsSync(pkgFile)) {
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return null }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const ext = fs.existsSync(path.join(snap, 'tsconfig.json')) ? 'test.ts' : 'test.js'
    const dir = firstDir(['test', 'tests', '__tests__', 'src']) || 'test'
    if (deps.vitest) return { cmd: 'npx vitest run', dir, ext }
    if (deps.jest) return { cmd: 'npx jest', dir, ext }
    // Node's built-in runner needs nothing installed.
    if (/\bnode\b[^&|;]*--test\b/.test(pkg.scripts?.test || '')) return { cmd: 'node --test', dir, ext: ext === 'test.ts' ? 'test.mjs' : 'test.js' }
    return null
  }
  if (['pyproject.toml', 'pytest.ini', 'setup.py', 'requirements.txt'].some((f) => fs.existsSync(path.join(snap, f))) && firstDir(['tests', 'test'])) return { cmd: 'python3 -m pytest -q', dir: firstDir(['tests', 'test']), ext: 'py' }
  return null
}
const tests = opt['no-tests'] ? null : detectTests()
const needsModules = tests && /^npx /.test(tests.cmd)
if (tests && (!needsModules || fs.existsSync(path.join(repo, 'node_modules')))) {
  if (needsModules) fs.symlinkSync(path.join(repo, 'node_modules'), path.join(snap, 'node_modules'), 'dir')
  testCmd = tests.cmd
}

// ---- kit copy: briefs and reference files only ----
fs.mkdirSync(kit)
for (const f of ['finder.md', 'recon.md', 'verify.md']) fs.copyFileSync(path.join(KIT_SRC, f), path.join(kit, f))
const projectNotes = fs.existsSync(path.join(CONFIG, 'project.md'))
if (projectNotes) fs.copyFileSync(path.join(CONFIG, 'project.md'), path.join(kit, 'project.md'))
fs.cpSync(path.join(KIT_SRC, 'lenses'), path.join(kit, 'lenses'), { recursive: true })
fs.cpSync(path.join(KIT_SRC, 'vendor'), path.join(kit, 'vendor'), { recursive: true })
fs.rmSync(path.join(kit, 'vendor', 'PROVENANCE.md'), { force: true })

let threatModel = null
let threatModelFrom = null
let lessons = null
if (!opt.blind) {
  const tm = (project.threat_models || []).find((t) => files.some((f) => new RegExp(t.match).test(f)))
  const tmSrc = tm ? path.join(repo, tm.file) : path.join(repo, 'THREAT_MODEL.md')
  if (fs.existsSync(tmSrc)) { threatModel = path.join(kit, 'THREAT_MODEL.md'); fs.copyFileSync(tmSrc, threatModel); threatModelFrom = path.relative(repo, tmSrc) }
  const lsSrc = path.join(CONFIG, 'lessons.md')
  const hasEntries = fs.existsSync(lsSrc) && fs.readFileSync(lsSrc, 'utf8').replace(/<!--[\s\S]*?-->/g, '').split('\n').some((l) => /^\s*[-*]\s+\S/.test(l))
  if (hasEntries) { lessons = path.join(kit, 'lessons.md'); fs.copyFileSync(lsSrc, lessons) }
}
// Findings the owner looked at and decided are not bugs (.ares/accepted.md). Hunters are told not to raise them
// again. A blind run leaves them out.
let accepted = null
const acSrc = path.join(CONFIG, 'accepted.md')
if (!opt.blind && fs.existsSync(acSrc) && fs.readFileSync(acSrc, 'utf8').replace(/<!--[\s\S]*?-->/g, '').split('\n').some((l) => /^\s*[-*]\s+\S/.test(l))) { accepted = path.join(kit, 'accepted.md'); fs.copyFileSync(acSrc, accepted) }

let context = null
if (opt.context) {
  if (!fs.existsSync(opt.context)) die(`context file ${opt.context} doesn't exist`)
  context = path.join(out, 'context.md')
  fs.copyFileSync(opt.context, context)
}

let previous = []
if (opt.again) {
  if (opt.blind) die(`--again and --blind don't go together: an earlier run's findings are not blind`)
  const prev = JSON.parse(fs.readFileSync(opt.again, 'utf8'))
  previous = (prev.confirmed || []).map((f) => `${f.title} (${f.file}:${f.start_line})`)
}

// ---- args for the workflow ----
const args = {
  root: snap,
  kit,
  files,
  file_list: path.join(out, 'files.txt'),
  ...(context && { context }),
  ...(threatModel && { threat_model: threatModel }),
  ...(projectNotes && { project: path.join(kit, 'project.md') }),
  ...(lessons && { lessons }),
  ...(accepted && { accepted }),
  ...(previous.length && { previous }),
  ...(testCmd && needsModules && fs.existsSync(path.join(repo, 'node_modules/fast-check')) && { property_testing: 'fast-check' }),
  ...(testCmd && { test_cmd: testCmd, test_dir: tests.dir, test_ext: tests.ext }),
  shapes,
  votes,
  rounds,
  chain: !opt['no-chain'],
  verify_parallel: opt['verify-parallel'] ? Number(opt['verify-parallel']) : testCmd ? 3 : 6,
  ...(opt['second-model'] && { second_model: opt['second-model'] }),
}
if (!Number.isInteger(args.verify_parallel) || args.verify_parallel < 1) die(`--verify-parallel must be a whole number above 0`)

const slug = (opt.slug || project.name || path.basename(scope[0]) || path.basename(repo)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
const meta = {
  tool: 'ares',
  repo,
  slug,
  scope,
  at,
  at_sha: atSha,
  files: files.length,
  lines,
  left_out: left.length,
  ...(project.database && { project_database: project.database }),
  ...(project.mutation && { project_mutation: project.mutation }),
  ...(project.app && { project_app: project.app }),
  uncommitted,
  blind: !!opt.blind,
  threat_model: threatModelFrom,
  lessons: !!lessons,
  tests: !!testCmd,
  prepared_at: new Date().toISOString(),
}
fs.writeFileSync(path.join(out, 'files.txt'), files.join('\n') + '\n')
fs.writeFileSync(path.join(out, 'args.json'), JSON.stringify(args, null, 2))
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2))

// ---- the plain-code tools: scanners, and a real database if the project declares one ----
const stage = (script, a) => { const r = spawnSync(process.execPath, [path.join(KIT_SRC, script), ...a, '--prep', out], { encoding: 'utf8', maxBuffer: 1 << 26 }); try { return JSON.parse(r.stdout) } catch { return { status: 'failed', why: (r.stderr || '').trim().slice(-300) } } }
const scanners = opt['no-scan'] ? { skipped: ['all: turned off'] } : stage('scan.mjs', [])
const database = opt['no-db'] ? { status: 'turned off' } : stage('db.mjs', ['start'])
const evidence = opt['no-evidence'] ? { status: 'turned off' } : stage('evidence.mjs', [])
const app = opt['no-app'] ? { status: 'turned off' } : stage('app.mjs', ['start'])
const otherModels = ['codex', 'gemini'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

console.log(JSON.stringify({
  args_file: path.join(out, 'args.json'),
  workflow: path.join(KIT_SRC, 'ares.workflow.js'),
  reports_dir: path.join(repo, project.reports_dir || 'reviews'),
  scope,
  at: `${at} (${atSha.slice(0, 10)})`,
  files: files.length,
  lines,
  left_out_not_code: left.length,
  uncommitted_files_not_reviewed: uncommitted,
  blind: meta.blind,
  threat_model: meta.threat_model,
  lessons: meta.lessons,
  tests: meta.tests,
  scanners,
  database,
  evidence,
  test_bed: app,
  other_vendor_tools_installed: otherModels,
  shapes,
  votes,
  rounds,
}, null, 2))
