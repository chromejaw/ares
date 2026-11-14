#!/usr/bin/env node
// Gives verifiers a real database to run findings against, instead of arguing about what the database would do.
// Postgres only for now. It starts a throwaway server of its own (never the project's real one), loads the project's
// schema into a template database, and writes into args.json how to copy that template and run SQL in the copy.
//
// The project says what to load, in .ares/project.json:
//   "database": { "engine": "postgres", "setup": ["path/prelude.sql", "path/migration.sql"] }
// Files are run in order, from the snapshot, so it is the code under review that gets loaded.
// If a file fails to load, that is reported: a migration that doesn't run is a finding in itself.
//
// Usage: node db.mjs start --prep <folder>     node db.mjs stop --prep <folder>
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const die = (m) => { console.error(`ares db: ${m}`); process.exit(1) }
const [cmd, ...rest] = process.argv.slice(2)
const i = rest.indexOf('--prep')
if (!['start', 'stop'].includes(cmd) || i < 0 || !rest[i + 1]) die('usage: db.mjs start|stop --prep <folder>')
const prep = path.resolve(rest[i + 1])
const argsFile = path.join(prep, 'args.json'), metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const data = path.join(prep, 'pg')
const saveMeta = (database) => fs.writeFileSync(metaFile, JSON.stringify({ ...meta, database }, null, 2))

// Postgres binaries: on the PATH, or where Homebrew and the usual Linux packages put them.
function findBin() {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) if (fs.existsSync(root)) for (const d of fs.readdirSync(root).filter((n) => /^postgresql(@\d+)?$/.test(n)).sort().reverse()) dirs.push(path.join(root, d, 'bin'))
  if (fs.existsSync('/usr/lib/postgresql')) for (const v of fs.readdirSync('/usr/lib/postgresql').sort().reverse()) dirs.push(path.join('/usr/lib/postgresql', v, 'bin'))
  return dirs.find((d) => ['initdb', 'pg_ctl', 'psql', 'createdb'].every((b) => fs.existsSync(path.join(d, b)))) || null
}

if (cmd === 'stop') {
  const bin = meta.database?.bin
  if (bin && fs.existsSync(data)) spawnSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { encoding: 'utf8' })
  console.log(JSON.stringify({ stopped: !!bin }))
  process.exit(0)
}

