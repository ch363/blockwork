/**
 * Posts / deployment panel (T4.1, PRD 3.5, mockup screen 5).
 *
 * The player declares staffing intent — posts, patrols, sector access — and
 * the game assigns officers. This panel is presentational: the host hands it
 * a {@link PostsModel} already resolved from sim state, and gestures leave as
 * callbacks. The sector map itself stays in the world view (the overlay the
 * dock's Posts tool flips on); the panel only carries the legend, the
 * unfilled badge, and the active list.
 */

import type { JSX } from 'preact'

import { useFocusTrap } from '../components/FocusTrap'
import { Button } from '../controls/Button'
import { IconButton } from '../controls/IconButton'
import { Icon } from '../icons'

export type PostsTab = 'posts' | 'patrols' | 'sectors'

export type UnfilledReasonLabel = 'not enough staff hired' | 'none reachable' | 'all staff busy'

export interface PostsRowModel {
  readonly id: number
  readonly name: string
  /** One-line schedule / role qualifier under the name. */
  readonly detail: string
  readonly filled: number
  readonly required: number
  readonly shortfallReason: UnfilledReasonLabel | null
}

export interface SectorRowModel {
  readonly id: number
  readonly name: string
  readonly colour: string
  readonly access: string
  /** Empty string means unrestricted. */
  readonly categories: string
  readonly tileCount: number
}

export interface PostsModel {
  readonly unfilledCount: number
  readonly deployedCount: number
  readonly hiredOfficers: number
  readonly peakRequired: number
  /** Peak window label, e.g. "12:00 to 13:00". Null when nothing peaks. */
  readonly peakWindow: string | null
  readonly posts: readonly PostsRowModel[]
  readonly patrols: readonly PostsRowModel[]
  readonly sectors: readonly SectorRowModel[]
  /** Suggested hire count when short, or 0. */
  readonly hireSuggestion: number
  readonly hireCost: number
  readonly hireWagePerHour: number
}

export interface PostsProps {
  /** Null closes the panel. Kept mounted so the slide animation can run. */
  readonly model: PostsModel | null
  readonly tab: PostsTab
  readonly onTab: (tab: PostsTab) => void
  readonly onClose: () => void
  readonly onNewPost?: () => void
  readonly onNewPatrol?: () => void
  readonly onNewSector?: () => void
  readonly onSelectPost?: (id: number) => void
  readonly onSelectPatrol?: (id: number) => void
  readonly onSelectSector?: (id: number) => void
  readonly onHireSuggested?: () => void
  readonly onConfigureSector?: (id: number) => void
}

const ACCESS_LEGEND: readonly { readonly colour: string; readonly label: string }[] = [
  { colour: 'var(--info)', label: 'Staff only' },
  { colour: 'var(--warn)', label: 'Secure' },
  { colour: 'var(--surface-4)', label: 'Shared' },
  { colour: 'var(--ok)', label: 'Open' },
]

