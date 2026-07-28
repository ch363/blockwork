/**
 * Gzip for the save payload, via the WHATWG Compression Streams API
 * (PRD 7.4: "Compressed with `CompressionStream('gzip')`").
 *
 * `CompressionStream` is a web platform global, not a DOM one — it exists in
 * browsers, in workers, in Node 18+ and in the replay harness — so using it
 * does not breach CLAUDE.md rule 2. Its *types*, however, only ship in
 * `lib.dom`, which `packages/sim` deliberately does not include. So this
 * module declares the small slice of the API it actually uses and reads the
 * constructors off `globalThis`. If a host turns out not to have them, that is
 * a `SaveError` with a code, not a `TypeError` from a missing global.
 *
 * The pump below reads and writes concurrently on purpose. The writable side
 * of a transform stream applies backpressure, so `await writer.write(input)`
 * before anything drains the readable side deadlocks on inputs larger than the
 * internal queue — which every real save is.
 */

import { concatBytes } from './bytes'
import { SaveError } from './format'

/** The reader half of a `ReadableStream<Uint8Array>`, as used here. */
interface ByteStreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
}

/** The writer half of a `WritableStream<Uint8Array>`, as used here. */
interface ByteStreamWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

/** The transform stream shape both `CompressionStream` and its inverse have. */
interface ByteTransformStream {
  readonly readable: { getReader(): ByteStreamReader }
  readonly writable: { getWriter(): ByteStreamWriter }
}

type ByteTransformStreamConstructor = new (format: string) => ByteTransformStream

interface CompressionGlobals {
  readonly CompressionStream?: ByteTransformStreamConstructor
  readonly DecompressionStream?: ByteTransformStreamConstructor
}

// `globalThis` is typed without these because sim omits lib.dom; see above.
const hostGlobals = globalThis as unknown as CompressionGlobals

/** True where `gzipBytes` and `gunzipBytes` can run. */
export function compressionAvailable(): boolean {
  return (
    typeof hostGlobals.CompressionStream === 'function' &&
    typeof hostGlobals.DecompressionStream === 'function'
  )
}

function constructorFor(direction: 'compress' | 'decompress'): ByteTransformStreamConstructor {
  const found =
    direction === 'compress' ? hostGlobals.CompressionStream : hostGlobals.DecompressionStream

  if (typeof found !== 'function') {
    throw new SaveError(
      'compression-unavailable',
      `this host has no ${direction === 'compress' ? 'CompressionStream' : 'DecompressionStream'}, ` +
        'which the save format requires',
    )
  }
  return found
}

async function pump(stream: ByteTransformStream, input: Uint8Array): Promise<Uint8Array> {
  const reader = stream.readable.getReader()
  const writer = stream.writable.getWriter()
  const chunks: Uint8Array[] = []

  // Started before the write so the readable side is already draining. Its
  // rejection is captured rather than left to float: when a decode fails both
  // halves reject, and an unawaited one becomes an unhandled rejection.
  let readFailure: unknown = null
  const draining = reader
    .read()
    .then(async function next({ done, value }): Promise<void> {
      if (done) return
      if (value !== undefined) chunks.push(value)
      return reader.read().then(next)
    })
    .catch((error: unknown) => {
      readFailure = error
    })

  let writeFailure: unknown = null
  try {
    await writer.write(input)
    await writer.close()
  } catch (error) {
    writeFailure = error
  }

  await draining

  const failure = readFailure ?? writeFailure
  if (failure !== null) throw failure

  return concatBytes(chunks)
}

/** Gzips a payload. */
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const Stream = constructorFor('compress')
  try {
    return await pump(new Stream('gzip'), input)
  } catch (error) {
    throw new SaveError('compression-failed', 'gzip compression failed', { cause: error })
  }
}

/**
 * Un-gzips a payload. A damaged stream rejects inside the platform's inflater,
 * and that rejection is the main way corruption is caught.
 */
export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const Stream = constructorFor('decompress')
  try {
    return await pump(new Stream('gzip'), input)
  } catch (error) {
    throw new SaveError(
      'decompression-failed',
      'the save payload is not a readable gzip stream, so the file is damaged',
      { cause: error },
    )
  }
}
