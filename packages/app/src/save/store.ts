/**
 * The save store: IndexedDB, five rotating autosave slots and named manual
 * saves (PRD 3.10, 7.4).
 *
 * It lives in `packages/app` rather than `packages/sim` because IndexedDB is a
 * DOM API and the simulation may not touch one (CLAUDE.md rule 2). The split
 * is clean: `@blockwork/sim` owns the bytes of a save and every way they can
 * be wrong, and this owns where those bytes are kept.
 *
 * **Rotation.** Autosaves occupy a fixed set of five keys. Each write goes to
 * an unused slot if there is one, and otherwise to the slot holding the oldest
 * autosave, which is decided by a stored monotonic sequence rather than by a
 * timestamp. A device clock can move backwards — a manual change, a timezone
 * update, an iPad that lost its battery — and the one thing rotation must
 * never do is overwrite the newest save because the clock disagreed.
 *
 * **Records hold the whole container.** A record stores the exact `.blockwork`
 * bytes, so exporting a save to the Files app is a copy rather than a
 * re-encode, and a save that fails to load can still be exported and looked at.
 * The summary fields beside it are denormalised from the header so that
 * listing saves never inflates a payload.
 */

import { SaveError, readSaveHeader } from '@blockwork/sim'

/** PRD 7.4: five rotating autosave slots. */
export const AUTOSAVE_SLOT_COUNT = 5

export const SAVE_DATABASE_NAME = 'blockwork-saves'
export const SAVE_DATABASE_VERSION = 1
export const SAVE_STORE_NAME = 'saves'

/** Longest manual save name. Long enough to be descriptive, short enough to list. */
export const MAX_SAVE_NAME_LENGTH = 64

export type SaveKind = 'auto' | 'manual'

/** What listing a save tells you, without touching its bytes. */
export interface SaveSummary {
  /** Primary key: `auto:<slot>` or `manual:<name>`. */
  readonly key: string
  readonly kind: SaveKind
  /** Display name. For an autosave, the slot number as a label. */
  readonly name: string
  /** 0..`AUTOSAVE_SLOT_COUNT` - 1 for autosaves, -1 for manual saves. */
  readonly slot: number
  /** Monotonic write counter. Higher is newer, whatever the clock says. */
  readonly sequence: number
  /** ISO 8601, for display only. Never used to order anything. */
  readonly savedAt: string
  /** The payload schema version, straight from the container header. */
  readonly schemaVersion: number
  readonly playedTicks: number
  readonly mapSize: number
  readonly byteLength: number
}

interface SaveRecord extends SaveSummary {
  readonly data: ArrayBuffer
}

/** What the store cannot read out of the container header itself. */
export interface SaveDescriptor {
  readonly savedAt: string
  readonly playedTicks: number
  readonly mapSize: number
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result)
    }
    request.onerror = (): void => {
      reject(request.error ?? new Error('the save database rejected a request'))
    }
  })
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = (): void => {
      resolve()
    }
    transaction.onerror = (): void => {
      reject(transaction.error ?? new Error('the save database rejected a transaction'))
    }
    transaction.onabort = (): void => {
      reject(transaction.error ?? new Error('the save database aborted a transaction'))
    }
  })
}

export function autosaveKey(slot: number): string {
  return `auto:${slot}`
}

export function manualSaveKey(name: string): string {
  return `manual:${name}`
}

/**
 * Names are user input and they are also half of a primary key, so an empty
 * or overlong one is refused here rather than becoming an unreachable record.
 */
function assertSaveName(name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new SaveError('invalid-save', 'a manual save needs a name')
  }
  if (trimmed.length > MAX_SAVE_NAME_LENGTH) {
    throw new SaveError(
      'invalid-save',
      `a save name may be at most ${MAX_SAVE_NAME_LENGTH} characters, received ${trimmed.length}`,
    )
  }
}

/**
 * Picks the slot the next autosave overwrites: the first unused one, or the
 * one holding the lowest sequence.
 */
export function nextAutosaveSlot(existing: readonly SaveSummary[]): number {
  const bySlot = new Map<number, SaveSummary>()
  for (const summary of existing) {
    if (summary.kind === 'auto') bySlot.set(summary.slot, summary)
  }

  let oldest = 0
  for (let slot = 0; slot < AUTOSAVE_SLOT_COUNT; slot += 1) {
    const occupant = bySlot.get(slot)
    if (occupant === undefined) return slot

    const incumbent = bySlot.get(oldest)
    if (incumbent === undefined || occupant.sequence < incumbent.sequence) oldest = slot
  }
  return oldest
}

