import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore plain ES module
import { runWorkflow, journalAgent, recheckTest, auditBlindness, neverOpened, readTranscripts, totalUsage, fromClaudeSecurity, findingsFrom } from '../lib.mjs';

// The /ares kit: everything that is plain code, tested without any agent.
// A fake agent stands in for each role and answers by label.

const F = (title: string, file = 'src/a.js', confidence = 'medium') => ({ title, file, start_line: 1, claim: 'c', trigger: 't', consequence: 'q', confidence });
const base = { root: '/snap', kit: '/kit', files: ['src/a.js', 'src/b.js'] };
const recon = (areas: any[] = [{ name: 'api', files: ['src/a.js', 'src/b.js'], entry_points: ['GET /x'], guarantees: ['g'] }]) => ({ map: 'M', areas });

type Reply = (label: string, prompt: string, opts: any) => any;
async function go(args: any, reply: Reply) {
  const calls: { label: string; prompt: string; opts: any }[] = [];
  const logs: string[] = [];
  const result = await runWorkflow({ ...base, ...args }, async (prompt: string, opts: any) => { calls.push({ label: opts.label, prompt, opts }); return reply(opts.label, prompt, opts); }, { onLog: (m: string) => logs.push(m) });
  return { result, calls, logs, labels: calls.map((c) => c.label) };
}
// A reply that maps the change, finds nothing, and confirms whatever it is asked to verify.
const quiet: Reply = (label) => label === 'recon' ? recon() : label === 'recon check' ? { missing: [] } : label.startsWith('hunt') ? { findings: [] } : label.startsWith('merge') ? { groups: [] } : { verdict: 'confirmed', reason: 'r', proof: 'code', severity: 'low' };

describe('ares workflow: options', () => {
  it('requires the snapshot, the kit and the list of files under review', async () => {
    await expect(runWorkflow({}, async () => null)).rejects.toThrow('args.root is required');
    await expect(runWorkflow({ root: '/snap', kit: '/kit' }, async () => null)).rejects.toThrow('args.files is required');
  });

  it('runs every shape hunter by default', async () => {
    const { labels } = await go({}, quiet);
    expect(labels.filter((l) => l.startsWith('hunt shape:'))).toEqual(['hunt shape:inputs', 'hunt shape:sequences', 'hunt shape:promises', 'hunt shape:failures', 'hunt shape:numbers', 'hunt shape:database', 'hunt shape:tests']);
  });

  it('accepts a list typed as text instead of quietly running everything', async () => {
    const { labels } = await go({ shapes: 'sequences, tests', files: 'src/a.js,src/b.js' }, quiet);
    expect(labels.filter((l) => l.startsWith('hunt shape:'))).toEqual(['hunt shape:sequences', 'hunt shape:tests']);
  });

  it('refuses a shape it does not know', async () => {
    await expect(go({ shapes: ['sequences', 'acess'] }, quiet)).rejects.toThrow('unknown shape: acess');
  });

  it('accepts votes typed as text, and refuses a number it cannot honour', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A')] } : label.startsWith('verify') ? { verdict: 'confirmed', reason: 'r', proof: 'test', severity: 'high' } : quiet(label, '', {});
    const three = await go({ votes: '3' }, reply);
    expect(three.labels.filter((l) => l.startsWith('verify:f1'))).toHaveLength(3); // a passing test would settle it under "adaptive"
    const one = await go({ votes: '1' }, reply);
    expect(one.labels.filter((l) => l.startsWith('verify:f1'))).toHaveLength(1);
    await expect(go({ votes: 2 }, reply)).rejects.toThrow('votes must be 1, 3 or "adaptive"');
    await expect(go({ votes: 'many' }, reply)).rejects.toThrow('args.votes must be a whole number');
  });

  it('accepts true/false typed as text for the chain pass, and refuses anything else', async () => {
    expect((await go({ chain: 'false' }, quiet)).labels).not.toContain('hunt chain');
    expect((await go({ chain: false }, quiet)).labels).not.toContain('hunt chain');
    expect((await go({}, quiet)).labels).toContain('hunt chain');
    await expect(go({ chain: 'no' }, quiet)).rejects.toThrow('args.chain must be true or false');
  });

  it('refuses a second-opinion model it does not know, and passes a known one only to second opinions', async () => {
    await expect(go({ second_model: 'gpt' }, quiet)).rejects.toThrow('is not a known model');
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A')] } : quiet(label, '', {});
    const { calls } = await go({ second_model: 'opus' }, reply);
    expect(calls.find((c) => c.label === 'verify:f1 a.js')!.opts.model).toBeUndefined();
    expect(calls.filter((c) => /reachability|defences/.test(c.label)).map((c) => c.opts.model)).toEqual(['opus', 'opus']);
  });
});

describe('ares workflow: the map is checked, not trusted', () => {
  it('gives files the map left out a slice of their own, and skips files that are not code', async () => {
    const reply: Reply = (label) => label === 'recon' ? recon([{ name: 'api', files: ['src/a.js'] }]) : quiet(label, '', {});
    const { result, calls, logs } = await go({ files: ['src/a.js', 'src/b.js', 'docs/notes.md', 'public/logo.png'] }, reply);
    const extra = calls.find((c) => c.label === 'hunt slice:left out of the map')!;
    expect(extra.prompt).toContain('- src/b.js');
    expect(extra.prompt).not.toContain('- docs/notes.md');   // not given to the slice as a file to hunt in
    expect(result.coverage.unmapped_files_given_a_slice).toEqual(['src/b.js']);
    expect(result.coverage.not_code).toEqual(['docs/notes.md', 'public/logo.png']);
    expect(logs.join('\n')).toContain('The map left out 1 files under review');
  });

  it('adds no extra slice when the map covers every file under review', async () => {
    const { labels, result } = await go({}, quiet);
    expect(labels).not.toContain('hunt slice:left out of the map');
    expect(result.coverage.unmapped_files_given_a_slice).toEqual([]);
  });

  it('understands paths written with the snapshot prefix, "./" or a note in brackets', async () => {
    const reply: Reply = (label) => label === 'recon' ? recon([{ name: 'api', files: ['/snap/src/a.js', './src/b.js (handle)'] }]) : quiet(label, '', {});
    const { labels } = await go({}, reply);
    expect(labels).not.toContain('hunt slice:left out of the map');
  });

  it('adds entry points a second agent found missing, to the slice it names or to the left-over slice', async () => {
    const reply: Reply = (label) => label === 'recon check' ? { missing: [{ entry_point: 'POST /export', file: 'src/a.js', slice: 'api' }, { entry_point: 'cron sweep', file: 'src/c.js', slice: 'none' }] } : quiet(label, '', {});
    const { calls, logs } = await go({ files: ['src/a.js', 'src/b.js', 'src/c.js'] }, reply);
    expect(calls.find((c) => c.label === 'hunt slice:api')!.prompt).toContain('POST /export (src/a.js)');
    expect(calls.find((c) => c.label === 'hunt slice:left out of the map')!.prompt).toContain('cron sweep (src/c.js)');
    expect(logs.join('\n')).toContain('The map missed 2 entry points');
  });

  it('says so when the check of the map did not finish', async () => {
    const reply: Reply = (label) => label === 'recon check' ? null : quiet(label, '', {});
    expect((await go({}, reply)).logs.join('\n')).toContain('entry points the map missed are NOT caught');
  });

  it('hunts all of it as one slice when recon fails, and says coverage is weaker', async () => {
    const reply: Reply = (label) => label === 'recon' ? null : quiet(label, '', {});
    const { labels, logs } = await go({}, reply);
    expect(labels).toContain('hunt slice:all of it');
    expect(labels).not.toContain('recon check');
    expect(logs.join('\n')).toContain('Coverage will be weaker');
  });

  it('names the hunters that did not finish', async () => {
    const reply: Reply = (label) => label === 'hunt shape:tests' ? null : quiet(label, '', {});
    const { result, logs } = await go({}, reply);
    expect(logs.join('\n')).toContain('NOT covered: shape:tests');
    expect(result.coverage.hunters.find((h: any) => h.by === 'shape:tests')).toMatchObject({ failed: true });
  });
});

