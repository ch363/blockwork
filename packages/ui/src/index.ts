/**
 * @blockwork/ui - Preact panels and controls.
 *
 * May import from @blockwork/sim for types only (`import type`). Never imports
 * from render or app.
 */

export const UI_PACKAGE_NAME = '@blockwork/ui'

export { MIN_HIT_TARGET_PT } from './constants'

export { TOKENS, TOKEN_VALUES, themeCss, token, tokenHex, tokenVar } from './theme/tokens'

export { SHELL_CSS, SHELL_STYLE_ID, injectShellCss } from './theme/shellCss'

export { ICON_NAMES, Icon } from './icons'
export type { IconName, IconProps } from './icons'

export { App } from './App'
export type { AppProps } from './App'

export { GameShell } from './GameShell'
export type { GameShellProps } from './GameShell'

export {
  LAYOUT,
  LAYOUT_TOLERANCE_PX,
  REFERENCE_HEIGHT,
  REFERENCE_WIDTH,
} from './controls/layoutMetrics'
export { WORLD_UNITS_PER_TILE, hitTestEntities, resolveWorldTap } from './controls/hitTest'
export type { HitTestEntity } from './controls/hitTest'
export { auditAccessibleNames, auditHitTargets } from './controls/hitTargets'
export type { HitTargetViolation } from './controls/hitTargets'
export { cycleSpeed, speedFromKeyboard } from './controls/speedKeys'
export type { SpeedKeyResult, SpeedKeyState } from './controls/speedKeys'
export { Button } from './controls/Button'
export type { ButtonProps } from './controls/Button'
export { IconButton } from './controls/IconButton'
export type { IconButtonProps } from './controls/IconButton'
export { NeedRow } from './controls/NeedRow'
export type { NeedRowModel, NeedRowProps, NeedSeverity } from './controls/NeedRow'

export { SPEED_STOPS, TopBar, dangerBand, formatMoney, formatRate } from './panels/TopBar'
export type { SpeedStop, TopBarModel, TopBarProps } from './panels/TopBar'

export { DOCK_TOOLS, DOCK_TOOL_IDS, ToolDock } from './panels/ToolDock'
export type { DockTool, DockToolId, ToolDockProps } from './panels/ToolDock'

export { Tray } from './panels/Tray'
export type { TrayGroup, TrayItem, TrayProps } from './panels/Tray'

export { OverlayLegend } from './panels/OverlayLegend'
export type {
  OverlayLegendEntry,
  OverlayLegendModel,
  OverlayLegendPattern,
  OverlayLegendProps,
} from './panels/OverlayLegend'

export { Inspector, categoryToken, requirementLabel } from './panels/Inspector'
export type {
  CategoryToken,
  InmateInspectorModel,
  InspectorGrade,
  InspectorMisconduct,
  InspectorModel,
  InspectorNeed,
  InspectorProps,
  InspectorReputation,
  ObjectInspectorModel,
  RoomInspectorModel,
  StaffInspectorModel,
  TileInspectorModel,
} from './panels/Inspector'

export { InspectorInmate } from './panels/InspectorInmate'
export type { InspectorInmateProps } from './panels/InspectorInmate'
export { InspectorStaff } from './panels/InspectorStaff'
export type { InspectorStaffProps } from './panels/InspectorStaff'
export { InspectorRoom } from './panels/InspectorRoom'
export type { InspectorRoomProps } from './panels/InspectorRoom'
export { InspectorObject } from './panels/InspectorObject'
export type { InspectorObjectProps } from './panels/InspectorObject'

export { Toasts } from './panels/Toasts'
export type { ToastModel, ToastSeverity, ToastsProps } from './panels/Toasts'

export { Trace, traceModelFromView } from './panels/Trace'
export type { TraceFixModel, TraceModel, TraceNodeModel, TraceProps } from './panels/Trace'

