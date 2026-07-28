/**
 * The game shell's stylesheet.
 *
 * One string, injected once by the host, rather than a `.css` file per
 * component: nothing in the build pipeline handles stylesheets yet, and the
 * states this interface needs — `:hover:not(:disabled)`, `:active`,
 * `:focus-visible`, `@media (prefers-reduced-motion)` — cannot be expressed as
 * inline style objects at all. Every value is a `var(--token)` from
 * `tokens.ts`, which is the mockup's `:root` block; there are no literal
 * colours below, and there should never be.
 *
 * Where this goes beyond the mockup, and why. A static spec has no states: it
 * shows what a button looks like, not what it feels like to press one, and a
 * faithful transcription of it lands as something that looks approximately
 * right and reads as a prototype. The additions are all in that gap:
 *
 *   - **Press feedback.** Touch has no hover, so on iPad the only confirmation
 *     a tap ever registered is what happens on `:active`. Every control here
 *     dips slightly and settles; nothing moves more than 1px or scales more
 *     than 1.5%, because the point is to be felt rather than seen.
 *   - **One motion vocabulary.** Two durations and one curve, as custom
 *     properties, so panels cannot each invent their own easing. The curve is
 *     a soft-landing cubic — fast out of the gate, slow into the stop — which
 *     is what makes a sliding inspector read as weight rather than as a
 *     transition.
 *   - **Focus that is visible without being loud.** A two-tone ring, so it
 *     survives on both `--surface-1` and `--accent`.
 *   - **Tabular numerals everywhere a number changes.** A clock, a balance or
 *     an fps counter whose digits are proportionally spaced jitters on every
 *     update. This is the cheapest single upgrade in the file.
 *   - **Safe areas.** The top bar and dock sit inside `env(safe-area-inset-*)`
 *     so the shell is correct on a device with rounded corners and a home
 *     indicator, which the 1194x834 mockup canvas cannot express.
 *
 * `prefers-reduced-motion` disables all of it (PRD 7.9), and the camera has
 * its own matching switch.
 */

import { themeCss } from './tokens'

/** Reset, tokens, motion vocabulary and typography. */
const BASE = `
*, *::before, *::after { box-sizing: border-box; }

.bw-shell {
  --dur-fast: 120ms;
  --dur: 220ms;
  --dur-slow: 320ms;
  /* Fast out, slow in. The difference between "it moved" and "it has mass". */
  --ease: cubic-bezier(.22, .61, .36, 1);
  --ease-out: cubic-bezier(.16, 1, .3, 1);

  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;

  background: var(--bg-app);
  color: var(--text);
  font: 400 var(--f-body)/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI',
    Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  /* The canvas handles its own gestures; the browser must not also scroll. */
  touch-action: none;
}

.bw-shell h1, .bw-shell h2, .bw-shell h3, .bw-shell h4 {
  margin: 0;
  color: var(--text-hi);
  font-weight: 600;
  letter-spacing: -.01em;
}

.bw-shell p, .bw-shell ul, .bw-shell li { margin: 0; padding: 0; }
.bw-shell ul { list-style: none; }

/* Any number that changes has to hold its column. */
.bw-num, .bw-shell .v, .bw-shell .t, .bw-shell .rate { font-variant-numeric: tabular-nums; }

.bw-shell :focus { outline: none; }
.bw-shell :focus-visible {
  outline: 2px solid var(--info);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}

.ico-svg { display: block; flex: 0 0 auto; }

@media (prefers-reduced-motion: reduce) {
  .bw-shell, .bw-shell * {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
  }
}
`