describe('ares workflow: verifying', () => {
  const two: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A', 'src/a.js', 'high'), F('B', 'src/b.js', 'low')] } : quiet(label, '', {});

  it('a failing test settles a finding with one vote; anything argued from code needs two of three', async () => {
    const reply: Reply = (label, prompt) => {
      if (!label.startsWith('verify')) return two(label, prompt, {});
      if (prompt.includes('Title: A')) return { verdict: 'confirmed', reason: 'r', proof: 'test', severity: 'high', test_file: 'test/_dr_f1.test.ts' };
      return /defences/.test(label) ? { verdict: 'refuted', reason: 'guard', proof: 'code' } : { verdict: 'confirmed', reason: 'r', proof: 'code', severity: /reachability/.test(label) ? 'medium' : 'high' };
    };
    const { result, labels } = await go({}, reply);
    expect(labels.filter((l) => l.startsWith('verify:f1'))).toHaveLength(1);
    expect(labels.filter((l) => l.startsWith('verify:f2'))).toHaveLength(3);
    const [a, b] = result.confirmed;
    expect(a).toMatchObject({ title: 'A', proven_by_test: true, votes: ['confirmed/test'] });
    expect(b).toMatchObject({ title: 'B', proven_by_test: false, severity: 'medium' }); // the panel lowers a severity, never raises it
    expect(b.votes).toEqual(['confirmed/code', 'confirmed/code', 'refuted/code']);
  });

  it('one confirmation against one refusal is not enough', async () => {
    const reply: Reply = (label, prompt) => !label.startsWith('verify') ? two(label, prompt, {}) : /reachability/.test(label) ? { verdict: 'refuted', reason: 'x', proof: 'code' } : /defences/.test(label) ? { verdict: 'unproven', reason: 'x', proof: 'none' } : { verdict: 'confirmed', reason: 'r', proof: 'code', severity: 'high' };
    const { result } = await go({}, reply);
    expect(result.confirmed).toEqual([]);
    expect(result.unproven.map((f: any) => f.title).sort()).toEqual(['A', 'B']);
  });

  it('drops a weak, single-source finding on one refusal, but gives a strong one second opinions', async () => {
    const reply: Reply = (label, prompt) => !label.startsWith('verify') ? two(label, prompt, {}) : { verdict: 'refuted', reason: 'guard at src/a.js:9', proof: 'code' };
    const { labels, result } = await go({}, reply);
    expect(labels.filter((l) => l.startsWith('verify:f1'))).toHaveLength(3); // A: high confidence
    expect(labels.filter((l) => l.startsWith('verify:f2'))).toHaveLength(1); // B: low confidence, one reporter
    expect(result.refuted).toHaveLength(2);
  });

  it('never runs more verifiers at once than verify_parallel', async () => {
    let now = 0, peak = 0;
    const many = Array.from({ length: 9 }, (_, i) => F(`T${i}`, `src/f${i}.js`));
    const reply: Reply = async (label) => {
      if (label === 'hunt slice:left out of the map') return { findings: many };
      if (!label.startsWith('verify')) return quiet(label, '', {});
      now++; peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
      return { verdict: 'refuted', reason: 'x', proof: 'code' };
    };
    const { result } = await go({ verify_parallel: 2, files: many.map((f) => f.file) }, reply);
    expect(result.stats.verified).toBe(9);
    expect(peak).toBe(2);
  });

  it('defaults to fewer verifiers at once when they can run tests', async () => {
    expect((await go({ test_cmd: 'npx vitest run' }, quiet)).result.stats.verify_parallel).toBe(3);
    expect((await go({}, quiet)).result.stats.verify_parallel).toBe(6);
  });

  it('tells verifiers whether they can run a test, and gives each its own file', async () => {
    const withTests = await go({ test_cmd: 'npx vitest run', votes: 3 }, two);
    const files = withTests.calls.filter((c) => c.label.startsWith('verify:f1')).map((c) => /\/snap\/(test\/_dr_[^, ]+)/.exec(c.prompt)![1]);
    expect(files).toEqual(['test/_dr_f1.test.ts', 'test/_dr_f1_b.test.ts', 'test/_dr_f1_c.test.ts']);
    const without = await go({}, two);
    expect(without.calls.find((c) => c.label.startsWith('verify:f1'))!.prompt).toContain('no test runner is available in this review. Argue from the code');
  });

  it('merges reports the merge agent groups, and keeps apart anything it forgets or repeats', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A'), F('A again'), F('C'), F('D')] } : label.startsWith('merge') ? { groups: [{ members: [0, 1] }, { members: [1, 2, 99] }] } : quiet(label, '', {});
    const { result } = await go({ votes: 1 }, reply);
    expect(result.confirmed.map((f: any) => f.title).sort()).toEqual(['A', 'C', 'D']);
    expect(result.confirmed.find((f: any) => f.title === 'A').absorbed).toEqual(['A again (src/a.js:1)']);
  });

  it('merges the same title at the same place in plain code, even when the merge agent returns nothing', async () => {
    const reply: Reply = (label) => label === 'hunt slice:api' || label === 'hunt shape:tests' ? { findings: [F('Same thing'), F('Other', 'src/b.js')] } : label.startsWith('merge') ? null : quiet(label, '', {});
    const { result } = await go({ votes: 1 }, reply);
    expect(result.confirmed.map((f: any) => f.title).sort()).toEqual(['Other', 'Same thing']);
    expect(result.confirmed[0].found_by.sort()).toEqual(['shape:tests', 'slice:api']);
  });

  it('lists findings it had no room to verify instead of dropping them silently', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A'), F('B'), F('C')] } : quiet(label, '', {});
    const { result, logs } = await go({ max_verify: 2, votes: 1 }, reply);
    expect(result.stats.verified).toBe(2);
    expect(result.dropped_unverified).toHaveLength(1);
    expect(logs.join('\n')).toContain('were NOT verified');
  });
});

describe('ares workflow: salvage and rounds', () => {
  it('verifies a real problem a verifier saw next to a finding it knocked down', async () => {
    const reply: Reply = (label, prompt) => {
      if (label.startsWith('hunt slice')) return { findings: [F('Wrong story', 'src/a.js', 'low')] };
      if (label === 'verify:f1 a.js') return { verdict: 'refuted', reason: 'not that', proof: 'code', nearby: { title: 'The real one', file: '/snap/src/a.js', start_line: 7, claim: 'different mechanism' } };
      if (label.startsWith('verify:s1')) return { verdict: 'confirmed', reason: 'r', proof: 'test', severity: 'high', test_file: 'test/_dr_s1.test.ts' };
      return quiet(label, prompt, {});
    };
    const { result, calls } = await go({}, reply);
    expect(result.refuted.map((f: any) => f.title)).toEqual(['Wrong story']);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).toMatchObject({ title: 'The real one', file: 'src/a.js', start_line: 7, found_by: ['salvage of f1'], proven_by_test: true });
    expect(calls.find((c) => c.label.startsWith('verify:s1'))!.opts.phase).toBe('Salvage');
  });

  it('does not salvage a problem that is already a finding', async () => {
    const reply: Reply = (label, prompt) => label.startsWith('hunt slice') ? { findings: [F('A')] } : label.startsWith('verify') ? { verdict: 'confirmed', reason: 'r', proof: 'test', severity: 'low', nearby: { title: 'a', file: 'src/a.js', start_line: 1, claim: 'same' } } : quiet(label, prompt, {});
    expect((await go({}, reply)).labels.filter((l) => l.startsWith('verify:s'))).toEqual([]);
  });

  it('a second round is told what the first examined, and stops early when a round finds nothing', async () => {
    const reply: Reply = (label) => label === 'hunt slice:api r1' ? { findings: [F('A')] } : label === 'hunt shape:tests r2' ? { findings: [F('Late', 'src/b.js')] } : quiet(label, '', {});
    const { result, calls } = await go({ rounds: 2, votes: 1 }, reply);
    const r2 = calls.find((c) => c.label === 'hunt slice:api r2')!;
    expect(r2.prompt).toContain('Already examined in an earlier round');
    expect(r2.prompt).toContain('- A (src/a.js:1)');
    expect(calls.find((c) => c.label === 'hunt slice:api r1')!.prompt).not.toContain('Already examined');
    expect(result.confirmed.map((f: any) => f.id).sort()).toEqual(['f1', 'f2']);

    const dry = await go({ rounds: 3 }, quiet);
    expect(dry.labels.filter((l) => l.startsWith('hunt slice:api'))).toEqual(['hunt slice:api r1']);
  });

  it('passes an earlier run\'s confirmed findings to hunters and verifiers', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A')] } : quiet(label, '', {});
    const { calls } = await go({ previous: ['Old one (src/x.js:3)'] }, reply);
    expect(calls.find((c) => c.label === 'hunt slice:api')!.prompt).toContain('- Old one (src/x.js:3)');
    expect(calls.find((c) => c.label === 'verify:f1 a.js')!.prompt).toContain('- Old one (src/x.js:3)');
  });

  it('a verifier can call a finding a duplicate of one already known', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A')] } : label.startsWith('verify') ? { verdict: 'duplicate', reason: 'same', proof: 'none', duplicate_of: 'Old one' } : quiet(label, '', {});
    const { result, labels } = await go({ previous: ['Old one (src/x.js:3)'], votes: 3 }, reply);
    expect(result.duplicates).toEqual([{ id: 'f1', title: 'A', duplicate_of: 'Old one' }]);
    expect(labels.filter((l) => l.startsWith('verify:f1'))).toHaveLength(1);
  });
});

