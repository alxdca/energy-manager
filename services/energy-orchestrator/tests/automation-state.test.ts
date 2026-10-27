import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAutomationState } from '../src/automation-state.js';

async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'energy-automation-')); return { directory, file: join(directory, 'automation.json') }; }

test('private atomic state retains stable owner and manual override across restart', async () => {
  const f = await fixture();
  try {
    const initial = await createAutomationState(f.file);
    assert.equal(initial.error, null); assert.equal(initial.manualOverride, false);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    await initial.setManualOverride(true);
    const restarted = await createAutomationState(f.file);
    assert.equal(restarted.owner, initial.owner); assert.equal(restarted.manualOverride, true);
    await restarted.setManualOverride(false);
    assert.equal((await createAutomationState(f.file)).manualOverride, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('serialized writes preserve last manual decision while changing memory immediately', async () => {
  const f = await fixture();
  try {
    const state = await createAutomationState(f.file);
    const a = state.setManualOverride(true); assert.equal(state.manualOverride, true);
    const b = state.setManualOverride(false); assert.equal(state.manualOverride, false);
    await Promise.all([a, b]);
    assert.equal((await createAutomationState(f.file)).manualOverride, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('corrupt and unknown-version files are preserved and cannot enable automation', async () => {
  const f = await fixture();
  try {
    for (const value of ['{oops', JSON.stringify({ version: 2, owner: 'bad', manualOverride: false }), JSON.stringify({ version: 1, owner: 'bad', manualOverride: false })]) {
      await writeFile(f.file, value);
      const state = await createAutomationState(f.file);
      assert.ok(state.error); await assert.rejects(state.setManualOverride(false));
      assert.equal(await readFile(f.file, 'utf8'), value);
    }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('unwritable state is reported without falling back to transient ownership', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, 'parent is a file');
    const state = await createAutomationState(join(f.file, 'child.json'));
    assert.ok(state.error); await assert.rejects(state.setManualOverride(false));
    assert.equal(await readFile(f.file, 'utf8'), 'parent is a file');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