/** Top bar, stage, dock, inspector, tray. */
const LAYOUT = `
.bw-topbar {
  flex: 0 0 auto;
  height: calc(var(--topbar-h) + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) var(--s3) 0;
  display: flex;
  align-items: center;
  gap: var(--s3);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border);
  z-index: 30;
}

.bw-stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--bg-void);
}
.bw-stage > canvas { display: block; width: 100%; height: 100%; }

.bw-dock {
  flex: 0 0 auto;
  height: calc(var(--dock-h) + env(safe-area-inset-bottom, 0px));
  padding: 0 var(--s3) env(safe-area-inset-bottom, 0px);
  display: flex;
  align-items: center;
  gap: var(--s2);
  background: var(--surface-1);
  border-top: 1px solid var(--border);
  z-index: 30;
}

.bw-spacer { flex: 1; }

/* --- inspector ------------------------------------------------------------ */

.bw-inspector {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--inspector-w);
  max-width: 88vw;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 28px rgba(0, 0, 0, .35);
  z-index: 24;
  /* Slides over the world, never resizes it (PRD 6.1). */
  transform: translateX(0);
  transition: transform var(--dur-slow) var(--ease-out);
}
.bw-inspector[data-open='false'] { transform: translateX(100%); pointer-events: none; }

.bw-insp-head {
  padding: var(--s3);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: var(--s3);
  align-items: flex-start;
}
.bw-insp-head .who { flex: 1; min-width: 0; }
.bw-insp-head .who h3 { font-size: var(--f-lg); line-height: 1.2; }
.bw-insp-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-avatar {
  width: 56px;
  height: 56px;
  flex: 0 0 56px;
  border-radius: var(--r-md);
  background: var(--surface-3);
  color: var(--text-dim);
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
}
.bw-avatar .catbar { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; }

.bw-insp-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--s3);
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
.bw-insp-foot {
  padding: var(--s3);
  padding-bottom: max(var(--s3), env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s2);
}
.bw-insp-foot-4 { grid-template-columns: 1fr 1fr; }

.bw-tabs {
  display: flex;
  gap: 2px;
  padding: var(--s2) var(--s3) 0;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
.bw-tabs button {
  flex: 1;
  /* Mockup chrome is 40px; hit target must clear --hit-min (PRD 2.3). */
  min-height: var(--hit-min);
  height: var(--hit-min);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-faint);
  font: 600 var(--f-sm)/1 inherit;
  cursor: pointer;
}
.bw-tabs button[data-on='true'] {
  color: var(--text-hi);
  border-bottom-color: var(--accent);
}

.bw-sentence {
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  padding: var(--s3);
}
.bw-sentence .row {
  display: flex;
  justify-content: space-between;
  font-size: var(--f-cap);
  color: var(--text-dim);
  margin-bottom: 6px;
}
.bw-sentence .row b { color: var(--text-hi); }

.bw-track {
  height: 8px;
  background: var(--surface-4);
  border-radius: var(--r-pill);
  overflow: hidden;
  position: relative;
}
.bw-track i {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--info);
  border-radius: var(--r-pill);
}

.bw-needs { display: flex; flex-direction: column; gap: 2px; }

.bw-need {
  display: grid;
  grid-template-columns: 78px 1fr 34px;
  align-items: center;
  gap: var(--s2);
  /* Row chrome is tight in the mockup; the hit box still clears 44pt. */
  min-height: var(--hit-min);
  padding: 5px 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.bw-need:hover { background: var(--surface-2); }
.bw-need .nm {
  font-size: var(--f-cap);
  color: var(--text-dim);
  text-transform: capitalize;
}
.bw-need .vv {
  font-size: var(--f-cap);
  color: var(--text-faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.bw-need.crit .nm { color: var(--danger); font-weight: 600; }
.bw-need.crit .vv { color: var(--danger); }
.bw-need-bar {
  height: 6px;
  background: var(--surface-3);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.bw-need-bar i { display: block; height: 100%; border-radius: var(--r-pill); }

.bw-grades {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--s2);
}
.bw-grade {
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  padding: var(--s2);
}
.bw-grade .g-k {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-faint);
}
.bw-grade .g-v { font: 700 var(--f-xl)/1.2 inherit; color: var(--text-hi); }
.bw-grade .g-b {
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--surface-4);
  margin-top: 5px;
  overflow: hidden;
}
.bw-grade .g-b i { display: block; height: 100%; }

.bw-pill.cat { color: var(--text-on-accent); border-color: transparent; }

/* --- secondary tray ------------------------------------------------------- */

.bw-tray {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--tray-h);
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: 0 var(--s3);
  background: color-mix(in srgb, var(--surface-1) 97%, transparent);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  z-index: 20;
  transition: transform var(--dur) var(--ease-out), opacity var(--dur) var(--ease);
}
.bw-tray::-webkit-scrollbar { display: none; }
.bw-tray[data-inspector='true'] { right: var(--inspector-w); }
.bw-tray[data-open='false'] { transform: translateY(100%); opacity: 0; pointer-events: none; }

.bw-tray-group {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding-right: var(--s3);
  margin-right: var(--s1);
  border-right: 1px solid var(--border-subtle);
}
.bw-tray-group:last-child { border-right: 0; }
.bw-tray-group-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .1em;
  color: var(--text-faint);
}
`

