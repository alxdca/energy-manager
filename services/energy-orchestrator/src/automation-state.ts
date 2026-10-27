import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AutomationState {
  readonly owner: string;
  readonly manualOverride: boolean;
  readonly error: string | null;
  setManualOverride(value: boolean): Promise<void>;
}

const storageError = 'L’état persistant du pilotage automatique est indisponible.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A corrupt file is preserved: inventing a new owner could orphan a live charge lease. */
export async function createAutomationState(filePath: string): Promise<AutomationState> {
  let owner: string = randomUUID();
  let manualOverride = false;
  let error: string | null = null;
  let corrupt = false;
  let missing = false;
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 3 || record.version !== 1
      || typeof record.owner !== 'string' || !uuid.test(record.owner)
      || typeof record.manualOverride !== 'boolean') throw new Error();
    owner = record.owner;
    manualOverride = record.manualOverride;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
    else { error = storageError; corrupt = true; }
  }
  let pending = Promise.resolve();
  async function write(value: boolean) {
    if (corrupt) throw new Error(storageError);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ version: 1, owner, manualOverride: value })}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, filePath);
      error = null;
    } catch {
      error = storageError;
      throw new Error(storageError);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  if (missing) await write(false).catch(() => {});
  return {
    get owner() { return owner; },
    get manualOverride() { return manualOverride; },
    get error() { return error; },
    setManualOverride(value) {
      if (typeof value !== 'boolean') return Promise.reject(new Error('Invalid manual override'));
      // Disable automation immediately, including while the serialized checkpoint is pending.
      manualOverride = value;
      const operation = pending.then(() => write(value));
      pending = operation.catch(() => {});
      return operation;
    },
  };
}
