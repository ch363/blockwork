/**
 * Where saves are kept and how they leave the app.
 *
 * `@blockwork/sim` owns the format — what a save contains, how it is encoded,
 * which migrations it needs. This owns the two things the format cannot,
 * because both are DOM APIs the simulation may not touch: IndexedDB storage
 * (`store.ts`) and the Files app (`file.ts`).
 */

export {
  AUTOSAVE_SLOT_COUNT,
  MAX_SAVE_NAME_LENGTH,
  SAVE_DATABASE_NAME,
  SAVE_DATABASE_VERSION,
  SAVE_STORE_NAME,
  SaveStore,
  autosaveKey,
  manualSaveKey,
  nextAutosaveSlot,
} from './store'
export type { SaveDescriptor, SaveKind, SaveSummary } from './store'

export {
  SAVE_MIME_TYPE,
  exportSaveToFile,
  importSaveFromFile,
  readSaveFile,
  saveFileName,
} from './file'
export type { ExportOptions, SaveDelivery, SavePickup } from './file'