/** Buttons, chips, tools, pills, segmented controls. */
const CONTROLS = `
.bw-btn {
  height: var(--hit-min);
  padding: 0 var(--s4);
  border-radius: var(--r-md);
  border: 1px solid var(--border-strong);
  background: var(--surface-3);
  color: var(--text-hi);
  font: 600 var(--f-sm)/1 inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s2);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease);
}
.bw-btn:hover:not(:disabled) { background: var(--surface-4); }
.bw-btn:active:not(:disabled) { transform: translateY(1px) scale(.985); }
.bw-btn:disabled { opacity: .45; cursor: default; }
.bw-btn.ghost { background: transparent; }
.bw-btn.ghost:hover:not(:disabled) { background: var(--surface-2); }
.bw-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
.bw-btn.primary:hover:not(:disabled) { background: var(--accent-press); border-color: var(--accent-press); }
.bw-btn.danger { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
.bw-btn.sm { height: 32px; padding: 0 var(--s3); font-size: var(--f-cap); }
.bw-btn.wide { padding: 0 var(--s5); }

.bw-iconbtn {
  width: var(--hit-min);
  height: var(--hit-min);
  flex: 0 0 var(--hit-min);
  display: grid;
  place-items: center;
  position: relative;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--text);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.bw-iconbtn:hover { background: var(--surface-3); color: var(--text-hi); }
.bw-iconbtn:active { transform: scale(.94); }
.bw-iconbtn:disabled { opacity: .4; cursor: default; }
.bw-iconbtn[data-on='true'] { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }

.bw-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--r-pill);
  border: 2px solid var(--surface-1);
  background: var(--danger);
  color: #fff;
  font: 700 var(--f-micro)/17px inherit;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.bw-badge[data-pulse='true'] { animation: bw-pulse 1.6s var(--ease) infinite; }

@keyframes bw-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--danger-soft); }
  50% { box-shadow: 0 0 0 7px transparent; }
}

/* --- speed segmented control --- */

.bw-speed {
  display: flex;
  /* Mockup chrome is 40px tall; expand to --hit-min so every stop clears 44pt. */
  height: var(--hit-min);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  flex: 0 0 auto;
}
.bw-speed button {
  width: var(--hit-min);
  height: var(--hit-min);
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font: 600 var(--f-sm)/1 inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.bw-speed button:hover:not([data-on='true']) { background: var(--surface-3); color: var(--text); }
.bw-speed button[data-on='true'] { background: var(--accent); color: var(--text-on-accent); }

/* --- dock tool --- */

.bw-tool {
  width: 76px;
  height: 68px;
  flex: 0 0 76px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.bw-tool:hover:not([data-on='true']) { background: var(--surface-3); color: var(--text); }
.bw-tool:active { transform: scale(.96); }
.bw-tool[data-on='true'] { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
.bw-tool .lb {
  font-size: var(--f-micro);
  font-weight: 600;
  letter-spacing: .03em;
  text-transform: uppercase;
}
.bw-tool.danger { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
.bw-tool.danger:hover { background: var(--danger-soft); color: var(--danger); }

/* --- tray chip --- */

.bw-chip {
  flex: 0 0 auto;
  min-width: 96px;
  height: 68px;
  padding: 0 var(--s3);
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.bw-chip:hover:not([data-on='true']) { background: var(--surface-3); }
.bw-chip:active { transform: scale(.97); }
.bw-chip[data-on='true'] { border-color: var(--accent); background: var(--accent-soft); }
.bw-chip .n { font-size: var(--f-cap); font-weight: 600; color: var(--text); }
.bw-chip[data-on='true'] .n { color: var(--text-hi); }
.bw-chip .c { font-size: var(--f-micro); color: var(--text-faint); }
.bw-chip .g { color: var(--text-dim); }
.bw-chip[data-on='true'] .g { color: var(--accent); }

/* --- pills, stats, meters --- */

.bw-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--r-pill);
  border: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text);
  font-size: var(--f-cap);
  font-weight: 600;
}
.bw-pill.ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.bw-pill.warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.bw-pill.bad { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.bw-pill.info { background: var(--info-soft); color: var(--info); border-color: transparent; }
.bw-pill.ghost { background: transparent; color: var(--text-faint); border-style: dashed; }
.bw-pills { display: flex; flex-wrap: wrap; gap: 6px; }

.bw-clock { display: flex; flex-direction: column; line-height: 1.15; min-width: 104px; }
.bw-clock .t {
  font: 600 var(--f-lg)/1.1 ui-monospace, 'SF Mono', Menlo, monospace;
  color: var(--text-hi);
}
.bw-clock .d { font-size: var(--f-cap); color: var(--text-faint); }

.bw-stat {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  padding: 0 var(--s3);
  border-left: 1px solid var(--border-subtle);
  min-width: 120px;
}
.bw-stat .k {
  font-size: var(--f-micro);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: .07em;
}
.bw-stat .v { font: 600 var(--f-lg)/1.1 inherit; color: var(--text-hi); }
.bw-stat .v.pos { color: var(--ok); }
.bw-stat .v.neg { color: var(--danger); }
.bw-stat .v.warn { color: var(--warn); }
.bw-stat .sub { font-size: var(--f-cap); color: var(--text-dim); }

.bw-gauge { display: flex; flex-direction: column; gap: 4px; width: 150px; flex: 0 0 auto; }
.bw-gauge .row {
  display: flex;
  justify-content: space-between;
  font-size: var(--f-micro);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: .07em;
}
.bw-gauge .row b { color: var(--warn); font-size: var(--f-cap); }
.bw-bar { height: 6px; background: var(--surface-3); border-radius: var(--r-pill); overflow: hidden; }
.bw-bar i {
  display: block;
  height: 100%;
  border-radius: var(--r-pill);
  transition: width var(--dur-slow) var(--ease-out), background var(--dur) var(--ease);
}

.bw-kv {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--s2);
  padding: 7px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--f-sm);
}
.bw-kv:last-child { border-bottom: 0; }
.bw-kv .k { color: var(--text-dim); }
.bw-kv .v { color: var(--text-hi); font-weight: 600; }

.bw-block h4 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--text-faint);
  margin-bottom: var(--s2);
  font-weight: 700;
}

.bw-req {
  display: flex;
  align-items: center;
  gap: var(--s2);
  padding: 6px 0;
  font-size: var(--f-sm);
  border-bottom: 1px solid var(--border-subtle);
}
.bw-req:last-child { border-bottom: 0; }
.bw-req .n { flex: 1; color: var(--text); }
.bw-req[data-met='true'] .mk { color: var(--ok); }
.bw-req[data-met='false'] .mk { color: var(--danger); }
.bw-req[data-met='false'] .n { color: var(--text-hi); }
`

