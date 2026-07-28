/**
 * Intelligence panel (T5.6, PRD 5.10).
 *
 * Four views of the same question — where is the contraband coming from:
 *
 *   - **Sources** by room, showing what you *know* against what is *there*.
 *     The gap is the argument for another informant, and hiding it would make
 *     the panel a comfort blanket rather than a tool.
 *   - **Market** — live price, supply and demand per item.
 *   - **Informants** — the roster, each with their coverage radius and their
 *     risk of being blown.
 *   - **Reputations** the prison has uncovered.
 *
 * Presentational only: the host resolves simulation state into an
 * {@link IntelligenceModel}.
 */

import type { JSX } from 'preact'

import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type IntelligenceTab = 'sources' | 'market' | 'informants' | 'reputations'

export interface ContrabandSourceRowModel {
  readonly roomId: number
  readonly roomName: string
  /** Stashes the player can see. */
  readonly revealed: number
  /** Stashes actually there. Equal to `revealed` only with full coverage. */
  readonly actual: number
}

export interface MarketRowModel {
  readonly itemId: string
  readonly itemName: string
  readonly price: number
  readonly supply: number
  readonly demand: number
}

export interface InformantRowModel {
  readonly inmateId: number
  readonly name: string
  readonly blown: boolean
  readonly revealCount: number
  readonly coverageRadius: number
  /** 0..1 chance of being blown today. */
  readonly blowChance: number
  readonly carelesslyHandled: boolean
}

export interface RevealedReputationModel {
  readonly inmateId: number
  readonly inmateName: string
  readonly reputationName: string
}

export interface IntelligenceModel {
  readonly sources: readonly ContrabandSourceRowModel[]
  readonly market: readonly MarketRowModel[]
  readonly informants: readonly InformantRowModel[]
  readonly reputations: readonly RevealedReputationModel[]
  readonly maxInformants: number
  /** Set when an inmate is selected and could be turned. */
  readonly recruitCandidate: {
    readonly inmateId: number
    readonly name: string
    readonly loyalty: number
    readonly fear: number
    readonly cost: number
    /** Null when they can be turned. */
    readonly refusal: string | null
  } | null
}

export interface IntelligenceProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: IntelligenceModel | null
  readonly tab: IntelligenceTab
  readonly onTab: (tab: IntelligenceTab) => void
  readonly onClose: () => void
  readonly onRecruit?: (inmateId: number) => void
  /** Pans the map to the informant and draws their radius. */
  readonly onFocusInformant?: (inmateId: number) => void
}

const TABS: readonly { readonly id: IntelligenceTab; readonly label: string }[] = [
  { id: 'sources', label: 'Sources' },
  { id: 'market', label: 'Market' },
  { id: 'informants', label: 'Informants' },
  { id: 'reputations', label: 'Reputations' },
]