const conf = meta.project_database
if (!conf) { console.log(JSON.stringify({ status: 'none', why: 'the project declares no database in .ares/project.json' })); process.exit(0) }
if (conf.engine !== 'postgres') { saveMeta({ status: `the "${conf.engine}" engine is not supported` }); die(`only "postgres" is supported, not "${conf.engine}"`) }
const bin = findBin()
if (!bin) { saveMeta({ status: 'Postgres is not installed' }); console.log(JSON.stringify({ status: 'unavailable', why: 'Postgres is not installed (brew install postgresql@17)' })); process.exit(0) }

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const sh = (b, a, o = {}) => spawnSync(path.join(bin, b), a, { encoding: 'utf8', maxBuffer: 1 << 26, ...o })
fs.rmSync(data, { recursive: true, force: true })   // a leftover from an earlier start of this same run
let r = sh('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8'])
if (r.status !== 0) { saveMeta({ status: 'initdb failed' }); die(`initdb failed: ${r.stderr.slice(-300)}`) }
// Local connections only, on a port of its own; no socket file (the folder's path can be too long for one).
r = sh('pg_ctl', ['-D', data, '-w', '-l', path.join(prep, 'pg.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c max_connections=60`, 'start'])
if (r.status !== 0) { saveMeta({ status: 'the server did not start' }); die(`Postgres did not start: ${(r.stderr || r.stdout).slice(-300)}`) }
const conn = ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres']
sh('createdb', [...conn, 'dr_template'])
const problems = []
const loaded = []
for (const f of conf.setup || []) {
  // The project's own review settings (.ares/) are read from the project; everything else from the snapshot,
  // so it is the code under review that gets loaded.
  const file = f.startsWith('.ares/') ? path.join(meta.repo, f) : path.join(args.root, f)
  if (!fs.existsSync(file)) { problems.push({ file: f, error: 'the file does not exist' }); continue }
  const x = sh('psql', [...conn, '-d', 'dr_template', '-v', 'ON_ERROR_STOP=1', '-q', '-f', file])
  if (x.status !== 0) { problems.push({ file: f, error: (x.stderr || '').trim().split('\n').slice(0, 4).join(' ').slice(0, 500) }); break }
  loaded.push(f)
}
const q = (s) => `"${s}"`
const db = {
  engine: 'Postgres',
  make_copy: `${q(path.join(bin, 'createdb'))} ${conn.join(' ')} -T dr_template {name}`,
  run_sql: `${q(path.join(bin, 'psql'))} ${conn.join(' ')} -d {name} -v ON_ERROR_STOP=1   (add -c "<sql>" or -f <file>; superuser is "postgres", use SET ROLE to act as another role)`,
}
const version = (sh('psql', [...conn, '-d', 'postgres', '-Atc', 'show server_version']).stdout || '').trim()
if (problems.length) {
  // The schema didn't load, so there is nothing sound to test against. Say so loudly; don't hand verifiers a half-built database.
  sh('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'])
  const next = { ...args }; delete next.db
  fs.writeFileSync(argsFile, JSON.stringify(next, null, 2))
  saveMeta({ status: 'the schema did not load', version, loaded, problems })
  console.log(JSON.stringify({ status: 'schema did not load', version, loaded, problems }, null, 2))
  process.exit(3)
}
// ---- catalog checks: facts about the loaded schema, straight from the database. Leads for the hunters. ----
const ask = (sql) => (sh('psql', [...conn, '-d', 'dr_template', '-AtF', '\t', '-c', sql]).stdout || '').split('\n').filter(Boolean).map((l) => l.split('\t'))
const lint = []
for (const [t] of ask(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`)) lint.push({ check: 'no row-level security', object: t, note: `Table ${t} has row-level security off: any role with a grant on it reads and writes every row.` })
for (const [t, n] of ask(`select c.relname, count(p.polname) from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_policy p on p.polrelid = c.oid where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity group by 1 having count(p.polname) = 0 order by 1`)) lint.push({ check: 'row-level security with no policy', object: t, note: `Table ${t} has row-level security on and no policy: only roles that bypass it (the owner, service roles) can use it. Fine if that is intended; check nothing else is meant to reach it.` })
for (const [f] of ask(`select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') order by 1`)) lint.push({ check: 'security definer without a fixed search_path', object: f, note: `Function ${f} runs with its owner's rights and has no fixed search_path, so a caller can make it resolve names to their own objects.` })
for (const [f, who, definer] of ask(`select p.oid::regprocedure::text, r.rolname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.rolname in ('anon', 'authenticated') where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype and has_function_privilege(r.oid, p.oid, 'execute') order by 1, 2`)) lint.push({ check: 'callable by signed-in users', object: f, note: `Function ${f} can be executed by role ${who}${definer === 't' ? ', and runs with its owner\'s rights' : ''}. Check that is intended and that it trusts nothing the caller supplies.` })
for (const [t, who, privs] of ask(`select c.relname, r.rolname, string_agg(p.priv, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.rolname in ('anon', 'authenticated') cross join (values ('select'), ('insert'), ('update'), ('delete')) p(priv) where n.nspname = 'public' and c.relkind in ('r', 'v') and has_table_privilege(r.oid, c.oid, p.priv) group by 1, 2 order by 1, 2`)) lint.push({ check: 'granted to signed-in users', object: t, note: `Role ${who} has ${privs} on ${t}. With row-level security on and no policy this still returns nothing, but a view or a later policy change would expose it.` })
for (const [v] of ask(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' and not coalesce((select option_value = 'true' from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false) order by 1`)) lint.push({ check: 'view runs as its owner', object: v, note: `View ${v} is not security_invoker, so it reads its tables with the owner's rights and skips the caller's row-level security.` })
for (const [t, cols] of ask(`select c.conrelid::regclass::text, string_agg(a.attname, ', ') from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) where c.contype = 'f' and c.connamespace = 'public'::regnamespace and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and (i.indkey::int2[])[0:cardinality(c.conkey)-1] @> c.conkey) group by c.oid, 1 order by 1`)) lint.push({ check: 'foreign key without an index', object: t, note: `Foreign key on ${t} (${cols}) has no index: deletes and updates on the parent scan this whole table and hold locks longer.` })
fs.writeFileSync(path.join(prep, 'db-lint.json'), JSON.stringify(lint, null, 2))
if (lint.length) {
  const leads = path.join(args.kit, 'leads.md')
  const head = fs.existsSync(leads) ? fs.readFileSync(leads, 'utf8') : '# Leads from automated tools\n\nEach line is something a tool flagged. Many are fine. Check each against the code; none is a finding until you have traced it.\n'
  fs.writeFileSync(leads, `${head}\n## What the real database says about the loaded schema\n\n${lint.map((x) => `- [${x.check}] ${x.note}`).join('\n')}\n`)
  args.leads = leads
}
fs.writeFileSync(argsFile, JSON.stringify({ ...args, db }, null, 2))
saveMeta({ status: 'running', bin, port, version, loaded, lint: lint.length })
console.log(JSON.stringify({ status: 'running', version, loaded, schema_checks_flagged: lint.length }, null, 2))
