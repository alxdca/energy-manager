import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CarAutomationState, CarCheckpoint, CarTargetOverride } from './car-types.js';

const storageError = 'L’état persistant de la planification voiture est indisponible.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9_-]{1,80}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const target = (value: unknown): value is CarTargetOverride => object(value) && Object.keys(value).length === 2
  && timestamp(value.deadline) && percent(value.targetSocPercent) && value.targetSocPercent > 0;
const checkpoint = (value: unknown): value is CarCheckpoint => object(value)
  && Object.keys(value).every(key => ['date', 'targetSocPercent', 'observedSocPercent', 'result', 'recordedAt', 'kind'].includes(key))
  && Object.keys(value).length === 6
  && (value.kind === 'morning' || value.kind === 'afternoon')
  && date(value.date) && percent(value.targetSocPercent) && value.targetSocPercent > 0
  && (value.observedSocPercent === null || percent(value.observedSocPercent)) && timestamp(value.recordedAt)
  && ['met', 'missed', 'unknown'].includes(value.result as string)
  && (value.result !== 'met' || value.observedSocPercent !== null && value.observedSocPercent >= value.targetSocPercent)
  && (value.result !== 'missed' || value.observedSocPercent !== null && value.observedSocPercent < value.targetSocPercent);

interface RecordState {
  version: 1;
  owner: string;
  manualOverride: boolean;
  epoch: string | null;
  revision: number;
  targetOverride: CarTargetOverride | null;
  lastCheckpoint: CarCheckpoint | null;
  completedTarget: CarTargetOverride | null;
}

/** A missing file opts out; a corrupt file is preserved rather than inventing authority. */
export async function createCarAutomationState(filePath: string): Promise<CarAutomationState> {
  let state: RecordState = { version: 1, owner: randomUUID(), manualOverride: true, epoch: null,
    revision: 0, targetOverride: null, lastCheckpoint: null, completedTarget: null };
  let error: string | null = null;
  let corrupt = false;
  let missing = false;
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!object(value) || !Object.keys(value).every(key => ['version', 'owner', 'manualOverride', 'epoch', 'revision',
      'targetOverride', 'lastCheckpoint', 'completedTarget'].includes(key))
      || Object.keys(value).length !== (Object.hasOwn(value, 'completedTarget') ? 8 : 7) || value.version !== 1
      || typeof value.owner !== 'string' || !uuid.test(value.owner) || typeof value.manualOverride !== 'boolean'
      || !(value.epoch === null || typeof value.epoch === 'string' && identifier.test(value.epoch))
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
      || value.epoch === null && (!value.manualOverride || value.revision !== 0)
      || !(value.targetOverride === null || target(value.targetOverride))
      || !(value.lastCheckpoint === null || checkpoint(value.lastCheckpoint))
      || Object.hasOwn(value, 'completedTarget') && !(value.completedTarget === null || target(value.completedTarget))) throw new Error(storageError);
    // Existing version-1 files predate completion tracking.
    state = { ...structuredClone(value), completedTarget: value.completedTarget ?? null } as unknown as RecordState;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
    else { corrupt = true; error = storageError; }
  }
  let pending = Promise.resolve();
  async function write(snapshot: RecordState) {
    if (corrupt) throw new Error(storageError);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(snapshot)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, filePath);
      const directory = await open(dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      error = null;
    } catch { error = storageError; throw new Error(storageError); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  const update = (changes: Partial<RecordState>) => {
    state = { ...state, ...changes };
    const snapshot = structuredClone(state);
    const operation = pending.then(() => write(snapshot));
    pending = operation.catch(() => {});
    return operation;
  };
  if (missing) await write(state).catch(() => {});
  return {
    get owner() { return state.owner; }, get manualOverride() { return state.manualOverride; },
    get epoch() { return state.epoch; }, get revision() { return state.revision; }, get error() { return error; },
    get targetOverride() { return structuredClone(state.targetOverride); },
    get lastCheckpoint() { return structuredClone(state.lastCheckpoint); },
    get completedTarget() { return structuredClone(state.completedTarget); },
    setManualOverride(value) {
      if (typeof value !== 'boolean' || !value && state.epoch === null) return Promise.reject(new Error('Une session autorisée est nécessaire avant le mode auto.'));
      return update({ manualOverride: value });
    },
    setSession(epoch, revision) {
      if (!(epoch === null || typeof epoch === 'string' && identifier.test(epoch)) || !Number.isSafeInteger(revision) || revision < 0
        || epoch === null && (!state.manualOverride || revision !== 0)
        || epoch === state.epoch && revision < state.revision) return Promise.reject(new Error('Session voiture invalide.'));
      return update({ epoch, revision });
    },
    setTargetOverride(value) {
      if (value !== null && !target(value)) return Promise.reject(new Error('Objectif voiture invalide.'));
      return update({ targetOverride: structuredClone(value) });
    },
    setCheckpoint(value) {
      if (!checkpoint(value)) return Promise.reject(new Error('Bilan voiture invalide.'));
      return update({ lastCheckpoint: structuredClone(value) });
    },
    setCompletedTarget(value) {
      if (value !== null && !target(value)) return Promise.reject(new Error('Objectif voiture atteint invalide.'));
      return update({ completedTarget: structuredClone(value) });
    },
  };
}