export { Posts, unfilledReasonLabel } from './panels/Posts'
export type {
  PostsModel,
  PostsProps,
  PostsRowModel,
  PostsTab,
  SectorRowModel,
  UnfilledReasonLabel,
} from './panels/Posts'

export { StandingOrders, formatDuration, MISCONDUCT_LABELS } from './panels/StandingOrders'
export type {
  StandingMealQuantity,
  StandingOrdersModel,
  StandingOrdersProjection,
  StandingOrdersProps,
  StandingOrdersRowModel,
  StandingOrdersTab,
  StandingPunishment,
  StandingStrictness,
} from './panels/StandingOrders'

export {
  DIRECTORATE_MAX_ZOOM,
  DIRECTORATE_MIN_ZOOM,
  DIRECTORATE_NODE_HEIGHT,
  DIRECTORATE_NODE_WIDTH,
  Directorate,
  clampZoom,
  edgePath,
  formatDurationHours,
} from './panels/Directorate'
export type {
  DirectorateBlocker,
  DirectorateBranchId,
  DirectorateModel,
  DirectorateNodeModel,
  DirectorateNodeStatus,
  DirectorateProps,
} from './panels/Directorate'

export { FUNDS_STOPS, NewPrison, formatFunds, isNoFailureMode } from './panels/NewPrison'
export type {
  MapSizeOption,
  MapSizePreset,
  NewPrisonModel,
  NewPrisonProps,
  ToggleModel,
} from './panels/NewPrison'

export { Settings, percentLabel, typeScaleLabel } from './panels/Settings'
export type {
  ColourBlindPalette,
  SettingsModel,
  SettingsProps,
  SettingsTab,
} from './panels/Settings'

export {
  COACH_BUBBLE_MARGIN,
  COACH_BUBBLE_WIDTH,
  Onboarding,
  placeBubble,
} from './panels/Onboarding'
export type {
  BubblePlacement,
  CoachAnchorRect,
  CoachMarkModel,
  OnboardingMode,
  OnboardingModel,
  OnboardingObjectiveModel,
  OnboardingProps,
} from './panels/Onboarding'

export { Alerts, countLabel } from './panels/Alerts'
export type {
  AlertCategoryModel,
  AlertRowModel,
  AlertSeverity,
  AlertsModel,
  AlertsProps,
} from './panels/Alerts'

export { Intelligence, coverageOf, formatChance } from './panels/Intelligence'
export type {
  ContrabandSourceRowModel,
  InformantRowModel,
  IntelligenceModel,
  IntelligenceProps,
  IntelligenceTab,
  MarketRowModel,
  RevealedReputationModel,
} from './panels/Intelligence'

export { Reports, drawSeriesChart, filterReportLog } from './panels/Reports'
export type {
  ArrivalCategoryModel,
  ChartSeries,
  FinanceReportModel,
  NeedBottleneckModel,
  NeedFacilityModel,
  NeedLocationModel,
  NeedReportRowModel,
  NeedSeverityBands,
  NeedsReportModel,
  PopulationCategoryModel,
  PopulationReportModel,
  ReportCategoryAmount,
  ReportDayCashflow,
  ReportLogFilters,
  ReportLogRowModel,
  ReportSeverity,
  ReportsModel,
  ReportsProps,
  ReportsTab,
  SentenceBandModel,
  SeriesChartOptions,
  StatisticMetricModel,
  StatisticsReportModel,
} from './panels/Reports'

export { Programs, blockerSentence, formatHour } from './panels/Programs'
export type {
  ProgramBlockerKind,
  ProgramBlockerModel,
  ProgramRowModel,
  ProgramsModel,
  ProgramsProps,
} from './panels/Programs'

export { Emergency } from './panels/Emergency'
export type {
  EmergencyLevelId,
  EmergencyLevelModel,
  EmergencyModel,
  EmergencyProps,
} from './panels/Emergency'

export { BlueprintBar, formatCost, issueSentence, plural } from './panels/BlueprintBar'
export type { BlueprintBarProps } from './panels/BlueprintBar'
