/**
 * Export and import of `.blockwork` files (PRD 7.4).
 *
 * A save in IndexedDB belongs to the app; a save in the Files app belongs to
 * the player. This module moves bytes between the two so a prison can be
 * backed up, moved between an iPad and a Mac, or sent to someone else.
 *
 * **Three delivery paths, in order of preference.** The web platform has never
 * settled on one way to hand a file to the user, and the ones that exist are
 * unevenly implemented in the webview Blockwork ships in:
 *
 *   1. The File System Access API (`showSaveFilePicker`), where the player
 *      chooses the destination and iPadOS routes it into the Files app.
 *   2. An anchor with a `download` attribute and an object URL, which is what
 *      every browser without the picker still honours.
 *   3. A caller-supplied `deliver` function, which is how the Capacitor build
 *      will plug in the Filesystem and Share plugins. Those are not installed
 *      yet — Capacitor packaging is T6.8 — and the alternative to leaving a
 *      seam here would be a module that cannot run on the target platform at
 *      all.
 *
 * Import is the same story in reverse: `showOpenFilePicker` where it exists, a
 * hidden `<input type="file">` where it does not.
 *
 * Nothing here validates a save. `readSaveFile` returns bytes;
 * `decodeSaveFile` in `@blockwork/sim` decides whether they mean anything. A
 * player who picks a photo from the Files app should get "this file is not a
 * Blockwork save", which is that function's job, not this one's.
 */

import { SAVE_FILE_EXTENSION } from '@blockwork/sim'

/** Opaque bytes: the container is gzip, and nothing should try to sniff it. */
export const SAVE_MIME_TYPE = 'application/octet-stream'

/** Hands the finished file to the platform. Returns false if the player cancelled. */
export type SaveDelivery = (bytes: Uint8Array, fileName: string) => Promise<boolean>

/** Produces the bytes of a file the player chose, or null if they cancelled. */
export type SavePickup = () => Promise<Uint8Array | null>

export interface ExportOptions {
  /** Used to build the file name. Usually the save's display name. */
  readonly name: string
  /** Stamped into the file name so exports of the same prison do not collide. */
  readonly savedAt: Date
  /** Overrides platform detection. The Capacitor build supplies its own. */
  readonly deliver?: SaveDelivery
}

/** Everything a file system is likely to object to, plus leading dots. */
const UNSAFE_FILE_NAME = /[^\p{L}\p{N} ._-]+/gu

/**
 * `Wing C 12 Mar 2031 14-05.blockwork`.
 *
 * The timestamp is local and human-readable rather than ISO: this is a name a
 * player reads in a file browser, and colons are not legal in one anyway.
 */
export function saveFileName(name: string, savedAt: Date): string {
  // Separators become spaces, then any word left as nothing but dots is
  // dropped, which removes `..` without touching a name like "Wing C v1.2".
  const safe = name
    .replace(UNSAFE_FILE_NAME, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !/^\.+$/.test(word))
    .join(' ')
    .replace(/^\.+/, '')
    .trim()

  const stamp = [
    savedAt.getFullYear().toString().padStart(4, '0'),
    (savedAt.getMonth() + 1).toString().padStart(2, '0'),
    savedAt.getDate().toString().padStart(2, '0'),
    '-',
    savedAt.getHours().toString().padStart(2, '0'),
    savedAt.getMinutes().toString().padStart(2, '0'),
  ].join('')

  return `${safe.length === 0 ? 'prison' : safe} ${stamp}${SAVE_FILE_EXTENSION}`
}

/** The picker's shape, declared here because it is not in the DOM lib yet. */
interface FileSystemPickerGlobals {
  readonly showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: readonly {
      description: string
      accept: Record<string, readonly string[]>
    }[]
  }) => Promise<{
    createWritable(): Promise<{
      write(data: Uint8Array): Promise<void>
      close(): Promise<void>
    }>
  }>
  readonly showOpenFilePicker?: (options: {
    multiple?: boolean
    types?: readonly {
      description: string
      accept: Record<string, readonly string[]>
    }[]
  }) => Promise<readonly { getFile(): Promise<File> }[]>
}

const pickers = globalThis as unknown as FileSystemPickerGlobals

const FILE_TYPES = [
  {
    description: 'Blockwork save',
    accept: { [SAVE_MIME_TYPE]: [SAVE_FILE_EXTENSION] },
  },
] as const

/** True when the player cancels a picker, which is not an error. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function deliverWithPicker(bytes: Uint8Array, fileName: string): Promise<boolean> {
  const picker = pickers.showSaveFilePicker
  if (picker === undefined) return false

  try {
    const handle = await picker({ suggestedName: fileName, types: FILE_TYPES })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
    return true
  } catch (error) {
    if (isAbort(error)) return false
    throw error
  }
}

/**
 * The fallback everywhere the picker is missing. The object URL is revoked on
 * a later task, because revoking it synchronously can cancel the download in
 * some webviews before it has started.
 */
function deliverWithDownload(bytes: Uint8Array, fileName: string): boolean {
  if (typeof document === 'undefined') return false

  // A copy into a plain ArrayBuffer: a `Uint8Array` may be a view onto a
  // larger or shared buffer, and neither is a `BlobPart`.
  const owned = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(owned).set(bytes)

  const url = URL.createObjectURL(new Blob([owned], { type: SAVE_MIME_TYPE }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'

  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)

  return true
}

/**
 * Writes a save out as a `.blockwork` file. Returns false if the player
 * cancelled or the host offers no way to deliver a file.
 */
export async function exportSaveToFile(
  bytes: Uint8Array,
  options: ExportOptions,
): Promise<boolean> {
  const fileName = saveFileName(options.name, options.savedAt)
  if (options.deliver !== undefined) return options.deliver(bytes, fileName)
  if (await deliverWithPicker(bytes, fileName)) return true
  return deliverWithDownload(bytes, fileName)
}

/** Reads a picked file into memory. Does not validate it. */
export async function readSaveFile(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

async function pickWithPicker(): Promise<Uint8Array | null | undefined> {
  const picker = pickers.showOpenFilePicker
  if (picker === undefined) return undefined

  try {
    const [handle] = await picker({ multiple: false, types: FILE_TYPES })
    if (handle === undefined) return null
    return await readSaveFile(await handle.getFile())
  } catch (error) {
    if (isAbort(error)) return null
    throw error
  }
}

/**
 * A hidden file input. `cancel` fires in current browsers but not in older
 * webviews, so a player who dismisses the sheet there simply never resolves
 * this promise — which is the same as never having opened it.
 */
function pickWithInput(): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SAVE_FILE_EXTENSION
    input.style.display = 'none'

    input.addEventListener('cancel', () => {
      input.remove()
      resolve(null)
    })
    input.addEventListener('change', () => {
      const file = input.files?.item(0) ?? null
      input.remove()
      if (file === null) {
        resolve(null)
        return
      }
      readSaveFile(file).then(resolve, reject)
    })

    document.body.append(input)
    input.click()
  })
}

/**
 * Asks the player for a `.blockwork` file and returns its bytes, or null if
 * they cancelled. Pass the result to `decodeSaveFile`, which is what decides
 * whether the file is really a save.
 */
export async function importSaveFromFile(pickup?: SavePickup): Promise<Uint8Array | null> {
  if (pickup !== undefined) return pickup()

  const picked = await pickWithPicker()
  if (picked !== undefined) return picked

  if (typeof document === 'undefined') return null
  return pickWithInput()
}
