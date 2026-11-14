#!/usr/bin/env node
// Installs /ares for every project on this machine: copies the command and the kit into
// ~/.claude/skills/ares. Run it again after changing anything here.
//   node install.mjs [--to <skills dir>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.dirname(fileURLToPath(import.meta.url))
const i = process.argv.indexOf('--to')
const dest = path.join(i > -1 ? path.resolve(process.argv[i + 1]) : path.join(os.homedir(), '.claude', 'skills'), 'ares')
const kit = path.join(dest, 'kit')
fs.rmSync(kit, { recursive: true, force: true })
fs.mkdirSync(kit, { recursive: true })
for (const f of ['prepare.mjs', 'scan.mjs', 'db.mjs', 'evidence.mjs', 'app.mjs', 'selftest.mjs', 'security-scan.mjs', 'other-models.mjs', 'finish.mjs', 'lib.mjs', 'ares.workflow.js', 'finder.md', 'recon.md', 'verify.md', 'score.md']) fs.copyFileSync(path.join(src, f), path.join(kit, f))
for (const d of ['lenses', 'vendor', 'selftest']) fs.cpSync(path.join(src, d), path.join(kit, d), { recursive: true })
fs.writeFileSync(path.join(dest, 'SKILL.md'), fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8').split('{KIT}').join(kit))
console.log(`Installed /ares to ${dest}`)