describe('ares: prompts carry no path into the real repository', () => {
  it('every prompt names only the snapshot and the kit copy', async () => {
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A')] } : quiet(label, '', {});
    const { calls } = await go({ context: '/prep/context.md', threat_model: '/kit/THREAT_MODEL.md', project: '/kit/project.md', test_cmd: 'npx vitest run' }, reply);
    for (const c of calls) {
      expect(c.prompt).not.toContain(process.cwd());
      expect(c.prompt).not.toMatch(/old-review|\/reviews\//);
    }
    expect(calls.find((c) => c.label === 'recon')!.prompt).toContain('Work only inside the review root and the kit folder');
  });
});

describe('ares: rebuilding a result from the run\'s journal', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-journal-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('replaying the journal gives the same result as the run, and reports agents that never finished', async () => {
    const reply: Reply = (label, prompt) => label.startsWith('hunt slice') ? { findings: [F('A'), F('B', 'src/b.js')] } : label === 'verify:f2 b.js' ? { verdict: 'refuted', reason: 'x', proof: 'code' } : quiet(label, prompt, {});
    const live = await go({ votes: 1 }, reply);
    const rows: any[] = [{ type: 'launched' }];
    live.calls.forEach((c, i) => {
      rows.push({ type: 'started', agentId: `a${i}`, label: c.label });
      rows.push({ type: 'result', agentId: `a${i}`, result: reply(c.label, c.prompt, c.opts) });
    });
    const file = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
    const replay = journalAgent(file);
    const again = await runWorkflow({ ...base, votes: 1 }, replay.agent);
    expect(again).toEqual(live.result);
    expect(replay.unknown).toEqual([]);

    // The same run cut short: the verifiers never started.
    fs.writeFileSync(file, rows.filter((r) => !/^a(1[0-9]|9)$/.test(r.agentId || '')).map((r) => JSON.stringify(r)).join('\n'));
    const cut = journalAgent(file);
    await runWorkflow({ ...base, votes: 1 }, cut.agent);
    expect(cut.unknown.length).toBeGreaterThan(0);
  });
});

describe('ares: a proving test must hold when re-run', () => {
  // Stands in for the test runner: writes the report the real one would, from numbers in the "test" file's name.
  let snap: string, runner: string;
  beforeAll(() => {
    snap = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-snap-'));
    fs.mkdirSync(path.join(snap, 'test'));
    runner = path.join(snap, 'fake-vitest.mjs');
    fs.writeFileSync(runner, `import fs from 'node:fs';
const file = process.argv[2]; const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice(13);
const [, failed, passed, flaky] = /f(\\d)p(\\d)(x?)/.exec(file);
let f = Number(failed);
if (flaky) { const mark = file + '.ran'; if (fs.existsSync(mark)) f = 0; else fs.writeFileSync(mark, ''); }
fs.writeFileSync(out, JSON.stringify({ numFailedTests: f, numPassedTests: Number(passed), numTotalTests: f + Number(passed) }));
process.exit(f > 0 || f + Number(passed) === 0 ? 1 : 0);`);
    for (const n of ['f1p1', 'f1p0', 'f0p2', 'f0p0', 'f1p1x']) fs.writeFileSync(path.join(snap, 'test', `_dr_${n}.test.ts`), '');
  });
  afterAll(() => fs.rmSync(snap, { recursive: true, force: true }));
  const check = (n: string) => recheckTest({ snap, testCmd: `node ${JSON.stringify(runner)}`, file: `test/_dr_${n}.test.ts` });

  it('holds when an assertion fails, a control passes, and two runs agree', () => {
    expect(check('f1p1')).toMatchObject({ holds: true });
  });
  it('does not hold without a passing control case', () => {
    expect(check('f1p0')).toMatchObject({ holds: false, why: 'there is no passing control case' });
  });
  it('does not hold when the test passes', () => {
    expect(check('f0p2')).toMatchObject({ holds: false, why: 'the test passes, so it shows no bug' });
  });
  it('does not hold when the file fails to load, which also exits non-zero', () => {
    expect(check('f0p0')).toMatchObject({ holds: false, why: 'the test file failed to load, so no assertion ran' });
  });
  it('does not hold when two runs disagree', () => {
    expect(check('f1p1x')).toMatchObject({ holds: false });
  });
  it('does not hold when the file is missing or outside the snapshot', () => {
    expect(check('nope')).toMatchObject({ holds: false, why: 'the test file does not exist' });
    expect(recheckTest({ snap, testCmd: 'node x', file: '../etc/passwd' })).toMatchObject({ holds: false });
  });
});