/** `0.24` → `"24%"`. */
export function formatChance(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * How much of a room's contraband the player can actually see.
 *
 * Returns null for a room with nothing in it, so the panel can say "clear"
 * rather than "100% covered", which would be a different and misleading claim.
 */
export function coverageOf(row: ContrabandSourceRowModel): number | null {
  if (row.actual === 0) return null
  return row.revealed / row.actual
}

export function Intelligence({
  model,
  tab,
  onTab,
  onClose,
  onRecruit,
  onFocusInformant,
}: IntelligenceProps): JSX.Element {
  const open = model !== null

  return (
    <div
      class="bw-intel-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Intelligence"
    >
      {model !== null && (
        <>
          <div class="bw-intel-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Intelligence</h2>
              <div class="sub">
                {model.informants.filter((row) => !row.blown).length} of {model.maxInformants}{' '}
                informants active
              </div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-intel-tabs" role="tablist" aria-label="Intelligence view">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  data-on={tab === entry.id ? 'true' : 'false'}
                  onClick={() => onTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-intel-body">
            {tab === 'sources' && <Sources rows={model.sources} />}
            {tab === 'market' && <Market rows={model.market} />}
            {tab === 'informants' && (
              <Informants
                rows={model.informants}
                {...(onFocusInformant === undefined ? {} : { onFocus: onFocusInformant })}
              />
            )}
            {tab === 'reputations' && <Reputations rows={model.reputations} />}

            {model.recruitCandidate !== null && (
              <div class="bw-intel-recruit">
                <h4>Recruit {model.recruitCandidate.name}?</h4>
                <div class="bw-intel-kv">
                  <span class="k">Loyalty</span>
                  <span class="v">{Math.round(model.recruitCandidate.loyalty)}</span>
                </div>
                <div class="bw-intel-kv">
                  <span class="k">Fear</span>
                  <span class="v">{Math.round(model.recruitCandidate.fear)}</span>
                </div>
                {model.recruitCandidate.refusal === null ? (
                  <Button
                    variant="primary"
                    onClick={() => onRecruit?.(model.recruitCandidate?.inmateId ?? 0)}
                  >
                    Turn · ${model.recruitCandidate.cost}
                  </Button>
                ) : (
                  <p class="bw-intel-refusal">{model.recruitCandidate.refusal}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Sources({ rows }: { readonly rows: readonly ContrabandSourceRowModel[] }): JSX.Element {
  if (rows.length === 0) {
    return <p class="bw-intel-empty">No contraband has been traced to a room yet.</p>
  }
  return (
    <table class="bw-intel-table">
      <thead>
        <tr>
          <th>Room</th>
          <th>Known</th>
          <th>Present</th>
          <th>Coverage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const coverage = coverageOf(row)
          return (
            <tr key={row.roomId}>
              <td>{row.roomName}</td>
              <td class="bw-num">{row.revealed}</td>
              <td class="bw-num">{row.actual}</td>
              <td class="bw-num" data-thin={coverage !== null && coverage < 0.5 ? 'true' : 'false'}>
                {coverage === null ? 'clear' : formatChance(coverage)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Market({ rows }: { readonly rows: readonly MarketRowModel[] }): JSX.Element {
  return (
    <table class="bw-intel-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Price</th>
          <th>Supply</th>
          <th>Demand</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.itemId}>
            <td>{row.itemName}</td>
            <td class="bw-num">${row.price}</td>
            <td class="bw-num">{row.supply}</td>
            <td class="bw-num">{row.demand}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Informants({
  rows,
  onFocus,
}: {
  readonly rows: readonly InformantRowModel[]
  readonly onFocus?: (inmateId: number) => void
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <p class="bw-intel-empty">
        No informants. Select a frightened, disloyal inmate to turn one.
      </p>
    )
  }
  return (
    <ul class="bw-intel-roster">
      {rows.map((row) => (
        <li key={row.inmateId}>
          <button
            type="button"
            class="bw-intel-informant"
            data-blown={row.blown ? 'true' : 'false'}
            aria-label={`${row.name}, ${row.blown ? 'blown' : 'active'}`}
            onClick={() => onFocus?.(row.inmateId)}
          >
            <span class="nm">{row.name}</span>
            <span class="meta">
              {row.revealCount} finds · {row.coverageRadius} tile radius
            </span>
            <span class="state">
              {row.blown
                ? 'Blown — a target'
                : `${formatChance(row.blowChance)} risk today${
                    row.carelesslyHandled ? ' · summoned in the open' : ''
                  }`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Reputations({
  rows,
}: {
  readonly rows: readonly RevealedReputationModel[]
}): JSX.Element {
  if (rows.length === 0) {
    return <p class="bw-intel-empty">Nothing has been uncovered yet.</p>
  }
  return (
    <ul class="bw-intel-reputations">
      {rows.map((row) => (
        <li key={`${row.inmateId}:${row.reputationName}`}>
          <span class="nm">{row.inmateName}</span>
          <span class="bw-pill">{row.reputationName}</span>
        </li>
      ))}
    </ul>
  )
}