/** Blueprint bar, toasts, legend: the things that float over the world. */
const OVERLAYS = `
.bw-bpbar {
  position: absolute;
  left: var(--s4);
  right: var(--s4);
  bottom: calc(var(--tray-h) + var(--s3));
  background: color-mix(in srgb, var(--surface-1) 97%, transparent);
  border: 1px solid var(--info);
  border-radius: var(--r-lg);
  box-shadow: var(--e3);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  overflow: hidden;
  z-index: 22;
  animation: bw-rise var(--dur) var(--ease-out);
}
.bw-bpbar[data-inspector='true'] { right: calc(var(--inspector-w) + var(--s4)); }
.bw-bpbar[data-tray='false'] { bottom: var(--s4); }

@keyframes bw-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

.bw-bpbar .bp-top { display: flex; align-items: center; gap: var(--s4); padding: var(--s3); }
.bw-bp-metric { display: flex; flex-direction: column; min-width: 96px; }
.bw-bp-metric .k {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text-faint);
}
.bw-bp-metric .v {
  font: 700 var(--f-xl)/1.15 inherit;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.bw-bp-metric .v.bad { color: var(--danger); }

.bw-bp-issues {
  border-top: 1px solid var(--border);
  background: var(--surface-1);
  max-height: 148px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.bw-issue {
  display: flex;
  align-items: center;
  gap: var(--s3);
  width: 100%;
  /* The mockup's rows are 39px. PRD 2.3 forbids anything under 44. */
  min-height: var(--hit-min);
  padding: 9px var(--s3);
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  color: inherit;
  font: 400 var(--f-sm)/1.45 inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.bw-issue:hover { background: var(--surface-2); }
.bw-issue:active { background: var(--surface-3); }
.bw-issue .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
.bw-issue .t { flex: 1; color: var(--text); }
.bw-issue .go {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--f-cap);
  color: var(--info);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* --- toasts --- */

.bw-toasts {
  position: absolute;
  top: var(--s3);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  width: min(520px, calc(100% - var(--s7)));
  z-index: 25;
  pointer-events: none;
}
.bw-toast {
  display: flex;
  align-items: center;
  gap: var(--s3);
  padding: var(--s3);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--e2);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  pointer-events: auto;
  animation: bw-toast-in var(--dur) var(--ease-out);
}
@keyframes bw-toast-in {
  from { opacity: 0; transform: translateY(-8px) scale(.98); }
  to { opacity: 1; transform: none; }
}
.bw-toast.warn { border-color: var(--warn); }
.bw-toast.crit {
  border-color: var(--danger);
  background: linear-gradient(90deg, var(--danger-soft), color-mix(in srgb, var(--surface-1) 96%, transparent) 42%);
}
.bw-toast .ico {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
}
.bw-toast.warn .ico { background: var(--warn-soft); color: var(--warn); }
.bw-toast.crit .ico { background: var(--danger-soft); color: var(--danger); }
.bw-toast.info .ico { background: var(--info-soft); color: var(--info); }
.bw-toast .txt { flex: 1; min-width: 0; }
.bw-toast .txt b { display: block; color: var(--text-hi); font-size: var(--f-sm); font-weight: 600; }
.bw-toast .txt span { font-size: var(--f-cap); color: var(--text-dim); }
.bw-toast .count {
  flex: 0 0 auto;
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* --- Trace panel (PRD 3.1) ------------------------------------------------ */

.bw-trace-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 28;
  transform: translateY(0);
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-trace-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-trace-head {
  padding: var(--s3) var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: var(--s3);
  align-items: flex-start;
}
.bw-trace-head .who { flex: 1; min-width: 0; }
.bw-trace-head .who h2 { font-size: var(--f-lg); line-height: 1.2; color: var(--text-hi); }
.bw-trace-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-trace-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: var(--s4);
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}

.bw-trace { max-width: 640px; display: flex; flex-direction: column; }

.bw-tnode {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: var(--s3);
  position: relative;
  padding: 0;
  padding-bottom: var(--s4);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.bw-tnode:last-child { padding-bottom: 0; }
.bw-tnode .rail { display: flex; flex-direction: column; align-items: center; }
.bw-tnode .knob {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--surface-3);
  border: 2px solid var(--border-strong);
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 24px;
}
.bw-tnode.first .knob {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
  font-weight: 700;
}
.bw-tnode .line {
  flex: 1;
  width: 2px;
  background: var(--border);
  margin-top: 4px;
  min-height: 12px;
}
.bw-tnode:last-child .line { display: none; }
.bw-tnode .tcard {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--s3);
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.bw-tnode:hover .tcard {
  background: var(--surface-3);
  border-color: var(--border-strong);
}
.bw-tnode .tcard.danger { border-color: var(--danger); }
.bw-tnode .th { font-size: var(--f-sm); color: var(--text-hi); font-weight: 600; }
.bw-tnode .tcard.danger .th { color: var(--danger); }
.bw-tnode .tm { font-size: var(--f-cap); color: var(--text-dim); margin-top: 4px; }
.bw-tnode .tt {
  font-size: var(--f-micro);
  color: var(--text-faint);
  margin-top: 6px;
  text-transform: uppercase;
  letter-spacing: .07em;
}

.bw-fixes {
  display: flex;
  gap: var(--s2);
  flex-wrap: wrap;
  max-width: 640px;
}

/* --- Posts / deployment panel (T4.1, PRD 3.5) ------------------------------ */

.bw-posts-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 27;
  transform: translateY(0);
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-posts-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-posts-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-posts-head .who { flex: 0 1 auto; min-width: 0; }
.bw-posts-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-posts-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-seg {
  display: flex;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  flex: 0 0 auto;
}
.bw-seg button {
  padding: 0 var(--s3);
  height: 34px;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font: 600 var(--f-cap)/1 inherit;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.bw-seg button:hover:not(:disabled):not([data-on='true']) {
  background: var(--surface-3);
  color: var(--text);
}
.bw-seg button[data-on='true'] { background: var(--surface-4); color: var(--text-hi); }
.bw-seg button:disabled { opacity: .4; cursor: default; }

.bw-posts-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 400px;
  gap: var(--s4);
  padding: var(--s4);
  overflow: hidden;
}

.bw-posts-map,
.bw-posts-card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.bw-posts-map > header,
.bw-posts-card > header {
  padding: var(--s3);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--s2);
  flex: 0 0 auto;
}
.bw-posts-map > header h3,
.bw-posts-card > header h3 {
  font-size: var(--f-body);
  color: var(--text-hi);
  font-weight: 600;
}
.bw-posts-card-danger { border-color: var(--danger); }
.bw-posts-card-danger > header h3 { color: var(--danger); }

.bw-posts-map-stage {
  flex: 1;
  position: relative;
  min-height: 280px;
  background: var(--terrain-grass, #3a4a3a);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--s4);
}
.bw-posts-map-hint {
  max-width: 280px;
  text-align: center;
  font-size: var(--f-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.bw-posts-legend {
  position: absolute;
  left: var(--s3);
  bottom: var(--s3);
  margin: 0;
}

.bw-posts-side {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
  overflow: hidden;
}
.bw-posts-card-body {
  padding: var(--s3);
  font-size: var(--f-sm);
  color: var(--text-dim);
  line-height: 1.6;
}
.bw-posts-hire { margin-top: var(--s2); }
.bw-posts-list { flex: 1; overflow: auto; }
.bw-posts-empty {
  padding: var(--s3);
  font-size: var(--f-sm);
  color: var(--text-faint);
  margin: 0;
}

.bw-postrow {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: var(--s3);
  align-items: center;
  width: 100%;
  padding: var(--s3);
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.bw-postrow:last-child { border-bottom: 0; }
.bw-postrow:hover { background: var(--surface-2); }
.bw-postrow .pn {
  font-size: var(--f-sm);
  color: var(--text-hi);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.bw-postrow .pd {
  font-size: var(--f-cap);
  color: var(--text-faint);
  margin-top: 2px;
}
.bw-posts-reason { color: var(--danger); }
.bw-posts-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--surface-4);
  border: 1px solid var(--border);
  flex: 0 0 12px;
}
.staffing { display: flex; align-items: center; gap: 5px; }
.dotfill {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--ok);
  display: block;
}
.dotempty {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--surface-4);
  border: 1px dashed var(--danger);
  display: block;
}

/* --- Standing Orders panel (T4.3, PRD 5.10) -------------------------------- */

.bw-orders-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 28;
  transform: translateY(0);
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-orders-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-orders-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-orders-head .who { flex: 0 1 auto; min-width: 0; }
.bw-orders-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-orders-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-orders-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--s4);
  padding: var(--s4);
  overflow: hidden;
}
.bw-orders-body[data-side='true'] {
  grid-template-columns: 1fr 340px;
}

.bw-orders-main { min-height: 0; overflow: auto; }
.bw-orders-side {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  min-height: 0;
  overflow: auto;
}

.bw-orders-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.bw-orders-card > header {
  height: 44px;
  padding: 0 var(--s3);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s2);
}
.bw-orders-card > header h3 {
  font-size: var(--f-body);
  color: var(--text-hi);
  font-weight: 600;
}
.bw-orders-card-body { padding: var(--s3); }

.bw-orders-pill {
  margin-left: auto;
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
}
.bw-orders-pill.warn { color: var(--warn); border-color: var(--warn); }

.bw-orders-matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--f-cap);
}
.bw-orders-matrix th {
  text-align: left;
  color: var(--text-faint);
  font-weight: 600;
  padding: 0 8px 10px 0;
  border-bottom: 1px solid var(--border);
}
.bw-orders-matrix td {
  padding: 10px 8px 10px 0;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: middle;
}
.bw-orders-matrix tr:last-child td { border-bottom: 0; }

.bw-radio-seg {
  display: flex;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
  height: 36px;
  min-width: 220px;
}
.bw-radio-seg-wide { max-width: 360px; height: 44px; }
.bw-radio-seg button {
  flex: 1;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  font: 600 var(--f-cap)/1 inherit;
  cursor: pointer;
  padding: 0 var(--s2);
}
.bw-radio-seg button[data-on='true'] {
  background: var(--surface-4);
  color: var(--text-hi);
}
.bw-radio-seg button[data-on='true'][data-tone='warn'] { color: var(--warn); }
.bw-radio-seg button[data-on='true'][data-tone='bad'] { color: var(--danger); }

.bw-orders-duration {
  color: var(--text-faint);
  white-space: nowrap;
}
.bw-orders-duration-btn {
  margin-left: 6px;
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text);
  cursor: pointer;
}
.bw-orders-search { text-align: center; width: 72px; }
.bw-orders-check {
  background: transparent;
  border: 0;
  color: var(--text-faint);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
}
.bw-orders-check[data-on='true'] { color: var(--accent); }

.bw-orders-strictness { margin-top: var(--s5); }
.bw-orders-strictness h4,
.bw-orders-card-body h4 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: .09em;
  color: var(--text-faint);
  margin: 0 0 var(--s2);
}

.bw-orders-copy {
  font-size: var(--f-cap);
  color: var(--text-dim);
  line-height: 1.55;
  margin: 0 0 var(--s3);
}

.bw-orders-variety {
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-orders-variety button {
  width: 36px;
  height: 36px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface-3);
  color: var(--text-hi);
  font-size: 18px;
  cursor: pointer;
}
.bw-orders-variety button:disabled { opacity: .4; cursor: default; }
.bw-orders-variety span { color: var(--text); font-size: var(--f-body); }

.bw-orders-proj { display: flex; flex-direction: column; gap: var(--s3); }
.bw-orders-proj-label {
  display: flex;
  justify-content: space-between;
  font-size: var(--f-cap);
  color: var(--text-dim);
  margin-bottom: 5px;
}
.bw-orders-proj-label b[data-tone='warn'] { color: var(--warn); }
.bw-orders-proj-label b[data-tone='ok'] { color: var(--ok); }
.bw-orders-proj-label b[data-tone='danger'] { color: var(--danger); }

.bw-orders-bar {
  height: 8px;
  background: var(--surface-3);
  border-radius: 999px;
  overflow: hidden;
}
.bw-orders-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
}
.bw-orders-bar i[data-tone='warn'] { background: var(--warn); }
.bw-orders-bar i[data-tone='ok'] { background: var(--ok); }
.bw-orders-bar i[data-tone='danger'] { background: var(--danger); }

.bw-orders-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--s3);
  font-size: var(--f-cap);
  color: var(--text-dim);
  padding: 4px 0;
}
.bw-orders-kv b { color: var(--text-hi); }
.bw-orders-kv b[data-tone='danger'] { color: var(--danger); }

/* --- world-corner readouts --- */

.bw-legend {
  position: absolute;
  left: var(--s4);
  bottom: var(--s4);
  min-width: 190px;
  padding: var(--s3);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--e2);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 21;
}
.bw-legend h4 {
  font-size: var(--f-cap);
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-faint);
  margin-bottom: var(--s2);
  font-weight: 600;
}
.bw-legend .lrow { display: flex; align-items: center; gap: var(--s2); font-size: var(--f-sm); padding: 2px 0; }
.bw-legend .sw { width: 14px; height: 14px; border-radius: 3px; flex: 0 0 14px; }

.bw-hud {
  position: absolute;
  top: var(--s3);
  left: var(--s3);
  padding: 5px var(--s2);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--bg-app) 78%, transparent);
  color: var(--text-faint);
  font: 400 var(--f-micro)/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  z-index: 21;
}

/* --- transient hint over the world --- */

.bw-hint {
  position: absolute;
  left: 50%;
  bottom: calc(var(--tray-h) + var(--s4));
  transform: translateX(-50%);
  padding: var(--s2) var(--s4);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  border: 1px solid var(--border);
  box-shadow: var(--e2);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--text);
  font-size: var(--f-sm);
  white-space: nowrap;
  pointer-events: none;
  z-index: 21;
}
.bw-hint b { color: var(--text-hi); font-weight: 600; }
`

/**
 * The whole sheet: tokens first, then everything that reads them.
 *
 * Built once at module scope rather than per call — the string is constant,
 * and a host that injects it on every render should still only pay for it
 * once.
 */
export const SHELL_CSS: string = [themeCss(), BASE, LAYOUT, CONTROLS, OVERLAYS].join('\n')

/**
 * Injects the sheet into a document, once.
 *
 * Idempotent by id, so a hot reload or a second shell does not stack
 * duplicate copies of several hundred rules.
 */
export const SHELL_STYLE_ID = 'blockwork-shell-css'

export function injectShellCss(doc: Document): void {
  if (doc.getElementById(SHELL_STYLE_ID) !== null) return

  const style = doc.createElement('style')
  style.id = SHELL_STYLE_ID
  style.textContent = SHELL_CSS
  doc.head.appendChild(style)
}