export function Posts({
  model,
  tab,
  onTab,
  onClose,
  onNewPost,
  onNewPatrol,
  onNewSector,
  onSelectPost,
  onSelectPatrol,
  onSelectSector,
  onHireSuggested,
  onConfigureSector,
}: PostsProps): JSX.Element {
  const open = model !== null
  const unfilled = model?.unfilledCount ?? 0
  const deployed = model?.deployedCount ?? 0
  const trapRef = useFocusTrap({ active: open, onEscape: onClose })

  return (
    <div
      ref={trapRef}
      class="bw-posts-panel"
      data-open={open ? 'true' : 'false'}
      role="dialog"
      aria-label="Posts"
      aria-modal={open ? 'true' : undefined}
    >
      {model !== null && (
        <>
          <div class="bw-posts-head">
            <IconButton ariaLabel="Back" onClick={onClose}>
              <Icon name="undo" size={16} />
            </IconButton>
            <div class="who">
              <h2>Posts</h2>
              <div class="sub">
                {unfilled} unfilled · {deployed} officers deployed
              </div>
            </div>
            <div class="bw-spacer" />
            <div class="bw-seg" role="tablist" aria-label="Posts views">
              <button
                type="button"
                role="tab"
                data-on={tab === 'posts'}
                aria-selected={tab === 'posts'}
                onClick={() => {
                  onTab('posts')
                }}
              >
                Posts
              </button>
              <button
                type="button"
                role="tab"
                data-on={tab === 'patrols'}
                aria-selected={tab === 'patrols'}
                onClick={() => {
                  onTab('patrols')
                }}
              >
                Patrols
              </button>
              <button
                type="button"
                role="tab"
                data-on={tab === 'sectors'}
                aria-selected={tab === 'sectors'}
                onClick={() => {
                  onTab('sectors')
                }}
              >
                Sector access
              </button>
            </div>
            {tab === 'posts' && (
              <Button variant="primary" onClick={onNewPost} ariaLabel="New post">
                New post
              </Button>
            )}
            {tab === 'patrols' && (
              <Button variant="primary" onClick={onNewPatrol} ariaLabel="New patrol">
                New patrol
              </Button>
            )}
            {tab === 'sectors' && (
              <Button variant="primary" onClick={onNewSector} ariaLabel="New sector">
                New sector
              </Button>
            )}
          </div>

          <div class="bw-posts-body">
            <div class="bw-posts-map">
              <header>
                <h3>Sector map</h3>
                <div class="bw-seg" role="group" aria-label="Map overlay">
                  <button type="button" data-on="true">
                    Access
                  </button>
                  <button type="button" disabled title="Coverage overlay — later">
                    Coverage
                  </button>
                  <button type="button" disabled title="Category overlay — later">
                    Category
                  </button>
                </div>
              </header>
              <div class="bw-posts-map-stage">
                <p class="bw-posts-map-hint">
                  Sector colours paint on the world. Use the Sectors overlay to see them while this
                  panel is open.
                </p>
                <div class="bw-legend bw-posts-legend">
                  <h4>Access mode</h4>
                  {ACCESS_LEGEND.map((row) => (
                    <div key={row.label} class="lrow">
                      <i class="sw" style={`background:${row.colour}`} />
                      {row.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div class="bw-posts-side">
              {unfilled > 0 && (
                <div class="bw-posts-card bw-posts-card-danger">
                  <header>
                    <h3>
                      ⚠ {unfilled} post{unfilled === 1 ? '' : 's'} unfilled
                    </h3>
                  </header>
                  <div class="bw-posts-card-body">
                    {model.hiredOfficers} officers hired
                    {model.peakRequired > model.hiredOfficers && model.peakWindow !== null
                      ? `, ${String(model.peakRequired)} required at peak (${model.peakWindow}).`
                      : '.'}
                    {model.hireSuggestion > 0 && (
                      <div class="bw-posts-hire">
                        <Button
                          variant="primary"
                          onClick={onHireSuggested}
                          ariaLabel={`Hire ${String(model.hireSuggestion)} officers`}
                        >
                          Hire {model.hireSuggestion} officers · ${model.hireCost.toLocaleString()}{' '}
                          + ${model.hireWagePerHour}/hr
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'posts' && (
                <PostsList title="Active posts" rows={model.posts} onSelect={onSelectPost} />
              )}
              {tab === 'patrols' && (
                <PostsList title="Patrol routes" rows={model.patrols} onSelect={onSelectPatrol} />
              )}
              {tab === 'sectors' && (
                <SectorList
                  sectors={model.sectors}
                  onSelect={onSelectSector}
                  onConfigure={onConfigureSector}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function PostsList({
  title,
  rows,
  onSelect,
}: {
  readonly title: string
  readonly rows: readonly PostsRowModel[]
  readonly onSelect?: ((id: number) => void) | undefined
}): JSX.Element {
  return (
    <div class="bw-posts-card bw-posts-list">
      <header>
        <h3>{title}</h3>
        <span class="bw-pill">{rows.length}</span>
      </header>
      <div>
        {rows.length === 0 ? (
          <p class="bw-posts-empty">None yet. Create one to start deploying staff.</p>
        ) : (
          rows.map((row) => {
            const filled = row.filled >= row.required
            return (
              <button
                key={row.id}
                type="button"
                class="bw-postrow"
                onClick={() => {
                  onSelect?.(row.id)
                }}
                aria-label={`${row.name}, ${String(row.filled)} of ${String(row.required)}${
                  row.shortfallReason === null ? '' : `, ${row.shortfallReason}`
                }`}
              >
                <div>
                  <div class="pn">{row.name}</div>
                  <div class="pd">
                    {row.detail}
                    {row.shortfallReason !== null && (
                      <span class="bw-posts-reason"> · {row.shortfallReason}</span>
                    )}
                  </div>
                </div>
                <div class="staffing" aria-hidden="true">
                  {Array.from({ length: row.required }, (_, i) => (
                    <i key={i} class={i < row.filled ? 'dotfill' : 'dotempty'} />
                  ))}
                </div>
                <span class={filled ? 'bw-pill ok' : 'bw-pill bad'}>
                  {row.filled} / {row.required}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function SectorList({
  sectors,
  onSelect,
  onConfigure,
}: {
  readonly sectors: readonly SectorRowModel[]
  readonly onSelect?: ((id: number) => void) | undefined
  readonly onConfigure?: ((id: number) => void) | undefined
}): JSX.Element {
  return (
    <div class="bw-posts-card bw-posts-list">
      <header>
        <h3>Sectors</h3>
        <span class="bw-pill">{sectors.length}</span>
      </header>
      <div>
        {sectors.length === 0 ? (
          <p class="bw-posts-empty">Paint regions into a named sector to control access.</p>
        ) : (
          sectors.map((sector) => (
            <button
              key={sector.id}
              type="button"
              class="bw-postrow"
              onClick={() => {
                onSelect?.(sector.id)
                onConfigure?.(sector.id)
              }}
              aria-label={`${sector.name}, ${sector.access}${
                sector.categories.length > 0 ? `, ${sector.categories}` : ''
              }`}
            >
              <div>
                <div class="pn">
                  <i
                    class="bw-posts-swatch"
                    style={sector.colour.length > 0 ? `background:${sector.colour}` : undefined}
                  />
                  {sector.name}
                </div>
                <div class="pd">
                  {sector.access}
                  {sector.categories.length > 0 ? ` · ${sector.categories}` : ' · any category'}
                  {` · ${String(sector.tileCount)} tiles`}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** Human label for an unfilled-reason code from the sim. */
export function unfilledReasonLabel(
  reason: 'no-staff-hired' | 'all-staff-busy' | 'unreachable' | null,
): UnfilledReasonLabel | null {
  switch (reason) {
    case 'no-staff-hired':
      return 'not enough staff hired'
    case 'unreachable':
      return 'none reachable'
    case 'all-staff-busy':
      return 'all staff busy'
    default:
      return null
  }
}