function summaryOf(record: SaveRecord): SaveSummary {
  const { data: _data, ...summary } = record
  return summary
}

export class SaveStore {
  readonly #database: IDBDatabase

  private constructor(database: IDBDatabase) {
    this.#database = database
  }

  /** Opens, creating or upgrading the object store as needed. */
  static async open(name: string = SAVE_DATABASE_NAME): Promise<SaveStore> {
    const request = indexedDB.open(name, SAVE_DATABASE_VERSION)

    request.onupgradeneeded = (): void => {
      const database = request.result
      if (!database.objectStoreNames.contains(SAVE_STORE_NAME)) {
        const store = database.createObjectStore(SAVE_STORE_NAME, { keyPath: 'key' })
        store.createIndex('kind', 'kind', { unique: false })
        store.createIndex('sequence', 'sequence', { unique: false })
      }
    }

    return new SaveStore(await promisify(request))
  }

  /** Every save, newest first. Reads summaries only, never payloads. */
  async list(): Promise<readonly SaveSummary[]> {
    const transaction = this.#database.transaction(SAVE_STORE_NAME, 'readonly')
    const records = await promisify(
      transaction.objectStore(SAVE_STORE_NAME).getAll() as IDBRequest<SaveRecord[]>,
    )
    await settled(transaction)

    return records.map(summaryOf).sort((a, b) => b.sequence - a.sequence)
  }

  /** The container bytes for a key, or null if there is no such save. */
  async read(key: string): Promise<Uint8Array | null> {
    const transaction = this.#database.transaction(SAVE_STORE_NAME, 'readonly')
    const record = await promisify(
      transaction.objectStore(SAVE_STORE_NAME).get(key) as IDBRequest<SaveRecord | undefined>,
    )
    await settled(transaction)

    return record === undefined ? null : new Uint8Array(record.data)
  }

  /**
   * Writes the next autosave, overwriting the oldest slot once all five are
   * in use, and returns the summary of what was written.
   */
  async putAutosave(bytes: Uint8Array, descriptor: SaveDescriptor): Promise<SaveSummary> {
    return this.#put(bytes, descriptor, (existing) => {
      const slot = nextAutosaveSlot(existing)
      return { key: autosaveKey(slot), kind: 'auto', name: `Autosave ${slot + 1}`, slot }
    })
  }

  /** Writes a named save, replacing any existing save of the same name. */
  async putManualSave(
    name: string,
    bytes: Uint8Array,
    descriptor: SaveDescriptor,
  ): Promise<SaveSummary> {
    assertSaveName(name)
    const trimmed = name.trim()

    return this.#put(bytes, descriptor, () => ({
      key: manualSaveKey(trimmed),
      kind: 'manual',
      name: trimmed,
      slot: -1,
    }))
  }

  async delete(key: string): Promise<void> {
    const transaction = this.#database.transaction(SAVE_STORE_NAME, 'readwrite')
    transaction.objectStore(SAVE_STORE_NAME).delete(key)
    await settled(transaction)
  }

  close(): void {
    this.#database.close()
  }

  /**
   * Choosing the key and allocating the sequence happen inside the same
   * transaction as the write, so two saves that land together cannot pick the
   * same autosave slot or the same sequence number.
   */
  async #put(
    bytes: Uint8Array,
    descriptor: SaveDescriptor,
    identify: (existing: readonly SaveSummary[]) => {
      readonly key: string
      readonly kind: SaveKind
      readonly name: string
      readonly slot: number
    },
  ): Promise<SaveSummary> {
    // Reading the header first means the store can never accept something
    // that is not a save, which is what makes `list()` trustworthy.
    const header = readSaveHeader(bytes)

    const transaction = this.#database.transaction(SAVE_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(SAVE_STORE_NAME)
    const existing = await promisify(store.getAll() as IDBRequest<SaveRecord[]>)

    const identity = identify(existing.map(summaryOf))
    const highest = existing.reduce((max, record) => Math.max(max, record.sequence), 0)
    const record: SaveRecord = {
      ...identity,
      sequence: highest + 1,
      savedAt: descriptor.savedAt,
      schemaVersion: header.schemaVersion,
      playedTicks: descriptor.playedTicks,
      mapSize: descriptor.mapSize,
      byteLength: bytes.byteLength,
      // A detached copy: the caller's view may be a window onto a larger
      // buffer, and structured clone would otherwise store all of it.
      data: bytes.slice().buffer,
    }

    store.put(record)
    await settled(transaction)

    return summaryOf(record)
  }
}
