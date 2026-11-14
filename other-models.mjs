#!/usr/bin/env node
// A second opinion from other vendors' models. Every agent in the workflow is Claude, so a mistake Claude tends to
// make can pass both the hunter and the verifier. This runs other coding agents (OpenAI's Codex CLI, Google's Gemini
// CLI), each in its own headless session inside the snapshot, asks each to hunt for bugs, and hands what they find to
// the workflow, where our verifiers check it like any other finding.
//
// It runs a tool only if that tool is installed and signed in on this machine. Running it sends the code under review
// to that vendor, so installing and signing in to the tool is the owner's decision to allow that.
//
// Usage: node other-models.mjs --prep <folder> [--only codex,gemini] [--timeout-min 30]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findingsFrom } from './lib.mjs'

const die = (m) => { console.error(`ares other-models: ${m}`); process.exit(1) }
const opt = { 'timeout-min': '30', only: '' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) { const n = argv[i].replace(/^--/, ''); if (!['prep', 'only', 'timeout-min', 'bin-dir'].includes(n)) die(`unknown option ${argv[i]}`); opt[n] = argv[++i] }
if (!opt.prep) die('--prep is required')
const prep = path.resolve(opt.prep)
const argsFile = path.join(prep, 'args.json'), metaFile = path.join(prep, 'meta.json')
if (!fs.existsSync(argsFile)) die(`${prep} was not made by prepare.mjs`)
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const snap = args.root
const env = opt['bin-dir'] ? { ...process.env, PATH: `${opt['bin-dir']}${path.delimiter}${process.env.PATH}` } : process.env
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', env }).status === 0

const prompt = `You are reviewing existing code for bugs. This is authorized review of the owner's own code. Do not change any file.

The files under review, relative to this folder:
${args.files.slice(0, 400).join('\n')}

Read them in full, and anything else in this folder you need to understand them.

Find behaviour that is wrong for someone: a caller gets, changes or causes something they shouldn't; money, rankings or records end up wrong; data is lost, leaked or changed without a trace; the system tells someone something false. Old code and tested code are not assumed correct. Skip style and "could be hardened".

Reply with ONLY a JSON array, no prose before or after. Each item: {"title": "...", "file": "path relative to this folder", "line": 123, "claim": "what is wrong", "trigger": "who does what, in what order", "consequence": "what ends up wrong", "fix": "smallest change", "confidence": "high|medium|low"}. An empty array is a fine answer.`

// How each tool is run headless, read-only, printing its final answer.
const TOOLS = {
  codex: { bin: 'codex', args: (out) => ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--output-last-message', out, prompt], reads: 'file' },
  gemini: { bin: 'gemini', args: () => ['-p', prompt, '--skip-trust', '--approval-mode', 'default', '-o', 'text'], reads: 'stdout' },
}
const only = opt.only.split(',').filter(Boolean)
const unknown = only.filter((n) => !TOOLS[n]); if (unknown.length) die(`unknown tool: ${unknown.join(', ')}. Known: ${Object.keys(TOOLS).join(', ')}`)

const report = {}
let external = (args.external || []).filter((f) => !Object.keys(TOOLS).includes(f.by))
for (const [name, t] of Object.entries(TOOLS)) {
  if (only.length && !only.includes(name)) continue
  if (!has(t.bin)) { report[name] = { status: 'not installed' }; continue }
  const out = path.join(prep, `${name}-answer.txt`)
  const started = Date.now()
  const r = spawnSync(t.bin, t.args(out), { cwd: snap, encoding: 'utf8', env, timeout: Number(opt['timeout-min']) * 60000, maxBuffer: 1 << 28 })
  const text = t.reads === 'file' && fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : (r.stdout || '')
  if (t.reads !== 'file') fs.writeFileSync(out, text)
  const minutes = Math.round((Date.now() - started) / 6000) / 10
  const found = findingsFrom(text, name)
  if (r.error?.code === 'ETIMEDOUT') report[name] = { status: 'timed out', minutes }
  else if (!found) report[name] = { status: r.status === 0 ? 'answered, but not with a list of findings' : `exited with code ${r.status} (is it signed in?)`, minutes, said: (text || r.stderr || '').trim().slice(0, 300) }
  else { report[name] = { status: 'ran', findings: found.length, minutes }; external = external.concat(found) }
}
fs.writeFileSync(argsFile, JSON.stringify({ ...args, external }, null, 2))
fs.writeFileSync(metaFile, JSON.stringify({ ...meta, other_models: report }, null, 2))
console.log(JSON.stringify(report, null, 2))