describe('ares: auditing what agents touched', () => {
  const repo = '/Users/someone/project';
  const prep = '/tmp/scratch/dr-pr4';
  const ag = (label: string, ...calls: [string, any][]) => ({ label, calls: calls.map(([tool, input]) => ({ tool, input: JSON.stringify(input) })), usage: { input: 1, cache_write: 2, cache_read: 3, output: 4 } });

  it('flags a read of the real repository, an earlier review, or the network, and nothing else', () => {
    const agents = [
      ag('hunt slice:api', ['Read', { file_path: `${prep}/snap/src/a.js` }], ['Bash', { command: `cd ${prep}/snap && npx vitest run test/x.test.ts` }]),
      ag('verify:f1 a.js', ['Bash', { command: `ls ${repo}/node_modules/.bin` }]),
      ag('hunt shape:tests', ['Read', { file_path: `${repo}/reviews/old-review-pr4.md` }]),
      ag('hunt chain', ['Bash', { command: 'gh pr view 4 --comments' }]),
      ag('recon', ['WebFetch', { url: 'https://example.com' }]),
      ag('merge', ['StructuredOutput', { note: `${repo}/whatever` }]),
      ag('verify:f2 b.js', ['Read', { file_path: `${repo}-other/file.js` }]),
    ];
    const hits = auditBlindness(agents, { repo, allowed: [prep] });
    expect(hits.map((h: any) => [h.agent, h.why])).toEqual([
      ['hunt shape:tests', 'touched the real repository'],
      ['hunt chain', 'mentioned an earlier review or the network'],
      ['recon', 'used the network'],
    ]);
  });

  it('lists files under review no hunter opened, going by tool calls and not by what agents say', () => {
    const agents = [
      ag('hunt slice:api', ['Read', { file_path: `${prep}/snap/src/a.js` }], ['Bash', { command: 'cd /x && sed -n 1,40p "functions/api/admin/[[path]].js"' }]),
      ag('verify:f1 a.js', ['Read', { file_path: `${prep}/snap/src/c.js` }]),
    ];
    expect(neverOpened(agents, ['src/a.js', 'functions/api/admin/[[path]].js', 'src/c.js'])).toEqual(['src/c.js']);
  });

  it('adds up what the run used', () => {
    expect(totalUsage([ag('a'), ag('b')])).toEqual({ input: 2, cache_write: 4, cache_read: 6, output: 8, agents: 2 });
  });

  it('reads tool calls and usage from transcript files, counting each message once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-tr-'));
    const msg = { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'call1', name: 'Read', input: { file_path: '/x' } }] };
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), [JSON.stringify({ message: msg }), JSON.stringify({ message: msg }), 'broken', JSON.stringify({ other: 1 })].join('\n'));
    fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ description: 'hunt slice:api' }));
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), '');
    const [one] = readTranscripts(dir);
    expect(one).toMatchObject({ label: 'hunt slice:api', usage: { input: 10, output: 5 } });
    expect(one.calls).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ares: prepare.mjs snapshots code as it stands, not a change', () => {
  let work: string, repo: string;
  const script = path.resolve('prepare.mjs');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  // The scanners and the database are tried for real elsewhere; here they would only slow every case down.
  const prepare = (...a: string[]) => spawnSync('node', [script, '--no-scan', '--no-db', '--no-evidence', '--no-app', ...a], { cwd: repo, encoding: 'utf8' });
  const argsOf = (out: string) => JSON.parse(fs.readFileSync(path.join(out, 'args.json'), 'utf8'));

  beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-prep-')));
    repo = path.join(work, 'repo');
    fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true }); fs.mkdirSync(path.join(repo, 'lib'));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'src/api/old.js'), 'export const a = 1\nexport const b = 2\n');   // written long ago, never touched again
    fs.writeFileSync(path.join(repo, 'src/api/[[path]].js'), 'export default 1\n');
    fs.writeFileSync(path.join(repo, 'src/api/logo.png'), 'not code');
    fs.writeFileSync(path.join(repo, 'src/api/NOTES.md'), 'notes\n');
    fs.writeFileSync(path.join(repo, 'lib/helper.js'), 'export const h = 1\n');
    fs.writeFileSync(path.join(repo, 'old-review.md'), 'answers\n');
    git('add', '-A'); git('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(repo, 'lib/helper.js'), 'export const h = 2\n');
    git('add', '-A'); git('commit', '-q', '-m', 'second: touches only the helper');
    fs.writeFileSync(path.join(repo, 'untracked-secret.txt'), 'not for reviewers\n');
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('reviews every code file in the folders named, however old, and leaves out files that are not code', () => {
    const out = path.join(work, 'out1');
    const r = prepare('--scope', 'src/api/', '--out', out, '--shapes', 'sequences,tests', '--votes', '3', '--blind');
    expect(r.status, r.stderr).toBe(0);
    const args = argsOf(out), snap = path.join(out, 'snap');
    expect(args.files).toEqual(['src/api/[[path]].js', 'src/api/old.js']);   // unchanged since the first commit, and still reviewed
    expect(fs.readFileSync(args.file_list, 'utf8')).toBe('src/api/[[path]].js\nsrc/api/old.js\n');
    expect(args).toMatchObject({ root: snap, kit: path.join(out, 'kit'), shapes: ['sequences', 'tests'], votes: 3, rounds: 1, chain: true });
    expect(args.base).toBeUndefined();
    expect(JSON.parse(r.stdout)).toMatchObject({ files: 2, lines: 3, left_out_not_code: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'))).toMatchObject({ scope: ['src/api'], at: 'HEAD', files: 2, lines: 3 });
    expect(JSON.stringify(args)).not.toContain(repo + '/');
  });

  it('the snapshot is a repository of its own: no history, no remote, no untracked files, and the rest of the code is there to read', () => {
    const out = path.join(work, 'out2');
    expect(prepare('--scope', 'src/api', '--out', out, '--blind').status).toBe(0);
    const snap = path.join(out, 'snap');
    const sgit = (...a: string[]) => execFileSync('git', a, { cwd: snap, encoding: 'utf8' }).trim();
    expect(sgit('log', '--format=%s').split('\n')).toEqual(['the code under review', 'everything else']);
    expect(sgit('remote')).toBe('');
    expect(fs.statSync(path.join(snap, '.git')).isDirectory()).toBe(true);
    expect(sgit('diff', '--name-only', 'dr-base', 'HEAD').split('\n').sort()).toEqual(['src/api/[[path]].js', 'src/api/old.js']);   // what Claude Security is asked to scan
    expect(fs.readFileSync(path.join(snap, 'lib/helper.js'), 'utf8')).toContain('h = 2');
    expect(fs.existsSync(path.join(snap, 'untracked-secret.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(out, 'kit')).sort()).toEqual(['finder.md', 'lenses', 'recon.md', 'vendor', 'verify.md']);
    expect(fs.existsSync(path.join(out, 'kit/vendor/PROVENANCE.md'))).toBe(false);
  });

  it('takes single files and several paths, and an older commit with --at', () => {
    const out = path.join(work, 'out3');
    expect(prepare('--scope', 'lib/helper.js,src/api/old.js', '--at', 'HEAD~1', '--out', out, '--blind').status).toBe(0);
    expect(argsOf(out).files).toEqual(['lib/helper.js', 'src/api/old.js']);
    expect(fs.readFileSync(path.join(out, 'snap/lib/helper.js'), 'utf8')).toContain('h = 1');
  });

  it('says when files in scope have uncommitted edits, which are not reviewed', () => {
    fs.writeFileSync(path.join(repo, 'src/api/old.js'), 'export const a = 99\n');
    const out = path.join(work, 'out4');
    const r = prepare('--scope', 'src/api', '--out', out, '--blind');
    expect(JSON.parse(r.stdout).uncommitted_files_not_reviewed).toBe(1);
    expect(fs.readFileSync(path.join(out, 'snap/src/api/old.js'), 'utf8')).toContain('a = 1');
    git('checkout', '--', 'src/api/old.js');
  });

  it('copies the threat model into the kit unless the run is blind', () => {
    fs.writeFileSync(path.join(repo, 'THREAT_MODEL.md'), '# Threat Model\n');
    const open = path.join(work, 'out5');
    expect(prepare('--scope', 'src', '--out', open).status).toBe(0);
    expect(argsOf(open).threat_model).toBe(path.join(open, 'kit/THREAT_MODEL.md'));
    const blind = path.join(work, 'out6');
    expect(prepare('--scope', 'src', '--out', blind, '--blind').status).toBe(0);
    expect(fs.existsSync(path.join(blind, 'kit/THREAT_MODEL.md'))).toBe(false);
    fs.rmSync(path.join(repo, 'THREAT_MODEL.md'));
  });

  it('reads a project\'s own settings from .ares/, and none of them are needed', () => {
    const bare = path.join(work, 'out-bare');
    const r0 = prepare('--scope', 'src', '--out', bare);
    expect(r0.status, r0.stderr).toBe(0);
    expect(argsOf(bare)).not.toHaveProperty('project'); expect(argsOf(bare)).not.toHaveProperty('lessons'); expect(argsOf(bare)).not.toHaveProperty('test_cmd');
    expect(JSON.parse(r0.stdout).reports_dir).toBe(path.join(repo, 'reviews'));
    expect(prepare('--out', path.join(work, 'x')).stderr).toContain('.ares/project.json');   // no paths and no default scope

    fs.mkdirSync(path.join(repo, '.ares'));
    fs.writeFileSync(path.join(repo, '.ares/project.json'), JSON.stringify({ name: 'demo', default_scope: ['lib'], exclude: ['old\\.js$'], reports_dir: 'docs/reviews', threat_models: [{ match: 'lib', file: 'SEC.md' }] }));
    fs.writeFileSync(path.join(repo, '.ares/project.md'), 'how to test here\n');
    fs.writeFileSync(path.join(repo, '.ares/lessons.md'), '# Lessons\n\n- A shape.\n');
    fs.writeFileSync(path.join(repo, 'SEC.md'), '# Threat Model\n');
    const out = path.join(work, 'out-conf');
    const r = prepare('--out', out);
    expect(r.status, r.stderr).toBe(0);
    const a = argsOf(out);
    expect(a.files).toEqual(['lib/helper.js']);                                   // the default scope
    expect(a).toMatchObject({ project: path.join(out, 'kit/project.md'), lessons: path.join(out, 'kit/lessons.md'), threat_model: path.join(out, 'kit/THREAT_MODEL.md') });
    expect(JSON.parse(r.stdout)).toMatchObject({ reports_dir: path.join(repo, 'docs/reviews'), threat_model: 'SEC.md' });
    expect(JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8')).slug).toBe('demo');
    const ex = path.join(work, 'out-ex');
    expect(prepare('--scope', 'src', '--out', ex).status).toBe(0);
    expect(argsOf(ex).files).toEqual(['src/api/[[path]].js']);                    // old.js is excluded by the project
    fs.writeFileSync(path.join(repo, '.ares/project.json'), '{ not json');
    expect(prepare('--scope', 'src', '--out', path.join(work, 'x')).stderr).toContain('is not valid JSON');
    fs.rmSync(path.join(repo, '.ares'), { recursive: true }); fs.rmSync(path.join(repo, 'SEC.md'));
  });

  it('works out how to run tests from the project when it isn\'t told', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ devDependencies: { vitest: '1' } }));
    fs.mkdirSync(path.join(repo, 'tests')); fs.writeFileSync(path.join(repo, 'tests/a.test.js'), '');
    git('add', '-A'); git('commit', '-q', '-m', 'tests');
    const noMods = path.join(work, 'out-t1');
    expect(prepare('--scope', 'src', '--out', noMods).status).toBe(0);
    expect(argsOf(noMods)).not.toHaveProperty('test_cmd');                        // nothing installed, so nothing can run
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const withMods = path.join(work, 'out-t2');
    expect(prepare('--scope', 'src', '--out', withMods).status).toBe(0);
    expect(argsOf(withMods)).toMatchObject({ test_cmd: 'npx vitest run', test_dir: 'tests', test_ext: 'test.js', verify_parallel: 3 });
    expect(fs.lstatSync(path.join(withMods, 'snap/node_modules')).isSymbolicLink()).toBe(true);
    const off = path.join(work, 'out-t3');
    expect(prepare('--scope', 'src', '--out', off, '--no-tests').status).toBe(0);
    expect(argsOf(off)).not.toHaveProperty('test_cmd');
    fs.rmSync(path.join(repo, 'node_modules'), { recursive: true });
  });

  it('passes an earlier run\'s confirmed findings on, but not into a blind run', () => {
    const prev = path.join(work, 'prev.json');
    fs.writeFileSync(prev, JSON.stringify({ confirmed: [{ title: 'Old', file: 'src/api/old.js', start_line: 3 }] }));
    const out = path.join(work, 'out7');
    expect(prepare('--scope', 'src', '--out', out, '--again', prev).status).toBe(0);
    expect(argsOf(out).previous).toEqual(['Old (src/api/old.js:3)']);
    expect(prepare('--scope', 'src', '--out', path.join(work, 'out8'), '--again', prev, '--blind').stderr).toContain("don't go together");
  });

  it('refuses options it does not understand, including the old change-review ones, and leaves nothing behind', () => {
    const cases: [string[], string][] = [
      [['--shapes', 'acess'], 'unknown shape: acess'],
      [['--votes', '2'], '--votes must be 1, 3 or adaptive'],
      [['--rounds', '9'], '--rounds must be 1, 2 or 3'],
      [['--base', 'main'], 'unknown option --base'],
      [['--head', 'main'], 'unknown option --head'],
      [['--second-model', 'gpt'], '--second-model must be one of'],
    ];
    for (const [extra, message] of cases) {
      const out = path.join(work, 'bad');
      const r = prepare('--scope', 'src', '--out', out, ...extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      expect(fs.existsSync(out)).toBe(false);
    }
  });

  it('a scope too big for one run is split into parts that each fit, keeping folders together', () => {
    const r = prepare('--scope', 'src,lib', '--out', path.join(work, 'big'), '--max-lines', '3');
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('over the limit of 3 for one run');
    const plan = JSON.parse(r.stdout);
    expect(plan).toMatchObject({ too_big: true, limit: 3 });
    expect(plan.parts.every((p: any) => p.lines <= 3)).toBe(true);
    expect(plan.parts.map((p: any) => p.scope)).toEqual([['src'], ['lib']]);   // 3 lines and 1 line don't fit in one part of 3
    expect(fs.existsSync(path.join(work, 'big'))).toBe(false);
  });

  it('passes on what the owner already accepted as intended, but not into a blind run', () => {
    fs.mkdirSync(path.join(repo, '.ares'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ares/accepted.md'), '# Accepted\n\n- Owners can do anything: intended.\n');
    const out = path.join(work, 'out-acc');
    expect(prepare('--scope', 'src', '--out', out).status).toBe(0);
    expect(argsOf(out).accepted).toBe(path.join(out, 'kit/accepted.md'));
    const blind = path.join(work, 'out-acc-b');
    expect(prepare('--scope', 'src', '--out', blind, '--blind').status).toBe(0);
    expect(argsOf(blind)).not.toHaveProperty('accepted');
    fs.rmSync(path.join(repo, '.ares'), { recursive: true });
  });

  it('refuses a path with nothing in it, a scope with no code, an unknown commit, and a bad output folder', () => {
    expect(prepare('--scope', 'nope', '--out', path.join(work, 'x')).stderr).toContain('nothing is tracked at "nope"');
    expect(prepare('--scope', 'old-review.md', '--out', path.join(work, 'x')).stderr).toContain('no code to review');
    expect(prepare('--scope', 'src', '--at', 'nope', '--out', path.join(work, 'x')).stderr).toContain(`can't find "nope"`);
    expect(prepare('--scope', 'src', '--out', work).stderr).toContain('already exists');
    expect(prepare('--scope', 'src', '--out', path.join(repo, 'inside')).stderr).toContain('must be outside the repository');
    expect(prepare('--out', path.join(work, 'x')).stderr).toContain('say what to review');
  });
});

describe('ares: findings from Claude Security', () => {
  const record = (over: any = {}) => JSON.stringify({ id: 'F1', claudeSecurityPluginFindingId: 'csp-1', title: 'Export skips the role check', impact: 'A reviewer downloads every email', file: 'src/lib/admin/service.js', line: 90, description: 'handle() sends /export on without can()', exploit_scenario: 'A reviewer POSTs /export', preconditions: ['a reviewer account'], severity: 'HIGH', confidence: 'MEDIUM', recommendation: 'Check the role', cwe_id: 'CWE-862', snippet: 'return R.exportPage(...)', symbol: 'handle', ...over });

  it('reads the plugin\'s records into the shape our hunters return', () => {
    const { findings, skipped } = fromClaudeSecurity(record() + '\n\n');
    expect(skipped).toEqual([]);
    expect(findings).toEqual([{
      title: 'Export skips the role check', file: 'src/lib/admin/service.js', start_line: 90,
      claim: 'handle() sends /export on without can()', trigger: 'A reviewer POSTs /export Needs: a reviewer account',
      consequence: 'A reviewer downloads every email', evidence: 'in handle: `return R.exportPage(...)`', fix: 'Check the role',
      confidence: 'medium', by: 'claude-security', their_severity: 'high', their_id: 'csp-1', cwe: 'CWE-862',
    }]);
  });

  it('skips records it can\'t use and says which, instead of guessing', () => {
    const { findings, skipped } = fromClaudeSecurity([record({ line: 0 }), 'not json', record({ title: '' }), record({ confidence: 'CERTAIN', preconditions: 'an owner', exploit_scenario: '' })].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ confidence: 'medium', trigger: 'Needs: an owner' });
    expect(skipped).toEqual(['line 1: no title, file, line or description', 'line 2: not JSON', 'line 3: no title, file, line or description']);
  });

  it('the workflow merges them with our hunters\' findings and verifies them like any other', async () => {
    const external = fromClaudeSecurity([record({ title: 'A', file: 'src/a.js', line: 1 }), record({ title: 'Only theirs', file: '/snap/src/b.js', line: 9 })].join('\n')).findings;
    const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F('A'), F('Only ours', 'src/b.js')] } : quiet(label, '', {});
    const { result, calls, logs } = await go({ external, votes: 1 }, reply);
    const by = Object.fromEntries(result.confirmed.map((f: any) => [f.title, f.found_by.sort()]));
    expect(by).toEqual({ A: ['claude-security', 'slice:api'], 'Only ours': ['slice:api'], 'Only theirs': ['claude-security'] });
    expect(result.confirmed.find((f: any) => f.title === 'Only theirs').file).toBe('src/b.js');
    expect(result.stats.external_findings).toBe(2);
    expect(logs.join('\n')).toContain('2 findings taken in from claude-security');
    expect(calls.find((c) => c.label === 'hunt chain')!.prompt).toContain('Only theirs (src/b.js:9)'); // the last hunter knows what was raised
    expect(calls.find((c) => c.label === 'hunt slice:api')!.prompt).not.toContain('Only theirs'); // the others hunt without being told
  });

  it('takes them in once, not again on every round', async () => {
    const external = fromClaudeSecurity(record({ title: 'T', file: 'src/a.js', line: 1 })).findings;
    const { result } = await go({ external, votes: 1, rounds: 2 }, (label) => label === 'hunt shape:tests r2' ? { findings: [F('Late', 'src/b.js')] } : quiet(label, '', {}));
    expect(result.confirmed.map((f: any) => f.title).sort()).toEqual(['Late', 'T']);
  });

  it('refuses a malformed list', async () => {
    await expect(go({ external: 'some text' }, quiet)).rejects.toThrow('args.external must be a list');
    await expect(go({ external: [{ title: 'x' }] }, quiet)).rejects.toThrow('args.external[0] needs a title, file, start_line and claim');
  });
});

describe('ares: security-scan.mjs runs the plugin on the snapshot and takes its findings in', () => {
  let work: string, prep: string, snap: string, fake: string;
  const script = path.resolve('security-scan.mjs');
  const scan = (...a: string[]) => spawnSync('node', [script, '--prep', prep, '--claude-bin', fake, ...a], { encoding: 'utf8', env: { ...process.env } });
  const meta = () => JSON.parse(fs.readFileSync(path.join(prep, 'meta.json'), 'utf8'));
  const args = () => JSON.parse(fs.readFileSync(path.join(prep, 'args.json'), 'utf8'));
  // Stands in for the claude command: FAKE_MODE says how it behaves.
  const setMode = (mode: string) => fs.writeFileSync(path.join(work, 'mode'), mode);

  beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-sec-')));
    prep = path.join(work, 'prep'); snap = path.join(prep, 'snap');
    fs.mkdirSync(snap, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: snap, encoding: 'utf8' });
    git('init', '-q'); fs.writeFileSync(path.join(snap, 'a.js'), '1\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(snap, 'a.js'), '2\n'); git('add', '-A'); git('commit', '-q', '-m', 'head');
    fs.writeFileSync(path.join(prep, 'args.json'), JSON.stringify({ root: snap, kit: path.join(prep, 'kit'), files: ['a.js'] }));
    fs.writeFileSync(path.join(prep, 'meta.json'), JSON.stringify({ tool: 'ares', slug: 't' }));
    fake = path.join(work, 'claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const mode = fs.readFileSync(${JSON.stringify(path.join(work, 'mode'))}, 'utf8');
const a = process.argv.slice(2);
if (a[0] === 'plugin') { process.stdout.write(mode === 'missing' ? 'Installed plugins:\\n\\n  > other@x\\n    Status: enabled\\n' : 'Installed plugins:\\n\\n  > other@x\\n    Status: enabled\\n\\n  > claude-security@claude-plugins-official\\n    Version: 0.12.0\\n    Status: ✔ enabled\\n'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(path.join(work, 'prompt.txt'))}, a[1] + '\\n--cwd ' + process.cwd() + '\\n--rest ' + a.slice(2).join(' '));
if (mode === 'refuses') { process.stdout.write(JSON.stringify({ result: 'No scan was started.', session_id: 's0' })); process.exit(0); }
const dir = path.join(process.cwd(), 'CLAUDE-SECURITY-20260101-000000'); fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'CLAUDE-SECURITY-RESULTS.jsonl'), JSON.stringify({ title: 'Theirs', file: 'a.js', line: 1, description: 'd', impact: 'i', severity: 'HIGH', confidence: 'HIGH' }) + '\\n' + 'junk\\n');
fs.writeFileSync(path.join(dir, 'CLAUDE-SECURITY-REVISION-abc.json'), JSON.stringify({ verification: { status: 'verified' } }));
fs.writeFileSync(path.join(dir, 'CLAUDE-SECURITY-RESULTS.md'), '# report');
process.stdout.write(JSON.stringify({ result: 'done', session_id: 's1', total_cost_usd: 1.5, subagent_stats: { spawned: 7 } }));
`, { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  it('stops with a clear message when the plugin is not installed', () => {
    setMode('missing');
    const r = scan();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('claude plugin install claude-security@claude-plugins-official');
    expect(meta().security_scan).toMatchObject({ status: 'the plugin is not installed' });
    expect(args().external).toBeUndefined();
  });

  it('says so when the scan wrote no report, and keeps what the session said', () => {
    setMode('refuses');
    const r = scan('--effort', 'low');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('ended without writing a results file');
    expect(meta().security_scan).toMatchObject({ status: 'the session ended without writing a results file', said: 'No scan was started.' });
  });

  it('asks for a scan of the snapshot\'s head commit, from inside the snapshot, and takes the findings in', () => {
    setMode('ok');
    const r = scan('--effort', 'high', '--model', 'opus');
    expect(r.status, r.stderr).toBe(0);
    const head = execFileSync('git', ['-C', snap, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const prompt = fs.readFileSync(path.join(work, 'prompt.txt'), 'utf8');
    expect(prompt).toContain(`/claude-security:claude-security scan changes --commit ${head} --effort high`);
    expect(prompt).toContain('I understand that this scan may take a long time and use a lot of tokens');
    expect(prompt).toContain(`--cwd ${snap}`);
    expect(prompt).toContain('--model opus');
    expect(args().external).toEqual([expect.objectContaining({ title: 'Theirs', file: 'a.js', start_line: 1, by: 'claude-security', confidence: 'high' })]);
    expect(meta().security_scan).toMatchObject({ status: 'ran', effort: 'high', findings: 1, skipped: ['line 2: not JSON'], verification: 'verified', plugin_version: '0.12.0', list_price_usd: 1.5 });
    // Its report is moved out of the snapshot, so our own hunters can't find it there.
    expect(fs.readdirSync(snap).filter((n) => n.startsWith('CLAUDE-SECURITY'))).toEqual([]);
    expect(fs.existsSync(path.join(prep, 'claude-security/CLAUDE-SECURITY-20260101-000000/CLAUDE-SECURITY-RESULTS.md'))).toBe(true);
  });

  it('running it again replaces its findings instead of doubling them', () => {
    setMode('ok');
    expect(scan().status).toBe(0);
    expect(args().external).toHaveLength(1);
  });

  it('refuses options it does not understand', () => {
    expect(scan('--effort', 'max').stderr).toContain('--effort must be low, medium or high');
    expect(scan('--speed', 'fast').stderr).toContain('unknown option --speed');
  });
});

describe('ares: install.mjs puts the command and the kit where every project can use them', () => {
  it('copies the kit without any project\'s settings, and points the command at it', () => {
    const to = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-inst-'));
    const r = spawnSync('node', [path.resolve('install.mjs'), '--to', to], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const dest = path.join(to, 'ares'), kit = path.join(dest, 'kit');
    for (const f of ['prepare.mjs', 'scan.mjs', 'db.mjs', 'evidence.mjs', 'app.mjs', 'security-scan.mjs', 'other-models.mjs', 'selftest.mjs', 'selftest/answers.md', 'selftest/shop/src/money.js', 'finish.mjs', 'lib.mjs', 'ares.workflow.js', 'finder.md', 'recon.md', 'verify.md', 'score.md', 'lenses/tests.md', 'lenses/inputs.md', 'lenses/numbers.md', 'vendor/PROVENANCE.md']) expect(fs.existsSync(path.join(kit, f)), f).toBe(true);
    for (const f of ['project.json', 'project.md', 'lessons.md', 'README.md']) expect(fs.existsSync(path.join(kit, f)), f).toBe(false);
    const skill = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
    expect(skill).toContain(`node ${kit}/prepare.mjs`);
    expect(skill).not.toContain('{KIT}');
    expect(skill).not.toMatch(/\{KIT\}/);
    // The kit's own files name no project either.
    for (const f of ['finder.md', 'recon.md', 'verify.md', 'score.md', 'ares.workflow.js', 'prepare.mjs', 'finish.mjs', 'security-scan.mjs']) expect(fs.readFileSync(path.join(kit, f), 'utf8'), f).not.toContain(path.resolve('.'));   // no path back to the source repository
    fs.rmSync(to, { recursive: true, force: true });
  });
});

describe('ares: the arsenal (scanners, a real database, other vendors\' models)', () => {
  const F1 = { title: 'A', file: 'src/a.js', start_line: 1, claim: 'c', trigger: 't', consequence: 'q', confidence: 'medium' };
  const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F1] } : quiet(label, '', {});

  it('hunters are handed scanner output as leads to check, not as findings', async () => {
    const { calls } = await go({ leads: '/kit/leads.md' }, reply);
    const hunt = calls.find((c) => c.label === 'hunt slice:api')!.prompt;
    expect(hunt).toContain('/kit/leads.md'); expect(hunt).toContain('a lead to check against the code, not as a finding');
    expect((await go({}, reply)).calls.find((c) => c.label === 'hunt slice:api')!.prompt).not.toContain('scanners');
  });

  it('verifiers are told how to use a real database, each with its own copy', async () => {
    const db = { engine: 'Postgres', make_copy: 'createdb -T dr_template {name}', run_sql: 'psql -d {name}' };
    const { calls, result } = await go({ db, votes: 3 }, reply);
    const [a, b] = calls.filter((c) => c.label.startsWith('verify:f1')).map((c) => c.prompt);
    expect(a).toContain('createdb -T dr_template dr_f1_a'); expect(a).toContain('psql -d dr_f1_a'); expect(a).toContain('test/_dr_f1.db.sh');
    expect(b).toContain('dr_f1_b'); expect(b).toContain('test/_dr_f1_b.db.sh');
    expect(result.stats.database_available).toBe(true);
    expect((await go({}, reply)).calls.find((c) => c.label.startsWith('verify:f1'))!.prompt).not.toContain('database is running');
  });

  it('a database proof must exit 1 and print both markers, twice', () => {
    const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-db-')); fs.mkdirSync(path.join(snap, 'test'));
    const w = (n: string, body: string) => fs.writeFileSync(path.join(snap, 'test', `_dr_${n}.db.sh`), body);
    w('good', 'echo CONTROL OK; echo BUG SHOWN; exit 1'); w('nocontrol', 'echo BUG SHOWN; exit 1'); w('nobug', 'echo CONTROL OK; exit 0'); w('broken', 'echo CONTROL OK; echo BUG SHOWN; exit 127');
    const check = (n: string) => recheckTest({ snap, file: `test/_dr_${n}.db.sh` });
    expect(check('good')).toMatchObject({ holds: true });
    expect(check('nocontrol')).toMatchObject({ holds: false, why: 'there is no passing control case (CONTROL OK)' });
    expect(check('nobug')).toMatchObject({ holds: false, why: 'the script exits 0, so it shows no bug' });
    expect(check('broken')).toMatchObject({ holds: false, why: 'the script failed to run (it must exit 1 when the bug shows)' });
    expect(recheckTest({ snap, file: 'test/_dr_x.test.ts' })).toMatchObject({ holds: false });   // no runner, and no such file
    fs.rmSync(snap, { recursive: true, force: true });
  });

  it('reads another vendor\'s reply: the JSON list wherever it sits, and nothing else', () => {
    const text = 'Here you go:\n```json\n[{"title":"T","file":"a.js","line":"7","claim":"c","confidence":"HIGH"},{"title":"no file","claim":"c"}]\n```\nDone [1].';
    expect(findingsFrom(text, 'codex')).toEqual([{ title: 'T', file: 'a.js', start_line: 7, claim: 'c', trigger: 'not stated', consequence: 'not stated', fix: '', confidence: 'high', by: 'codex' }]);
    expect(findingsFrom('[]', 'gemini')).toEqual([]);
    expect(findingsFrom('I found nothing.', 'gemini')).toBeNull();
    expect(findingsFrom('{"not":"a list"}', 'gemini')).toBeNull();
  });

  describe('the plain-code stages, with stand-ins for the tools', () => {
    let work: string, prep: string, snap: string, bin: string;
    const node = (script: string, ...a: string[]) => spawnSync('node', [path.resolve(script), ...a], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}${path.dirname(process.execPath)}` } });
    const meta = () => JSON.parse(fs.readFileSync(path.join(prep, 'meta.json'), 'utf8'));
    const args = () => JSON.parse(fs.readFileSync(path.join(prep, 'args.json'), 'utf8'));
    const tool = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst fs = require('node:fs'); const a = process.argv.slice(2);\n${body}`, { mode: 0o755 });
    beforeAll(() => {
      work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-ars-')));
      prep = path.join(work, 'prep'); snap = path.join(prep, 'snap'); bin = path.join(work, 'bin');
      fs.mkdirSync(path.join(snap, 'src'), { recursive: true }); fs.mkdirSync(path.join(prep, 'kit')); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(snap, 'src/a.js'), 'x\n');
      fs.writeFileSync(path.join(prep, 'files.txt'), 'src/a.js\n');
      fs.writeFileSync(path.join(prep, 'args.json'), JSON.stringify({ root: snap, kit: path.join(prep, 'kit'), files: ['src/a.js'], file_list: path.join(prep, 'files.txt') }));
      fs.writeFileSync(path.join(prep, 'meta.json'), JSON.stringify({ tool: 'ares', slug: 't' }));
    });
    afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

    it('scan.mjs: with no scanner installed it says so and adds no leads', () => {
      const r = node('scan.mjs', '--prep', prep);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ran: [], skipped: ['semgrep: not installed', 'gitleaks: not installed', 'osv: not installed'] });
      expect(args().leads).toBeUndefined();
    });

    it('scan.mjs: keeps code flags only for files under review, lists every secret and vulnerable dependency, and withholds values', () => {
      tool('semgrep', `const out = a[a.indexOf('--output') + 1]; fs.writeFileSync(out, JSON.stringify({ results: [
        { path: 'src/a.js', start: { line: 3 }, check_id: 'js.lang.eval-use', extra: { severity: 'ERROR', message: 'eval of user input' } },
        { path: 'src/other.js', start: { line: 9 }, check_id: 'x.y', extra: { severity: 'WARNING', message: 'elsewhere' } }] }));`);
      tool('gitleaks', `const out = a[a.indexOf('--report-path') + 1]; fs.writeFileSync(out, JSON.stringify([{ File: 'src/a.js', StartLine: 5, RuleID: 'generic-api-key', Description: 'API key', Secret: 'REDACTED' }, { File: 'config/x.env', StartLine: 1, RuleID: 'aws', Description: 'AWS key' }]));`);
      tool('osv-scanner', `process.stdout.write(JSON.stringify({ results: [{ source: { path: process.cwd() + '/package-lock.json' }, packages: [{ package: { name: 'left-pad', version: '1.0.0' }, vulnerabilities: [{ id: 'GHSA-1', summary: 'bad', database_specific: { severity: 'HIGH' } }] }] }] })); process.exit(1);`);
      const r = node('scan.mjs', '--prep', prep);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ran: ['semgrep', 'gitleaks', 'osv-scanner'], code_leads: 1, secrets: 2, vulnerable_dependencies: 1 });
      const leads = fs.readFileSync(args().leads, 'utf8');
      expect(leads).toContain('src/a.js:3 [semgrep eval-use] eval of user input'); expect(leads).toContain('src/a.js:5 [gitleaks generic-api-key]');
      expect(leads).not.toContain('other.js'); expect(leads).not.toContain('x.env');
      const all = JSON.parse(fs.readFileSync(path.join(prep, 'scanners.json'), 'utf8'));
      expect(all.secrets.map((s: any) => [s.file, s.under_review])).toEqual([['src/a.js', true], ['config/x.env', false]]);
      expect(all.dependencies[0]).toMatchObject({ package: 'left-pad', id: 'GHSA-1', severity: 'high', lockfile: 'package-lock.json' });
      expect(JSON.stringify(all)).not.toContain('REDACTED');
      expect(node('scan.mjs', '--prep', prep, '--skip', 'semgrep,gitleaks,osv').stdout).toContain('turned off');
    });

    it('other-models.mjs: runs only tools that are installed, inside the snapshot, and takes their findings in', () => {
      expect(JSON.parse(node('other-models.mjs', '--prep', prep).stdout)).toEqual({ codex: { status: 'not installed' }, gemini: { status: 'not installed' } });
      tool('codex', `fs.writeFileSync(${JSON.stringify(path.join(work, 'codex-call.txt'))}, process.cwd() + '\\n' + a.join(' ')); fs.writeFileSync(a[a.indexOf('--output-last-message') + 1], '[{"title":"From codex","file":"src/a.js","line":2,"claim":"c"}]');`);
      tool('gemini', `process.stdout.write('I could not sign in.'); process.exit(1);`);
      const r = node('other-models.mjs', '--prep', prep);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ codex: { status: 'ran', findings: 1 }, gemini: { status: 'exited with code 1 (is it signed in?)' } });
      const call = fs.readFileSync(path.join(work, 'codex-call.txt'), 'utf8');
      expect(call.startsWith(snap)).toBe(true); expect(call).toContain('--sandbox read-only'); expect(call).toContain('Do not change any file');
      expect(args().external).toEqual([expect.objectContaining({ title: 'From codex', by: 'codex', start_line: 2 })]);
      node('other-models.mjs', '--prep', prep);
      expect(args().external).toHaveLength(1);   // running it again replaces, not doubles
      expect(meta().other_models.codex.status).toBe('ran');
    });

    it('db.mjs: does nothing when the project declares no database, and refuses an engine it doesn\'t know', () => {
      expect(JSON.parse(node('db.mjs', 'start', '--prep', prep).stdout)).toMatchObject({ status: 'none' });
      fs.writeFileSync(path.join(prep, 'meta.json'), JSON.stringify({ ...meta(), project_database: { engine: 'mysql', setup: [] } }));
      expect(node('db.mjs', 'start', '--prep', prep).stderr).toContain('only "postgres" is supported');
      expect(args().db).toBeUndefined();
    });
  });
});

describe('ares: evidence, the test bed and proofs against running things', () => {
  const F1 = { title: 'A', file: 'src/a.js', start_line: 1, claim: 'c', trigger: 't', consequence: 'q', confidence: 'medium' };
  const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F1] } : quiet(label, '', {});

  it('with a test bed running, one more hunter may send it requests, and verifiers are told how to prove a finding on it', async () => {
    const { calls, labels, result } = await go({ app: { url: 'http://127.0.0.1:5555', notes: '/kit/testbed.md' } }, reply);
    expect(labels).toContain('hunt live');
    const live = calls.find((c) => c.label === 'hunt live')!.prompt;
    expect(live).toContain('http://127.0.0.1:5555'); expect(live).toContain('/kit/testbed.md'); expect(live).toContain('and only to it');
    const v = calls.find((c) => c.label.startsWith('verify:f1'))!.prompt;
    expect(v).toContain('http://127.0.0.1:5555'); expect(v).toContain('test/_dr_f1.live.sh');
    expect(result.stats.test_bed_available).toBe(true);
    expect((await go({}, reply)).labels).not.toContain('hunt live');
  });

  it('hunters are pointed at earlier fixes, and verifiers at property testing, only when they exist', async () => {
    const withAll = await go({ history: '/kit/history.md', property_testing: 'fast-check', test_cmd: 'npx vitest run' }, reply);
    expect(withAll.calls.find((c) => c.label === 'hunt slice:api')!.prompt).toContain('/kit/history.md');
    expect(withAll.calls.find((c) => c.label.startsWith('verify:f1'))!.prompt).toContain('fast-check');
    const none = await go({ test_cmd: 'npx vitest run' }, reply);
    expect(none.calls.find((c) => c.label === 'hunt slice:api')!.prompt).not.toContain('Earlier fixes');
    expect(none.calls.find((c) => c.label.startsWith('verify:f1'))!.prompt).not.toContain('property test');
  });

  it('a proof against the test bed is held to the same rule as one against the database', () => {
    const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-live-')); fs.mkdirSync(path.join(snap, 'test'));
    fs.writeFileSync(path.join(snap, 'test/_dr_f1.live.sh'), 'echo CONTROL OK; echo BUG SHOWN; exit 1');
    fs.writeFileSync(path.join(snap, 'test/_dr_f2.live.sh'), 'echo BUG SHOWN; exit 1');
    expect(recheckTest({ snap, file: 'test/_dr_f1.live.sh' })).toMatchObject({ holds: true });
    expect(recheckTest({ snap, file: 'test/_dr_f2.live.sh' })).toMatchObject({ holds: false });
    fs.rmSync(snap, { recursive: true, force: true });
  });

  it('requests to the local test bed don\'t count as leaving the snapshot; requests anywhere else do', () => {
    const ag = (cmd: string) => ({ label: 'verify:f1', calls: [{ tool: 'Bash', input: JSON.stringify({ command: cmd }) }], usage: { input: 0, cache_write: 0, cache_read: 0, output: 0 } });
    expect(auditBlindness([ag('curl -s http://127.0.0.1:5555/api/admin/me')], { repo: '/r', allowed: [] })).toEqual([]);
    expect(auditBlindness([ag('curl -s https://example.com/x')], { repo: '/r', allowed: [] })).toHaveLength(1);
  });

  describe('app.mjs and evidence.mjs, for real', () => {
    let work: string, prep: string, snap: string, repo: string;
    const node = (script: string, ...a: string[]) => spawnSync('node', [path.resolve(script), ...a], { encoding: 'utf8' });
    const read = (f: string) => JSON.parse(fs.readFileSync(path.join(prep, f), 'utf8'));
    const setMeta = (extra: any) => fs.writeFileSync(path.join(prep, 'meta.json'), JSON.stringify({ tool: 'ares', slug: 't', repo, at_sha: 'HEAD', ...extra }));
    beforeAll(() => {
      work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-ev-')));
      prep = path.join(work, 'prep'); snap = path.join(prep, 'snap'); repo = path.join(work, 'repo');
      fs.mkdirSync(path.join(snap, 'src'), { recursive: true }); fs.mkdirSync(path.join(prep, 'kit')); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(snap, 'src/a.js'), 'x\n');
      fs.writeFileSync(path.join(snap, 'server.mjs'), `import http from 'node:http'; http.createServer((q, s) => { s.end(q.url === '/health' ? 'ok' : 'hello from ' + process.cwd()) }).listen(Number(process.env.PORT), '127.0.0.1')`);
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
      git('init', '-q'); fs.writeFileSync(path.join(repo, 'src/a.js'), '1\n'); git('add', '-A'); git('commit', '-q', '-m', 'add a');
      fs.writeFileSync(path.join(repo, 'src/a.js'), '2\n'); git('add', '-A'); git('commit', '-q', '-m', 'fix: a counted twice', '-m', 'The total was doubled.');
      fs.writeFileSync(path.join(repo, 'src/a.js'), '3\n'); git('add', '-A'); git('commit', '-q', '-m', 'tidy');
      fs.writeFileSync(path.join(prep, 'args.json'), JSON.stringify({ root: snap, kit: path.join(prep, 'kit'), files: ['src/a.js'] }));
    });
    afterAll(() => { node('app.mjs', 'stop', '--prep', prep); fs.rmSync(work, { recursive: true, force: true }); });

    it('app.mjs: nothing declared, nothing started', () => {
      setMeta({});
      expect(JSON.parse(node('app.mjs', 'start', '--prep', prep).stdout)).toMatchObject({ status: 'none' });
      expect(read('args.json').app).toBeUndefined();
    });

    it('app.mjs: starts the project\'s command in the snapshot on a free port, waits until it answers, and stops it', async () => {
      setMeta({ project_app: { start: 'node server.mjs', ready_path: '/health' } });
      const r = node('app.mjs', 'start', '--prep', prep);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const url = read('args.json').app.url;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(url + '/x')).text()).toBe('hello from ' + snap);
      expect(JSON.parse(node('app.mjs', 'stop', '--prep', prep).stdout)).toEqual({ stopped: true });
      await new Promise((res) => setTimeout(res, 300));
      await expect(fetch(url + '/x')).rejects.toThrow();
    });

    it('app.mjs: says so when the command never comes up, and offers no test bed', () => {
      setMeta({ project_app: { start: 'node -e "process.exit(1)"' } });
      const r = node('app.mjs', 'start', '--prep', prep);
      expect(r.status).toBe(3);
      expect(read('meta.json').app.status).toContain('did not come up');
      expect(read('args.json').app).toBeUndefined();
    });

    it('evidence.mjs: lists earlier fix commits for these files, names what it could not run, and leaves history out of a blind run', () => {
      setMeta({});
      const r = node('evidence.mjs', '--prep', prep);
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.history).toBe('ran, 1 earlier fixes');
      expect(out.types).toContain('not installed'); expect(out.coverage).toContain('needs Vitest'); expect(out.mutation).toContain('not installed');
      const hist = fs.readFileSync(read('args.json').history, 'utf8');
      expect(hist).toContain('fix: a counted twice'); expect(hist).toContain('The total was doubled.'); expect(hist).not.toContain('tidy');
      setMeta({ blind: true });
      expect(JSON.parse(node('evidence.mjs', '--prep', prep).stdout).history).toBe('left out of a blind run');
      expect(read('args.json').history).toBeUndefined();
      expect(JSON.parse(node('evidence.mjs', '--prep', prep, '--skip', 'types,coverage,mutation,history').stdout)).toEqual({ types: 'turned off', coverage: 'turned off', mutation: 'turned off', history: 'turned off' });
    });
  });
});

describe('ares: accepted findings and telling new findings from old', () => {
  const F1 = { title: 'Export skips the role check', file: 'src/a.js', start_line: 1, claim: 'c', trigger: 't', consequence: 'q', confidence: 'medium' };
  const reply: Reply = (label) => label.startsWith('hunt slice') ? { findings: [F1] } : label.startsWith('verify') ? { verdict: 'confirmed', reason: 'r', proof: 'code', severity: 'high' } : quiet(label, '', {});

  it('hunters and verifiers are told what the owner already accepted', async () => {
    const { calls } = await go({ accepted: '/kit/accepted.md' }, reply);
    expect(calls.find((c) => c.label === 'hunt slice:api')!.prompt).toContain('/kit/accepted.md');
    expect(calls.find((c) => c.label.startsWith('verify:f1'))!.prompt).toContain('/kit/accepted.md');
  });

  it('finish.mjs gives each finding a stable id, marks ones seen in an earlier report, keeps both reports, and can fail a script', async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-fin-')));
    const dest = path.join(work, 'dest');
    const once = async (title: string, line: number, extra: string[] = []) => {
      const prep = path.join(work, 'prep'), tr = path.join(work, 'tr'); fs.rmSync(prep, { recursive: true, force: true }); fs.rmSync(tr, { recursive: true, force: true });
      fs.mkdirSync(path.join(prep, 'snap'), { recursive: true }); fs.mkdirSync(tr);
      const args = { root: path.join(prep, 'snap'), kit: path.join(prep, 'kit'), files: ['src/a.js', 'src/b.js'], votes: 1 };
      fs.writeFileSync(path.join(prep, 'args.json'), JSON.stringify(args));
      fs.writeFileSync(path.join(prep, 'meta.json'), JSON.stringify({ tool: 'ares', repo: work, slug: 'demo', scope: ['src'], at: 'HEAD', at_sha: 'abcdef1234567890', files: 2, lines: 10 }));
      const rows: any[] = []; let n = 0;
      const rep: Reply = (label) => label.startsWith('hunt slice') ? { findings: [{ ...F1, title, start_line: line }] } : reply(label, '', {});
      await runWorkflow(args, async (_p: string, o: any) => { const id = 'a' + n++; const r = rep(o.label, '', o); rows.push({ type: 'started', agentId: id, label: o.label }, { type: 'result', agentId: id, result: r }); return r; });
      fs.writeFileSync(path.join(tr, 'journal.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
      return spawnSync('node', [path.resolve('finish.mjs'), '--prep', prep, '--transcripts', tr, '--dest', dest, ...extra], { encoding: 'utf8' });
    };
    const r1 = await once('Export skips the role check', 1);
    expect(r1.status, r1.stderr).toBe(0);
    const r2 = await once('Export skips the role check!', 40, ['--fail-on', 'high']);   // same problem, line moved, wording nudged
    expect(r2.status).toBe(2);                                                           // a high finding fails the script
    const names = fs.readdirSync(dest).filter((n) => n.endsWith('.json')).sort((x, y) => x.length - y.length);
    expect(names).toHaveLength(2);                                                       // the second report doesn't overwrite the first
    const [a, b] = names.map((n) => JSON.parse(fs.readFileSync(path.join(dest, n), 'utf8')).confirmed[0]);
    expect(a.fingerprint).toBe(b.fingerprint); expect(a.first_seen).toBeNull(); expect(b.first_seen).toBe(names[0].replace('.json', ''));
    expect(fs.readFileSync(path.join(dest, names[1].replace('.json', '.md')), 'utf8')).toContain('Still open: first reported in');
    const sarif = JSON.parse(fs.readFileSync(path.join(dest, names[0].replace('.json', '.sarif')), 'utf8'));
    expect(sarif.runs[0].results[0]).toMatchObject({ level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.js' } } }] });
    expect((await once('Something low', 1, ['--fail-on', 'critical'])).status).toBe(0);
    fs.rmSync(work, { recursive: true, force: true });
  });
});

describe('ares: the self-test project and Node\'s own test runner', () => {
  it('selftest.mjs makes a committed copy of the planted-bug project, without the answers inside it', () => {
    const r = spawnSync('node', [path.resolve('selftest.mjs')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const { repo, answers } = JSON.parse(r.stdout);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['README.md', 'package.json', 'src/money.js', 'src/orders.js', 'src/routes.js', 'src/store.js', 'test/shop.test.js']);
    expect(fs.existsSync(answers)).toBe(true); expect(answers.startsWith(repo)).toBe(false);
    expect((fs.readFileSync(answers, 'utf8').match(/^\| \d /gm) || []).length).toBe(8);
    // Its own tests pass, as a real project's would: the bugs hide behind green tests.
    expect(spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8' }).status).toBe(0);
    // With no settings at all, prepare works out how to run its tests.
    const out = path.join(path.dirname(repo), 'run');
    const p = spawnSync('node', [path.resolve('prepare.mjs'), '--scope', 'src', '--blind', '--no-scan', '--no-evidence', '--out', out], { cwd: repo, encoding: 'utf8' });
    expect(p.status, p.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'args.json'), 'utf8'))).toMatchObject({ test_cmd: 'node --test', test_dir: 'test', test_ext: 'test.js', files: ['src/money.js', 'src/orders.js', 'src/routes.js', 'src/store.js'] });
    // A proof written for Node's runner is held to the same rule: a failing case and a passing control.
    const snap = path.join(out, 'snap');
    fs.writeFileSync(path.join(snap, 'test/_dr_f1.test.js'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { page } from '../src/money.js';\ntest('control', () => { assert.equal(page([1, 2, 3], 2, 10).length, 0); });\ntest('a full page has ten items', () => { assert.equal(page(Array.from({ length: 30 }, (_, i) => i), 1, 10).length, 10); });`);
    fs.writeFileSync(path.join(snap, 'test/_dr_f2.test.js'), `import { test } from 'node:test'; import assert from 'node:assert/strict';\ntest('only fails', () => { assert.equal(1, 2); });`);
    expect(recheckTest({ snap, testCmd: 'node --test', file: 'test/_dr_f1.test.js' })).toMatchObject({ holds: true });
    expect(recheckTest({ snap, testCmd: 'node --test', file: 'test/_dr_f2.test.js' })).toMatchObject({ holds: false, why: 'there is no passing control case' });
    fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });
});
