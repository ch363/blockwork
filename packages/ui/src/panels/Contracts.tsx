/**
 * Contracts panel (T8.9, PRD 5.14, PRD 6.2).
 *
 * Active contract cards with to-do checklists and progress, available
 * contracts list, loan controls. Presentational only: the host resolves
 * simulation state and turns taps into `contracts.accept` and
 * `contracts.cancel` commands.
 */

import type { JSX } from 'preact'
import { useState } from 'preact/hooks'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export interface ContractTodoModel {
  readonly id: string
  readonly label: string
  readonly done: boolean
  readonly current: string
  readonly required: string
}

export interface ContractRowModel {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly advance: number
  readonly completion: number
  readonly todos: readonly ContractTodoModel[]
  readonly progress: number
  readonly active: boolean
  readonly locked: boolean
  readonly lockReason: string | null
}

export interface ContractsLoanModel {
  readonly principal: number
  readonly maxPrincipal: number
  readonly interestRate: number
  readonly creditRating: number
  readonly available: boolean
  readonly availableReason: string | null
}

export interface ContractsModel {
  readonly active: readonly ContractRowModel[]
  readonly available: readonly ContractRowModel[]
  readonly maxActive: number
  readonly loan: ContractsLoanModel | null
}

export interface ContractsProps {
  readonly model: ContractsModel | null
  readonly onClose: () => void
  readonly onAccept?: (contractId: string) => void
  readonly onCancel?: (contractId: string) => void
  readonly onTakeLoan?: (amount: number) => void
  readonly onRepayLoan?: (amount: number) => void
}

function formatMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-GB')}`
}

