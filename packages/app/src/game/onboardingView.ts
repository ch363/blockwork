/**
 * Maps the Guided Contract controller onto the presentational onboarding model
 * (T8.8 / T6.4). Kept out of `session.ts` so the mapping is unit-testable
 * without a WebGL context.
 */

import {
  FAILURE_CONDITIONS,
  MUTATORS,
  isFailureCondition,
  isMutator,
  resolveMapSize,
  seedFromInput,
} from '@blockwork/sim'
import type { FailureCondition, GameData, Mutator, NewPrisonConfig } from '@blockwork/sim'
import type {
  CoachAnchorRect,
  NewPrisonModel,
  OnboardingModel,
  SettingsModel,
} from '@blockwork/ui'

import { AUTOSAVE_HOURS } from './appSettings'
import type { AppSettings, COLOUR_BLIND_PALETTES } from './appSettings'
import type { CoachAnchor, Onboarding } from './onboarding'

const PALETTE_OPTIONS: readonly { readonly id: (typeof COLOUR_BLIND_PALETTES)[number]; readonly label: string }[] =
  [
    { id: 'default', label: 'Default' },
    { id: 'deuteranopia', label: 'Deuteranopia' },
    { id: 'protanopia', label: 'Protanopia' },
    { id: 'tritanopia', label: 'Tritanopia' },
  ]

const ANCHOR_SELECTOR: Readonly<Record<CoachAnchor, string>> = {
  'tool:build': '[data-tool="build"]',
  'tool:rooms': '[data-tool="rooms"]',
  'tool:objects': '[data-tool="objects"]',
  'tool:utilities': '[data-tool="utilities"]',
  'tool:staff': '[data-tool="staff"]',
  'tool:reports': '[data-tool="reports"]',
  'topbar:speed': '[data-anchor="topbar:speed"]',
  'topbar:alerts': '[data-anchor="topbar:alerts"]',
  'panel:directorate': '[data-anchor="panel:directorate"]',
  'panel:intake': '[data-anchor="panel:intake"]',
  none: '',
}

/** Screen-space rect of a named coach-mark anchor, or null when it is off-screen. */
export function coachAnchorRect(host: ParentNode | null, anchor: CoachAnchor): CoachAnchorRect | null {
  if (anchor === 'none' || host === null) return null
  const selector = ANCHOR_SELECTOR[anchor]
  if (selector === '') return null
  const el = host.querySelector(selector)
  if (!(el instanceof HTMLElement)) return null
  const hostEl = host instanceof HTMLElement ? host : el.offsetParent
  const origin =
    hostEl instanceof HTMLElement ? hostEl.getBoundingClientRect() : { left: 0, top: 0 }
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left - origin.left),
    y: Math.round(r.top - origin.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

/** Builds the panel model from the live controller. */
export function onboardingModelFromMachine(
  machine: Onboarding,
  nowMs: number,
  contractName: string,
  host: ParentNode | null,
): OnboardingModel {
  const state = machine.state(nowMs)
  const viewportEl = host instanceof HTMLElement ? host : null
  const viewport = viewportEl?.getBoundingClientRect()
  return {
    mode: state.mode,
    contractName,
    objectives: state.objectives.map((objective) => ({
      index: objective.index,
      label: objective.label,
      done: objective.done,
      current: objective.index === state.currentIndex,
    })),
    marks: state.marks.map((mark) => ({
      objectiveIndex: mark.objectiveIndex,
      title: mark.title,
      body: mark.body,
      anchorRect: coachAnchorRect(host, mark.anchor),
    })),
    viewport: {
      width: Math.max(1, Math.floor(viewport?.width ?? 1024)),
      height: Math.max(1, Math.floor(viewport?.height ?? 768)),
    },
  }
}

/** Settings panel model from persisted app settings (T8.8). */
export function settingsModelFromAppSettings(settings: AppSettings): SettingsModel {
  return {
    music: settings.audio.music,
    sfx: settings.audio.sfx,
    muted: settings.audio.muted,
    palette: settings.accessibility.palette,
    paletteOptions: PALETTE_OPTIONS,
    reduceMotion: settings.accessibility.reduceMotion,
    typeScale: settings.accessibility.typeScale,
    preferNoFailure: settings.accessibility.preferNoFailure,
    autosaveHours: settings.autosaveHours,
    autosaveOptions: AUTOSAVE_HOURS,
  }
}

/** New Prison panel → sim config (T8.8 / T6.5). */
export function newPrisonConfigFromModel(
  model: NewPrisonModel,
  data: GameData,
  random: () => number = Math.random,
): NewPrisonConfig {
  const failures = Object.fromEntries(FAILURE_CONDITIONS.map((id) => [id, true])) as Record<
    FailureCondition,
    boolean
  >
  for (const entry of model.failures) {
    if (isFailureCondition(entry.id)) failures[entry.id] = entry.enabled
  }
  const mutators = Object.fromEntries(MUTATORS.map((id) => [id, true])) as Record<Mutator, boolean>
  for (const entry of model.mutators) {
    if (isMutator(entry.id)) mutators[entry.id] = entry.enabled
  }
  return {
    sizePreset: model.sizePreset,
    mapSize: resolveMapSize(data, model.sizePreset),
    seed: seedFromInput(model.seedInput, random),
    startingFunds: model.startingFunds,
    continuousIntake: model.continuousIntake,
    failures,
    randomEvents: model.randomEvents,
    mutators,
    firstOrderGrace: model.firstOrderGrace,
  }
}

/** Whether a timed autosave should fire (PRD 3.10). */
export function autosaveDue(
  currentTick: number,
  lastAutosaveTick: number,
  hours: number,
  ticksPerHour: number,
): boolean {
  if (!Number.isFinite(currentTick) || !Number.isFinite(lastAutosaveTick)) return false
  if (hours <= 0 || ticksPerHour <= 0) return false
  return currentTick - lastAutosaveTick >= hours * ticksPerHour
}
