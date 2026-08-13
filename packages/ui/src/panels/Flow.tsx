/**
 * Flow (logistics) panel (T8.9, PRD 5.13, PRD 6.2).
 *
 * Chain diagram for meals, laundry, cleaning, construction supply and exports,
 * with throughput at each stage and the bottleneck highlighted. Presentational
 * only: the host resolves simulation state into a view model.
 */

import type { JSX } from 'preact'
import { useState } from 'preact/hooks'

import { useFocusTrap } from '../components/FocusTrap'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type FlowChainId = 'meals' | 'laundry' | 'cleaning' | 'supply' | 'exports'

export interface FlowStageModel {
  readonly id: string
  readonly name: string
  readonly throughput: number
  readonly capacity: number
  readonly bottleneck: boolean
  readonly detail: string
}

export interface FlowChainModel {
  readonly id: FlowChainId
  readonly name: string
  readonly stages: readonly FlowStageModel[]
  readonly healthy: boolean
  readonly summary: string
}

export interface FlowModel {
  readonly chains: readonly FlowChainModel[]
}

export interface FlowProps {
  readonly model: FlowModel | null
  readonly onClose: () => void
}

const CHAIN_ICONS: Readonly<Record<FlowChainId, string>> = {
  meals: 'Meal chain',
  laundry: 'Laundry cycle',
  cleaning: 'Cleaning service',
  supply: 'Material supply',
  exports: 'Workshop exports',
}

export function Flow({ model, onClose }: FlowProps): JSX.Element {
  const open = model !== null
  const [selectedChain, setSelectedChain] = useState<FlowChainId | null>(null)
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  const activeChain =
    model === null
      ? null
      : selectedChain !== null
        ? (model.chains.find((c) => c.id === selectedChain) ?? model.chains[0] ?? null)
        : (model.chains[0] ?? null)

  return (
    <div ref={trapRef} class="bw-flow-panel" data-open={open ? 'true' : 'false'} role="dialog" aria-label="Flow" aria-modal={open ? 'true' : undefined}>
      {model !== null && (
        <>
          <div class="bw-flow-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Logistics flow</h2>
              <div class="sub">Throughput and bottlenecks</div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-flow-tabs" role="tablist" aria-label="Logistics chain">
              {model.chains.map((chain) => (
                <button
                  key={chain.id}
                  type="button"
                  role="tab"
                  aria-selected={activeChain?.id === chain.id}
                  data-on={activeChain?.id === chain.id ? 'true' : 'false'}
                  data-healthy={chain.healthy ? 'true' : 'false'}
                  onClick={() => setSelectedChain(chain.id)}
                >
                  {chain.name}
                  {!chain.healthy && <span class="bw-flow-tab-warn">!</span>}
                </button>
              ))}
            </div>
          </div>

          <div class="bw-flow-body">
            {activeChain !== null ? (
              <>
                <div class="bw-flow-summary" data-healthy={activeChain.healthy ? 'true' : 'false'}>
                  <h3>{CHAIN_ICONS[activeChain.id]}</h3>
                  <p>{activeChain.summary}</p>
                </div>

                <div class="bw-flow-chain">
                  {activeChain.stages.map((stage, index) => (
                    <FlowStage key={stage.id} stage={stage} isFirst={index === 0} />
                  ))}
                </div>
              </>
            ) : (
              <div class="bw-flow-empty" role="status">
                No logistics chains configured.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function FlowStage({
  stage,
  isFirst,
}: {
  readonly stage: FlowStageModel
  readonly isFirst: boolean
}): JSX.Element {
  const utilisation = stage.capacity > 0 ? Math.round((stage.throughput / stage.capacity) * 100) : 0

  return (
    <div class="bw-flow-stage" data-bottleneck={stage.bottleneck ? 'true' : 'false'}>
      {!isFirst && (
        <div class="bw-flow-arrow">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" fill="none" stroke-width="2" />
          </svg>
        </div>
      )}
      <div class="bw-flow-stage-card">
        <div class="bw-flow-stage-header">
          <span class="bw-flow-stage-name">{stage.name}</span>
          {stage.bottleneck && <span class="bw-flow-bottleneck-badge">Bottleneck</span>}
        </div>
        <div class="bw-flow-stage-stats">
          <div class="bw-flow-stage-kv">
            <span class="k">Throughput</span>
            <span class="v">{stage.throughput}/hr</span>
          </div>
          <div class="bw-flow-stage-kv">
            <span class="k">Capacity</span>
            <span class="v">{stage.capacity}/hr</span>
          </div>
        </div>
        <div class="bw-flow-stage-bar">
          <i
            style={{ width: `${String(Math.min(100, utilisation))}%` }}
            data-level={utilisation >= 90 ? 'critical' : utilisation >= 70 ? 'warn' : 'ok'}
          />
        </div>
        <span class="bw-flow-stage-util">{utilisation}% utilisation</span>
        {stage.detail.length > 0 && <p class="bw-flow-stage-detail">{stage.detail}</p>}
      </div>
    </div>
  )
}