export function Contracts({
  model,
  onClose,
  onAccept,
  onCancel,
  onTakeLoan,
  onRepayLoan,
}: ContractsProps): JSX.Element {
  const open = model !== null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  const selected =
    model === null
      ? null
      : selectedId !== null
        ? (model.active.find((c) => c.id === selectedId) ??
          model.available.find((c) => c.id === selectedId) ??
          null)
        : null

  const canAcceptMore = model !== null && model.active.length < model.maxActive

  return (
    <div
      ref={trapRef}
      class="bw-contracts-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Contracts"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-contracts-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Contracts</h2>
              <div class="sub">
                {model.active.length}/{model.maxActive} active
              </div>
            </div>
          </div>

          <div class="bw-contracts-body">
            <div class="bw-contracts-list">
              {model.active.length > 0 && (
                <section class="bw-contracts-section">
                  <h3>Active contracts</h3>
                  <ul>
                    {model.active.map((contract) => (
                      <li key={contract.id}>
                        <ContractCard
                          contract={contract}
                          selected={selectedId === contract.id}
                          onSelect={() => setSelectedId(contract.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {model.available.length > 0 && (
                <section class="bw-contracts-section">
                  <h3>Available contracts</h3>
                  <ul>
                    {model.available.map((contract) => (
                      <li key={contract.id}>
                        <ContractCard
                          contract={contract}
                          selected={selectedId === contract.id}
                          onSelect={() => setSelectedId(contract.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {model.active.length === 0 && model.available.length === 0 && (
                <div class="bw-contracts-empty" role="status">
                  No contracts available. Research Finance for more options.
                </div>
              )}
            </div>

            <aside class="bw-contracts-detail">
              {selected !== null ? (
                <ContractDetail
                  contract={selected}
                  canAccept={canAcceptMore && !selected.active && !selected.locked}
                  onAccept={() => onAccept?.(selected.id)}
                  onCancel={() => onCancel?.(selected.id)}
                />
              ) : model.loan !== null ? (
                <LoanCard
                  loan={model.loan}
                  {...(onTakeLoan === undefined ? {} : { onTake: onTakeLoan })}
                  {...(onRepayLoan === undefined ? {} : { onRepay: onRepayLoan })}
                />
              ) : (
                <div class="bw-contracts-empty" role="status">
                  Select a contract to see details.
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

function ContractCard({
  contract,
  selected,
  onSelect,
}: {
  readonly contract: ContractRowModel
  readonly selected: boolean
  readonly onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      class="bw-contracts-card"
      data-selected={selected ? 'true' : 'false'}
      data-active={contract.active ? 'true' : 'false'}
      data-locked={contract.locked ? 'true' : 'false'}
      aria-label={`${contract.name}, ${contract.active ? 'active' : 'available'}`}
      onClick={onSelect}
    >
      <span class="nm">{contract.name}</span>
      <span class="meta">
        {formatMoney(contract.advance)} advance · {formatMoney(contract.completion)} on completion
      </span>
      {contract.active && (
        <div class="bw-contracts-progress">
          <span class="bw-contracts-progress-bar">
            <i style={{ width: `${String(Math.round(contract.progress * 100))}%` }} />
          </span>
          <span class="bw-num">{Math.round(contract.progress * 100)}%</span>
        </div>
      )}
      {contract.locked && <span class="bw-contracts-lock">{contract.lockReason}</span>}
    </button>
  )
}

function ContractDetail({
  contract,
  canAccept,
  onAccept,
  onCancel,
}: {
  readonly contract: ContractRowModel
  readonly canAccept: boolean
  readonly onAccept: () => void
  readonly onCancel: () => void
}): JSX.Element {
  return (
    <div class="bw-contracts-detail-card">
      <header>
        <h3>{contract.name}</h3>
        {contract.active && <span class="bw-contracts-pill active">Active</span>}
        {contract.locked && <span class="bw-contracts-pill locked">Locked</span>}
      </header>

      <p class="bw-contracts-desc">{contract.description}</p>

      <div class="bw-contracts-kv">
        <span class="k">Advance</span>
        <span class="v">{formatMoney(contract.advance)}</span>
      </div>
      <div class="bw-contracts-kv">
        <span class="k">Completion bonus</span>
        <span class="v">{formatMoney(contract.completion)}</span>
      </div>

      {contract.todos.length > 0 && (
        <>
          <h4>Objectives</h4>
          <ul class="bw-contracts-todos">
            {contract.todos.map((todo) => (
              <li key={todo.id} data-done={todo.done ? 'true' : 'false'}>
                <span class="bw-contracts-todo-check">{todo.done ? '✓' : '○'}</span>
                <span class="bw-contracts-todo-label">{todo.label}</span>
                <span class="bw-contracts-todo-progress">
                  {todo.current}/{todo.required}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div class="bw-contracts-actions">
        {contract.active ? (
          <Button variant="ghost" onClick={onCancel}>
            Cancel contract
          </Button>
        ) : (
          <Button variant="primary" disabled={!canAccept} onClick={onAccept}>
            Accept contract
          </Button>
        )}
      </div>
    </div>
  )
}

function LoanCard({
  loan,
  onTake,
  onRepay,
}: {
  readonly loan: ContractsLoanModel
  readonly onTake?: (amount: number) => void
  readonly onRepay?: (amount: number) => void
}): JSX.Element {
  const takeAmount = Math.min(10000, loan.maxPrincipal - loan.principal)
  const repayAmount = Math.min(10000, loan.principal)

  return (
    <div class="bw-contracts-detail-card">
      <header>
        <h3>Credit line</h3>
      </header>

      <div class="bw-contracts-kv">
        <span class="k">Outstanding principal</span>
        <span class="v">{formatMoney(loan.principal)}</span>
      </div>
      <div class="bw-contracts-kv">
        <span class="k">Credit limit</span>
        <span class="v">{formatMoney(loan.maxPrincipal)}</span>
      </div>
      <div class="bw-contracts-kv">
        <span class="k">Interest rate</span>
        <span class="v">{(loan.interestRate * 100).toFixed(1)}%/hr</span>
      </div>
      <div class="bw-contracts-kv">
        <span class="k">Credit rating</span>
        <span class="v">{loan.creditRating}/10</span>
      </div>

      {!loan.available && loan.availableReason !== null && (
        <p class="bw-contracts-loan-reason">{loan.availableReason}</p>
      )}

      <div class="bw-contracts-actions">
        <Button
          variant="ghost"
          disabled={!loan.available || takeAmount <= 0}
          onClick={() => onTake?.(takeAmount)}
        >
          Borrow {formatMoney(takeAmount)}
        </Button>
        <Button variant="ghost" disabled={repayAmount <= 0} onClick={() => onRepay?.(repayAmount)}>
          Repay {formatMoney(repayAmount)}
        </Button>
      </div>
    </div>
  )
}
