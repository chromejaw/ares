#!/usr/bin/env node
// Makes a throwaway copy of the self-test project: a small shop with eight planted bugs. Run /ares on it blind,
// then score the report against selftest/answers.md, to see how good the review is on a known answer.
// The answer key stays here; it is never inside the project the agents see.
//   node selftest.mjs            prints { repo, answers }
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ares-selftest-'))), 'corner-shop')
fs.cpSync(path.join(here, 'selftest', 'shop'), repo, { recursive: true })
const git = (...a) => execFileSync('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@localhost', '-c', 'commit.gpgsign=false', ...a], { cwd: repo })
git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'Corner Shop')
console.log(JSON.stringify({ repo, answers: path.join(here, 'selftest', 'answers.md'), reports: path.join(path.dirname(repo), 'reports') }, null, 2))
