#!/usr/bin/env node
// Starts the project's own test bed: a local, throwaway copy of the app that hunters and verifiers can send real
// requests to. Reading code says what might happen; a running app says what does.
//
// The project declares it in .ares/project.json:
//   "app": { "start": "<command>", "ready_path": "/health", "notes": "<file describing it: tokens, routes, how to reset>" }
// The command is run in the snapshot (so it is the code under review that runs) with PORT set to a free port, and must
// listen on 127.0.0.1. A start command or notes file under .ares/ is read from the project itself.
//
// Usage: node app.mjs start --prep <folder>     node app.mjs stop --prep <folder>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const die = (m) => { console.error(`ares app: ${m}`); process.exit(1) }
const [cmd, ...rest] = process.argv.slice(2)
const i = rest.indexOf('--prep')
if (!['start', 'stop'].includes(cmd) || i < 0 || !rest[i + 1]) die('usage: app.mjs start|stop --prep <folder>')
const prep = path.resolve(rest[i + 1])
const argsFile = path.join(prep, 'args.json'), metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const save = (app) => fs.writeFileSync(metaFile, JSON.stringify({ ...meta, app }, null, 2))

if (cmd === 'stop') {
  const pid = meta.app?.pid
  if (pid) { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } } }
  console.log(JSON.stringify({ stopped: !!pid }))
  process.exit(0)
}

const conf = meta.project_app
if (!conf || !conf.start) { console.log(JSON.stringify({ status: 'none', why: 'the project declares no test bed in .ares/project.json' })); process.exit(0) }
// Project review settings live in the project, not the snapshot: copy them in so the command can find them.
const cfgSrc = path.join(meta.repo, '.ares'), cfgDst = path.join(args.root, '.ares')
if (fs.existsSync(cfgSrc)) fs.cpSync(cfgSrc, cfgDst, { recursive: true })
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const log = fs.openSync(path.join(prep, 'app.log'), 'a')
const child = spawn('sh', ['-c', conf.start], { cwd: args.root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', ...(meta.database?.port && { DR_DATABASE_PORT: String(meta.database.port) }) }, detached: true, stdio: ['ignore', log, log] })
child.unref()
const url = `http://127.0.0.1:${port}`
let ready = false, exited = false
child.on('exit', () => { exited = true })
for (let n = 0; n < 60 && !ready && !exited; n++) {
  await new Promise((r) => setTimeout(r, 500))
  try { const r = await fetch(url + (conf.ready_path || '/'), { signal: AbortSignal.timeout(2000) }); ready = r.status < 500 } catch { /* not up yet */ }
}
if (!ready) {
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
  const tail = fs.readFileSync(path.join(prep, 'app.log'), 'utf8').trim().split('\n').slice(-4).join(' ').slice(0, 400)
  const next = { ...args }; delete next.app; fs.writeFileSync(argsFile, JSON.stringify(next, null, 2))
  save({ status: `the test bed did not come up${exited ? ' (the command exited)' : ' within 30 seconds'}`, said: tail })
  console.log(JSON.stringify({ status: 'did not start', said: tail }, null, 2))
  process.exit(3)
}
let notes = null
if (conf.notes) { const src = conf.notes.startsWith('.ares/') ? path.join(meta.repo, conf.notes) : path.join(args.root, conf.notes); if (fs.existsSync(src)) { notes = path.join(args.kit, 'testbed.md'); fs.copyFileSync(src, notes) } }
fs.writeFileSync(argsFile, JSON.stringify({ ...args, app: { url, ...(notes && { notes }) } }, null, 2))
save({ status: 'running', pid: child.pid, url })
console.log(JSON.stringify({ status: 'running', url }, null, 2))
process.exit(0)
