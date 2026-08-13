import type { SimWorkerPort } from '../../src/worker/bridge'
import type {
  SimWorkerInbound,
  SimWorkerOutbound,
  SimWorkerScope,
} from '../../src/worker/simWorker'

/**
 * A worker channel that runs both ends in one thread.
 *
 * Delivery is synchronous, which a real `Worker` is not, but the bridge and
 * the worker only ever react to messages and never wait for a reply, so
 * collapsing the latency makes the tests deterministic without weakening what
 * they prove. `transfer` lists are recorded rather than honoured: nothing in
 * the protocol reads a buffer it has posted.
 */
export class FakeWorkerChannel {
  readonly transfers: Transferable[][] = []
  terminated = false

  readonly #toWorker: ((event: MessageEvent<SimWorkerInbound>) => void)[] = []
  readonly #toMain: ((event: MessageEvent<SimWorkerOutbound>) => void)[] = []

  /** The handle the main thread holds. */
  readonly port: SimWorkerPort = {
    postMessage: (message: SimWorkerInbound, transfer: Transferable[]): void => {
      this.transfers.push(transfer)
      for (const listener of [...this.#toWorker]) {
        listener(messageEvent(message))
      }
    },
    addEventListener: ((
      type: 'message' | 'error' | 'messageerror',
      listener: unknown,
    ): void => {
      if (type === 'message') {
        this.#toMain.push(listener as (event: MessageEvent<SimWorkerOutbound>) => void)
      }
      // error and messageerror listeners are ignored in tests
    }) as SimWorkerPort['addEventListener'],
    removeEventListener: ((
      type: 'message' | 'error' | 'messageerror',
      listener: unknown,
    ): void => {
      if (type === 'message') {
        const at = this.#toMain.indexOf(listener as (event: MessageEvent<SimWorkerOutbound>) => void)
        if (at >= 0) this.#toMain.splice(at, 1)
      }
      // error and messageerror listeners are ignored in tests
    }) as SimWorkerPort['removeEventListener'],
    terminate: (): void => {
      this.terminated = true
    },
  }

  /** The scope the worker attaches to. */
  readonly scope: SimWorkerScope = {
    postMessage: (message: SimWorkerOutbound, transfer: Transferable[]): void => {
      this.transfers.push(transfer)
      for (const listener of [...this.#toMain]) {
        listener(messageEvent(message))
      }
    },
    addEventListener: (
      _type: 'message',
      listener: (event: MessageEvent<SimWorkerInbound>) => void,
    ): void => {
      this.#toWorker.push(listener)
    },
  }
}

/** Only `data` is ever read, so a literal stands in for the DOM event. */
function messageEvent<T>(data: T): MessageEvent<T> {
  return { data } as MessageEvent<T>
}

/** A scheduler the test drives by hand, in place of `setTimeout`. */
export class ManualScheduler {
  #queue: (() => void)[] = []

  readonly schedule = (callback: () => void): void => {
    this.#queue.push(callback)
  }

  get pending(): number {
    return this.#queue.length
  }

  /** Runs every callback queued so far, once. */
  pump(): void {
    const due = this.#queue
    this.#queue = []
    for (const callback of due) {
      callback()
    }
  }
}

/** A `performance.now()` stand-in the test advances explicitly. */
export class ManualClock {
  #ms = 1000

  readonly now = (): number => this.#ms

  advance(ms: number): void {
    this.#ms += ms
  }
}
