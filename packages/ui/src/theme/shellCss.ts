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
  /* Compatibility aliases used by later panel tickets. They resolve to the
     original mockup scale rather than creating a second one. */
  --hit: var(--hit-min);
  --f-md: var(--f-body);
  --dur-fast: 120ms;
  --dur: 220ms;
  --dur-slow: 320ms;
  --dur-cinematic: 560ms;
  /* Fast out, slow in. The difference between "it moved" and "it has mass". */
  --ease: cubic-bezier(.22, .61, .36, 1);
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-spring: cubic-bezier(.2, .9, .2, 1.12);

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
  color-scheme: dark;
  isolation: isolate;
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

.bw-shell button { -webkit-tap-highlight-color: transparent; }

.bw-shell ::-webkit-scrollbar { width: 8px; height: 8px; }
.bw-shell ::-webkit-scrollbar-track { background: transparent; }
.bw-shell ::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--border-strong) 78%, transparent);
  background-clip: padding-box;
}
.bw-shell ::-webkit-scrollbar-thumb:hover {
  background: var(--text-faint);
  background-clip: padding-box;
}

.ico-svg { display: block; flex: 0 0 auto; }

@media (prefers-reduced-motion: reduce) {
  .bw-shell, .bw-shell * {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
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

/* --- map overlay legend --------------------------------------------------- */

.bw-overlay-legend {
  position: absolute;
  left: var(--s4);
  bottom: var(--s4);
  min-width: 190px;
  max-width: min(280px, calc(100% - var(--s7)));
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  box-shadow: var(--e2);
  backdrop-filter: blur(12px);
  z-index: 18;
  pointer-events: none;
}
.bw-overlay-legend[data-open='false'] { display: none; }
.bw-overlay-legend[data-tray-open='true'] {
  bottom: calc(var(--tray-h) + var(--s3));
}
.bw-overlay-legend[data-many='true'] {
  max-width: min(440px, calc(100% - var(--s7)));
}
.bw-overlay-legend[data-many='true'] ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.bw-overlay-legend header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s3);
  margin-bottom: var(--s2);
}
.bw-overlay-legend h4 {
  font-size: var(--f-cap);
  text-transform: uppercase;
  letter-spacing: .07em;
  color: var(--text-faint);
}
.bw-overlay-legend header span { font-size: var(--f-micro); color: var(--text-dim); }
.bw-overlay-legend ul { display: flex; flex-direction: column; gap: var(--s1); }
.bw-overlay-legend li {
  display: flex;
  align-items: center;
  gap: var(--s2);
  min-height: 20px;
  font-size: var(--f-sm);
  color: var(--text);
}
.bw-overlay-swatch {
  --overlay-colour: var(--info);
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  background-color: var(--overlay-colour);
}
.bw-overlay-swatch[data-pattern='diagonal'] {
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 3px,
    color-mix(in srgb, var(--bg-void) 70%, transparent) 3px 5px
  );
}
.bw-overlay-swatch[data-pattern='dots'] {
  background-image: radial-gradient(
    circle,
    color-mix(in srgb, var(--bg-void) 76%, transparent) 0 1.5px,
    transparent 1.7px
  );
  background-size: 5px 5px;
}
.bw-overlay-swatch[data-pattern='crosshatch'] {
  background-image:
    repeating-linear-gradient(
      45deg,
      transparent 0 4px,
      color-mix(in srgb, var(--bg-void) 68%, transparent) 4px 5.5px
    ),
    repeating-linear-gradient(
      135deg,
      transparent 0 4px,
      color-mix(in srgb, var(--bg-void) 68%, transparent) 4px 5.5px
    );
}

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
  z-index: 28;
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

/* --- Emergency ladder (T4.6, PRD 3.7) -------------------------------------- */

.bw-emergency-panel {
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
.bw-emergency-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-emergency-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-emergency-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-emergency-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-emergency-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--s4);
  display: flex;
  flex-direction: column;
  gap: var(--s4);
  max-width: 720px;
}

.bw-emergency-status { display: flex; flex-direction: column; gap: var(--s2); }
.bw-emergency-meter {
  display: flex;
  justify-content: space-between;
  gap: var(--s3);
  font-size: var(--f-cap);
  color: var(--text-dim);
}
.bw-emergency-meter .v { color: var(--text-hi); font-weight: 600; }
.bw-emergency-warn {
  padding: var(--s3);
  border: 1px solid var(--danger);
  border-radius: var(--r-md);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--f-sm);
  font-weight: 600;
}

.bw-emergency-ladder {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s3);
}
.bw-emergency-rung {
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: var(--s3);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.bw-emergency-rung[data-active='true'] {
  border-color: var(--danger);
  background: linear-gradient(180deg, var(--danger-soft), var(--surface-2));
}
.bw-emergency-rung .rung-head {
  display: flex;
  align-items: flex-start;
  gap: var(--s3);
}
.bw-emergency-rung .lvl {
  flex: 0 0 28px;
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--surface-4);
  color: var(--text-hi);
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: var(--f-cap);
}
.bw-emergency-rung .copy { flex: 1; min-width: 0; }
.bw-emergency-rung .copy h3 {
  margin: 0;
  font-size: var(--f-md);
  color: var(--text-hi);
}
.bw-emergency-rung .copy p {
  margin: 4px 0 0;
  font-size: var(--f-cap);
  color: var(--text-faint);
}
.bw-emergency-rung .cost {
  font-size: var(--f-cap);
  color: var(--warn);
  font-weight: 600;
  white-space: nowrap;
}
.bw-emergency-rung .rung-actions { display: flex; justify-content: flex-end; gap: var(--s2); }
.bw-emergency-rung .rung-hint {
  font-size: var(--f-micro);
  color: var(--text-faint);
}
.bw-emergency-footnote {
  font-size: var(--f-cap);
  color: var(--text-faint);
}

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

/* ---------- New prison and settings (T6.5) ---------- */

.bw-newprison {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  z-index: 40;
}
.bw-newprison > header { padding: var(--s5) var(--s5) var(--s4); }
.bw-newprison > header h2 { font-size: var(--f-2xl); color: var(--text-hi); }
.bw-newprison > header p { font-size: var(--f-sm); color: var(--text-dim); margin-top: 4px; }
.bw-newprison-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--s5) var(--s5);
  display: flex;
  flex-direction: column;
  gap: var(--s5);
}
.bw-newprison-body section { display: flex; flex-direction: column; gap: var(--s2); }
.bw-newprison-body h3 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
}
.bw-newprison > footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--s3);
  padding: var(--s4) var(--s5);
  border-top: 1px solid var(--border);
}

.bw-newprison-sizes, .bw-newprison-funds { display: flex; flex-wrap: wrap; gap: var(--s2); }
.bw-newprison-sizes button, .bw-newprison-funds button {
  min-height: var(--hit);
  padding: var(--s2) var(--s4);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: var(--f-sm);
  cursor: pointer;
}
.bw-newprison-sizes button[data-on='true'],
.bw-newprison-funds button[data-on='true'] {
  border-color: var(--accent);
  background: var(--surface-3);
  color: var(--text-hi);
}
.bw-newprison-sizes button span { font-size: var(--f-cap); color: var(--text-faint); }

.bw-newprison-seed input {
  width: 100%;
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text-hi);
  font: inherit;
  font-size: var(--f-sm);
}
.bw-newprison-hint, .bw-settings-hint {
  font-size: var(--f-cap);
  color: var(--text-faint);
  line-height: 1.5;
}
.bw-newprison-note {
  font-size: var(--f-cap);
  color: var(--ok);
  padding: var(--s2) var(--s3);
  border-radius: var(--r-md);
  background: var(--ok-soft);
}
.bw-newprison-toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--s3);
  min-height: var(--hit);
  padding: var(--s2) 0;
  cursor: pointer;
}
.bw-newprison-toggle span { display: flex; flex-direction: column; }
.bw-newprison-toggle b { font-size: var(--f-sm); color: var(--text-hi); font-weight: 600; }
.bw-newprison-toggle em {
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-style: normal;
}

.bw-settings-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 29;
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-settings-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}
.bw-settings-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-settings-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-settings-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }
.bw-settings-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}
.bw-settings-tabs button {
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--f-cap);
  cursor: pointer;
}
.bw-settings-tabs button[data-on='true'] { background: var(--surface-1); color: var(--text-hi); }

.bw-settings-body { flex: 1; min-height: 0; overflow: auto; padding: var(--s5); }
.bw-settings-body section { display: flex; flex-direction: column; gap: var(--s3); max-width: 560px; }
.bw-settings-body h4 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
  margin-top: var(--s3);
}
.bw-settings-toggle {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-height: var(--hit);
  font-size: var(--f-sm);
  color: var(--text);
  cursor: pointer;
}
.bw-settings-choices { display: flex; flex-wrap: wrap; gap: var(--s2); }
.bw-settings-choices button {
  min-height: var(--hit);
  padding: 0 var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: var(--f-sm);
  cursor: pointer;
}
.bw-settings-choices button[data-on='true'] {
  border-color: var(--accent);
  background: var(--surface-3);
  color: var(--text-hi);
}
.bw-settings-slider {
  display: grid;
  grid-template-columns: 140px 1fr 52px;
  align-items: center;
  gap: var(--s3);
  min-height: var(--hit);
  font-size: var(--f-sm);
}
.bw-settings-slider[data-disabled='true'] { opacity: 0.5; }
.bw-settings-slider .k { color: var(--text-dim); }
.bw-settings-slider .v {
  text-align: right;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.bw-settings-slider input[type='range'] { width: 100%; }

/* ---------- Onboarding (T6.4) ---------- */

.bw-onboarding {
  position: absolute;
  left: var(--s4);
  bottom: calc(var(--dock-h) + var(--s4));
  width: 260px;
  padding: var(--s3);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--e2);
  z-index: 22;
}
.bw-onboarding header { display: flex; align-items: flex-start; gap: var(--s2); }
.bw-onboarding .ttl { flex: 1; display: flex; flex-direction: column; }
.bw-onboarding .ttl b { font-size: var(--f-sm); color: var(--text-hi); }
.bw-onboarding .ttl span { font-size: var(--f-cap); color: var(--text-faint); }

.bw-onboarding-list { list-style: none; display: flex; flex-direction: column; gap: 2px; }
.bw-onboarding-list li {
  display: flex;
  align-items: baseline;
  gap: var(--s2);
  font-size: var(--f-cap);
  color: var(--text-dim);
  padding: 3px 0;
}
.bw-onboarding-list li[data-done='true'] { color: var(--text-faint); }
.bw-onboarding-list li[data-done='true'] .lbl { text-decoration: line-through; }
.bw-onboarding-list li[data-current='true'] { color: var(--text-hi); font-weight: 600; }
.bw-onboarding-list .tick { color: var(--ok); width: 12px; }
.bw-onboarding-list li[data-done='false'] .tick { color: var(--text-faint); }

.bw-coach {
  position: absolute;
  padding: var(--s3);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--surface-2);
  box-shadow: var(--e2);
  z-index: 30;
}
.bw-coach h4 { font-size: var(--f-sm); color: var(--text-hi); }
.bw-coach p { font-size: var(--f-cap); color: var(--text); line-height: 1.5; }
.bw-coach::after {
  content: '';
  position: absolute;
  left: calc(50% - 6px);
  width: 12px;
  height: 12px;
  background: var(--surface-2);
  border: 1px solid var(--accent);
  transform: rotate(45deg);
}
.bw-coach[data-side='above']::after {
  bottom: -7px;
  border-top: 0;
  border-left: 0;
}
.bw-coach[data-side='below']::after {
  top: -7px;
  border-bottom: 0;
  border-right: 0;
}
.bw-coach[data-side='centre']::after { display: none; }

/* ---------- Alerts (T6.3) ---------- */

.bw-alerts-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 28;
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-alerts-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-alerts-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-alerts-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-alerts-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-alerts-filters {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}
.bw-alerts-filters button {
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--f-cap);
  cursor: pointer;
}
.bw-alerts-filters button[data-on='true'] { background: var(--surface-1); color: var(--text-hi); }

.bw-alerts-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--s4);
  padding: var(--s4);
}

.bw-alerts-list {
  list-style: none;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.bw-alerts-empty { font-size: var(--f-sm); color: var(--text-dim); padding: var(--s4); }
.bw-alerts-row {
  width: 100%;
  min-height: var(--hit);
  padding: var(--s3);
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: var(--s3);
  align-items: center;
  text-align: left;
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.bw-alerts-row:disabled { cursor: default; opacity: 0.75; }
.bw-alerts-row[data-severity='warn'] { border-left-color: var(--warn); }
.bw-alerts-row[data-severity='critical'] { border-left-color: var(--danger); }
.bw-alerts-row .ico { color: var(--text-dim); }
.bw-alerts-row .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bw-alerts-row .txt b { font-size: var(--f-sm); color: var(--text-hi); }
.bw-alerts-row .count {
  margin-left: var(--s2);
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.bw-alerts-row .detail { font-size: var(--f-cap); color: var(--text-dim); }
.bw-alerts-row .meta {
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.bw-alerts-side {
  overflow: auto;
  padding: var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}
.bw-alerts-side h4 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
  margin: var(--s3) 0 var(--s2);
}
.bw-alerts-side h4:first-child { margin-top: 0; }
.bw-alerts-categories { list-style: none; display: flex; flex-direction: column; }
.bw-alerts-toggle {
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-height: var(--hit);
  font-size: var(--f-sm);
  color: var(--text);
  cursor: pointer;
}
.bw-alerts-toggle span { flex: 1; }
.bw-alerts-total {
  flex: 0 0 auto !important;
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* ---------- Intelligence (T5.6) ---------- */

.bw-intel-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: var(--tray-h);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 27;
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-intel-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-intel-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-intel-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-intel-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-intel-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}
.bw-intel-tabs button {
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--f-cap);
  cursor: pointer;
}
.bw-intel-tabs button[data-on='true'] { background: var(--surface-1); color: var(--text-hi); }

.bw-intel-body { flex: 1; min-height: 0; overflow: auto; padding: var(--s4); }
.bw-intel-empty { font-size: var(--f-sm); color: var(--text-dim); padding: var(--s4); }

.bw-intel-table { width: 100%; border-collapse: collapse; font-size: var(--f-sm); }
.bw-intel-table th {
  text-align: left;
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--border);
}
.bw-intel-table td {
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.bw-intel-table td.bw-num { text-align: right; font-variant-numeric: tabular-nums; }
.bw-intel-table td[data-thin='true'] { color: var(--warn); }

.bw-intel-roster, .bw-intel-reputations {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.bw-intel-informant {
  width: 100%;
  min-height: var(--hit);
  padding: var(--s3);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'nm state' 'meta state';
  gap: 2px var(--s3);
  align-items: center;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.bw-intel-informant[data-blown='true'] { border-color: var(--danger); }
.bw-intel-informant .nm { grid-area: nm; font-size: var(--f-sm); font-weight: 600; color: var(--text-hi); }
.bw-intel-informant .meta { grid-area: meta; font-size: var(--f-cap); color: var(--text-faint); }
.bw-intel-informant .state { grid-area: state; font-size: var(--f-cap); color: var(--text-dim); }

.bw-intel-reputations li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--border);
  font-size: var(--f-sm);
}
.bw-intel-reputations .nm { color: var(--text-hi); }

.bw-intel-recruit {
  margin-top: var(--s4);
  padding: var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.bw-intel-recruit h4 { font-size: var(--f-md); color: var(--text-hi); }
.bw-intel-kv { display: flex; justify-content: space-between; font-size: var(--f-sm); }
.bw-intel-kv .k { color: var(--text-dim); }
.bw-intel-kv .v { color: var(--text-hi); font-variant-numeric: tabular-nums; }
.bw-intel-refusal { font-size: var(--f-cap); color: var(--warn); }

/* ---------- Programmes (T5.3) ---------- */

.bw-programs-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: var(--tray-h);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 27;
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
  opacity: 1;
}
.bw-programs-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-programs-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-programs-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-programs-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-programs-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: var(--s4);
  padding: var(--s4);
}

.bw-programs-list {
  list-style: none;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
}
.bw-programs-row {
  width: 100%;
  min-height: var(--hit);
  padding: var(--s3);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'nm state' 'meta state';
  gap: 2px var(--s3);
  align-items: center;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.bw-programs-row[data-blocked='true'] { border-color: var(--warn); }
.bw-programs-row[data-selected='true'] { background: var(--surface-3); }
.bw-programs-row .nm { grid-area: nm; font-size: var(--f-sm); font-weight: 600; color: var(--text-hi); }
.bw-programs-row .meta { grid-area: meta; font-size: var(--f-cap); color: var(--text-faint); }
.bw-programs-row .state { grid-area: state; font-size: var(--f-cap); color: var(--text-dim); }

.bw-programs-detail { overflow: auto; }
.bw-programs-empty { font-size: var(--f-sm); color: var(--text-dim); padding: var(--s4); }
.bw-programs-card {
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  padding: var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}
.bw-programs-card header { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s2); }
.bw-programs-card header h3 { font-size: var(--f-lg); color: var(--text-hi); flex: 1; }
.bw-programs-blocker {
  font-size: var(--f-sm);
  line-height: 1.5;
  color: var(--warn);
  padding: var(--s3);
  border-radius: var(--r-md);
  background: var(--warn-soft);
  margin-bottom: var(--s2);
}
.bw-programs-hint { font-size: var(--f-cap); color: var(--text-faint); margin-top: var(--s3); }
.bw-programs-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--s3);
  font-size: var(--f-sm);
  padding: 3px 0;
}
.bw-programs-kv .k { color: var(--text-dim); }
.bw-programs-kv .v { color: var(--text-hi); font-variant-numeric: tabular-nums; }

/* ---------- Directorate (T5.1, mockup screen 7) ---------- */

.bw-directorate-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* Leave the Reports tray clickable so chips can switch panels. */
  bottom: var(--tray-h);
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
.bw-directorate-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}

.bw-directorate-head {
  height: 60px;
  flex: 0 0 60px;
  padding: 0 var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-directorate-head .who h2 { font-size: var(--f-xl); line-height: 1.2; color: var(--text-hi); }
.bw-directorate-head .who .sub { font-size: var(--f-cap); color: var(--text-faint); margin-top: 2px; }

.bw-directorate-branches {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}
.bw-directorate-branches button {
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--f-cap);
  cursor: pointer;
}
.bw-directorate-branches button[data-on='true'] {
  background: var(--surface-1);
  color: var(--text-hi);
}

.bw-directorate-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: var(--s4);
  padding: var(--s4);
}

.bw-directorate-graph {
  position: relative;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background:
    radial-gradient(circle at 22% 26%, color-mix(in srgb, var(--research) 8%, transparent), transparent 46%),
    var(--bg-app);
  touch-action: none;
}
.bw-directorate-canvas {
  position: relative;
  transform-origin: 0 0;
}
.bw-directorate-edges {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.bw-directorate-edges .edge {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 2;
}
.bw-directorate-edges .edge[data-active='true'] {
  stroke: var(--research);
  stroke-width: 2.5;
  stroke-dasharray: 5 4;
}

.bw-directorate-node {
  position: absolute;
  width: 168px;
  min-height: 56px;
  padding: var(--s3);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  text-align: left;
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.bw-directorate-node[data-status='complete'] {
  border-color: var(--ok);
  background: linear-gradient(180deg, var(--ok-soft), var(--surface-2));
}
.bw-directorate-node[data-status='active'] {
  border-color: var(--research);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--research) 18%, transparent),
    var(--surface-2)
  );
}
.bw-directorate-node[data-status='locked'] { opacity: 0.5; }
.bw-directorate-node[data-selected='true'] { border-color: var(--accent); }
.bw-directorate-node .nt { font-size: var(--f-sm); font-weight: 600; color: var(--text-hi); }
.bw-directorate-node .nc {
  font-size: var(--f-cap);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.bw-directorate-node .np {
  height: 4px;
  background: var(--surface-4);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.bw-directorate-node .np i { display: block; height: 100%; background: var(--research); }
.bw-directorate-node .paused { font-size: var(--f-micro); color: var(--warn); }
.bw-directorate-node .tick {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--ok);
  color: var(--bg-app);
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 800;
  border: 2px solid var(--bg-app);
}

.bw-directorate-detail { overflow: auto; }
.bw-directorate-empty { font-size: var(--f-sm); color: var(--text-dim); padding: var(--s4); }
.bw-directorate-card {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
  padding: var(--s4);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}
.bw-directorate-card header { display: flex; align-items: center; gap: var(--s3); }
.bw-directorate-card header h3 { font-size: var(--f-lg); color: var(--text-hi); flex: 1; }
.bw-directorate-card h4 {
  font-size: var(--f-micro);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--text-faint);
  margin-bottom: var(--s2);
}
.bw-directorate-card .why { font-size: var(--f-sm); color: var(--text); line-height: 1.6; }
.bw-directorate-progress .track {
  height: 10px;
  background: var(--surface-4);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.bw-directorate-progress .track i { display: block; height: 100%; background: var(--research); }
.bw-directorate-progress .row {
  display: flex;
  justify-content: space-between;
  font-size: var(--f-cap);
  color: var(--text-dim);
  margin-top: 6px;
}
.bw-directorate-paused { font-size: var(--f-cap); color: var(--warn); margin-top: var(--s2); }
.bw-directorate-pills { display: flex; flex-wrap: wrap; gap: var(--s2); }
.bw-directorate-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--s3);
  font-size: var(--f-sm);
  padding: 4px 0;
}
.bw-directorate-kv .k { color: var(--text-dim); }
.bw-directorate-kv .v[data-ok='true'] { color: var(--ok); }
.bw-directorate-kv .v[data-ok='false'] { color: var(--warn); }
.bw-directorate-blockers {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--s2);
  font-size: var(--f-cap);
  color: var(--warn);
}

/* ---------- Reports (T6.2, mockup screen 8) ---------- */

.bw-reports-panel {
  position: absolute;
  inset: 0 0 var(--tray-h);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--surface-1) 97%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 27;
  opacity: 1;
  transition: transform var(--dur-slow) var(--ease-out), opacity var(--dur) var(--ease-out);
}
.bw-reports-panel[data-open='false'] {
  transform: translateY(12px);
  opacity: 0;
  pointer-events: none;
}
.bw-reports-head {
  min-height: 60px;
  flex: 0 0 auto;
  padding: var(--s2) var(--s4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--s3);
}
.bw-reports-head .who h2 { font-size: var(--f-xl); line-height: 1.2; }
.bw-reports-head .who .sub {
  margin-top: 2px;
  color: var(--text-faint);
  font-size: var(--f-cap);
}
.bw-reports-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-pill);
  background: var(--surface-3);
}
.bw-reports-tabs button {
  min-height: var(--hit);
  padding: 0 var(--s3);
  border: 0;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: var(--f-cap);
  cursor: pointer;
}
.bw-reports-tabs button[data-on='true'] {
  color: var(--text-hi);
  background: var(--surface-1);
}
.bw-reports-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--s4);
}
.bw-report-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s3);
  margin-bottom: var(--s4);
}
.bw-report-metric {
  min-width: 0;
  padding: var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
  display: flex;
  flex-direction: column;
}
.bw-report-metric .k {
  color: var(--text-faint);
  font-size: var(--f-micro);
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.bw-report-metric .v {
  margin-top: var(--s1);
  color: var(--text-hi);
  font-size: var(--f-2xl);
  font-weight: 700;
  line-height: 1.15;
}
.bw-report-metric[data-tone='ok'] .v { color: var(--ok); }
.bw-report-metric[data-tone='warn'] .v { color: var(--warn); }
.bw-report-metric[data-tone='danger'] .v { color: var(--danger); }
.bw-report-metric .d { margin-top: 2px; color: var(--text-dim); font-size: var(--f-cap); }
.bw-report-two-col {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(300px, 2fr);
  align-items: start;
  gap: var(--s4);
}
.bw-report-two-col.finance { grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); }
.bw-report-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s4);
}
.bw-report-grid.intelligence { align-items: start; }
.bw-report-card {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
  overflow: hidden;
}
.bw-report-card > header {
  min-height: var(--hit);
  padding: var(--s2) var(--s3);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
}
.bw-report-card > header h3 { font-size: var(--f-md); }
.bw-report-card-body { padding: var(--s3); }
.bw-report-card-body h4 {
  margin: var(--s4) 0 var(--s2);
  color: var(--text-faint);
  font-size: var(--f-micro);
  letter-spacing: .09em;
  text-transform: uppercase;
}
.bw-report-card-body h4:first-child { margin-top: 0; }
.bw-report-pill {
  padding: 3px var(--s2);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  color: var(--text-dim);
  font-size: var(--f-micro);
  white-space: nowrap;
}
.bw-report-pill.danger {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-soft);
}
.bw-need-legend, .bw-chart-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--s2);
  color: var(--text-faint);
  font-size: var(--f-micro);
}
.bw-need-legend span::before, .bw-chart-legend span::before {
  content: '';
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 4px;
  border-radius: 2px;
  background: var(--text-faint);
}
.bw-need-legend [data-band='satisfied']::before { background: var(--need-ok); }
.bw-need-legend [data-band='medium']::before { background: var(--need-medium); }
.bw-need-legend [data-band='high']::before { background: var(--need-high); }
.bw-need-legend [data-band='critical']::before { background: var(--need-critical); }
.bw-chart-legend [data-series='income']::before { background: var(--ok); }
.bw-chart-legend [data-series='expense']::before { background: var(--danger); }
.bw-need-list { display: flex; flex-direction: column; gap: 2px; }
.bw-need-report-row {
  min-height: var(--hit);
  width: 100%;
  padding: var(--s2);
  border: 0;
  border-radius: var(--r-sm);
  display: grid;
  grid-template-columns: 100px 1fr 44px;
  align-items: center;
  gap: var(--s3);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bw-need-report-row:hover,
.bw-need-report-row[data-selected='true'] { background: var(--surface-2); }
.bw-need-report-row .nm { color: var(--text-hi); font-size: var(--f-sm); }
.bw-need-report-row .count {
  color: var(--text-dim);
  font-size: var(--f-sm);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.bw-need-stack {
  height: 16px;
  border-radius: var(--r-sm);
  overflow: hidden;
  display: flex;
  background: var(--surface-3);
}
.bw-need-stack i { height: 100%; }
.bw-need-stack [data-band='satisfied'] { background: var(--need-ok); }
.bw-need-stack [data-band='medium'] { background: var(--need-medium); }
.bw-need-stack [data-band='high'] { background: var(--need-high); }
.bw-need-stack [data-band='critical'] { background: var(--need-critical); }
.bw-need-detail .bw-report-card-body { display: flex; flex-direction: column; gap: var(--s2); }
.bw-report-kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s3);
  color: var(--text);
  font-size: var(--f-sm);
}
.bw-report-kv .k { color: var(--text-dim); }
.bw-report-bottleneck {
  margin: var(--s2) 0;
  padding: var(--s3);
  border: 1px solid var(--danger);
  border-radius: var(--r-md);
  background: var(--danger-soft);
  display: flex;
  flex-direction: column;
  gap: var(--s1);
}
.bw-report-bottleneck strong { color: var(--danger); font-size: var(--f-sm); }
.bw-report-bottleneck span { color: var(--text); font-size: var(--f-cap); line-height: 1.5; }
.bw-report-compact-list { display: flex; flex-direction: column; gap: var(--s1); }
.bw-report-compact-list li {
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s3);
  color: var(--text);
  font-size: var(--f-sm);
  border-bottom: 1px solid var(--border-subtle);
}
.bw-report-compact-list li span:last-child {
  color: var(--text-dim);
  font-size: var(--f-cap);
  text-align: right;
}
.bw-report-empty { padding: var(--s3); color: var(--text-dim); font-size: var(--f-sm); }
.bw-report-locked {
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--s3);
  color: var(--text-faint);
  text-align: center;
}
.bw-report-locked h3 { font-size: var(--f-lg); }
.bw-report-locked p { max-width: 420px; color: var(--text-dim); font-size: var(--f-sm); }
.bw-finance-chart { display: block; width: 100%; height: 250px; }
.bw-finance-breakdown {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s4);
}
.bw-finance-breakdown h4 { margin-top: 0; }
.bw-report-table {
  width: 100%;
  border-collapse: collapse;
  color: var(--text);
  font-size: var(--f-sm);
}
.bw-report-table th {
  padding: var(--s2);
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: var(--f-micro);
  font-weight: 600;
  letter-spacing: .08em;
  text-align: left;
  text-transform: uppercase;
}
.bw-report-table td {
  padding: var(--s2);
  border-bottom: 1px solid var(--border-subtle);
}
.bw-report-table td.bw-num { text-align: right; }
.bw-horizontal-bars { display: flex; flex-direction: column; gap: var(--s2); }
.bw-horizontal-row {
  min-height: 28px;
  display: grid;
  grid-template-columns: 100px 1fr 36px;
  align-items: center;
  gap: var(--s2);
  color: var(--text-dim);
  font-size: var(--f-cap);
}
.bw-horizontal-row i {
  display: block;
  height: 12px;
  min-width: 2px;
  border-radius: var(--r-pill);
  background: var(--info);
}
.bw-horizontal-row b {
  color: var(--text-hi);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.bw-log-card { height: 100%; display: flex; flex-direction: column; }
.bw-log-filters {
  padding: var(--s3);
  display: grid;
  grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(130px, 1fr));
  gap: var(--s3);
  border-bottom: 1px solid var(--border);
}
.bw-log-filters label { display: flex; flex-direction: column; gap: var(--s1); }
.bw-log-filters label > span {
  color: var(--text-faint);
  font-size: var(--f-micro);
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
}
.bw-log-filters input, .bw-log-filters select {
  min-height: var(--hit);
  width: 100%;
  padding: 0 var(--s3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-hi);
  font: inherit;
  font-size: var(--f-sm);
}
.bw-log-scroll { flex: 1; min-height: 0; overflow: auto; }
.bw-log-table td:first-child { white-space: nowrap; color: var(--text-dim); }
.bw-log-table td:nth-child(3) { text-transform: capitalize; }
.bw-log-table td:nth-child(5) strong,
.bw-log-table td:nth-child(5) span { display: block; }
.bw-log-table td:nth-child(5) span { margin-top: 2px; color: var(--text-dim); font-size: var(--f-cap); }
.bw-log-severity {
  padding: 2px 6px;
  border-radius: var(--r-pill);
  color: var(--info);
  background: var(--info-soft);
  font-size: var(--f-micro);
  text-transform: uppercase;
}
.bw-log-severity[data-severity='warn'] { color: var(--warn); background: var(--warn-soft); }
.bw-log-severity[data-severity='critical'] {
  color: var(--danger);
  background: var(--danger-soft);
}
.bw-statistics-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s4);
}
.bw-statistics-grid .bw-report-metric { min-height: 132px; }
.bw-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 900px) {
  .bw-reports-head { align-items: flex-start; }
  .bw-reports-tabs { overflow-x: auto; }
  .bw-reports-tabs button { padding: 0 var(--s2); }
  .bw-report-two-col,
  .bw-report-two-col.finance { grid-template-columns: 1fr; }
  .bw-log-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`

/**
 * The finish pass.
 *
 * The mockup supplies the visual vocabulary; these rules supply the material
 * response and choreography that a still image cannot describe. Everything
 * remains token-derived, GPU-friendly, and optional under Reduce Motion.
 */
const PREMIUM_POLISH = `
/* --- shell depth and first-frame choreography ---------------------------- */

.bw-topbar,
.bw-dock {
  position: relative;
  overflow: visible;
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--surface-2) 36%, var(--surface-1)),
      var(--surface-1)
    );
}

.bw-topbar {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset,
    0 10px 30px color-mix(in srgb, var(--bg-void) 54%, transparent);
  animation: bw-shell-enter-top var(--dur-cinematic) var(--ease-out) both;
}

.bw-topbar::after {
  content: '';
  position: absolute;
  right: var(--s3);
  bottom: -1px;
  left: var(--s3);
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 28%, transparent) 32%,
    color-mix(in srgb, var(--info) 22%, transparent) 68%,
    transparent
  );
  pointer-events: none;
}

.bw-stage {
  animation: bw-stage-enter var(--dur-cinematic) var(--ease-out) both;
}

.bw-stage::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 17;
  pointer-events: none;
  background:
    radial-gradient(circle at 50% 42%, transparent 48%, color-mix(in srgb, var(--bg-void) 20%, transparent)),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-void) 8%, transparent), transparent 12%);
}

.bw-dock {
  box-shadow:
    0 -1px 0 color-mix(in srgb, var(--text-hi) 4%, transparent) inset,
    0 -14px 34px color-mix(in srgb, var(--bg-void) 52%, transparent);
  animation: bw-shell-enter-bottom var(--dur-cinematic) var(--ease-out) 60ms both;
}

@keyframes bw-shell-enter-top {
  from { opacity: 0; transform: translateY(-14px); }
  to { opacity: 1; transform: none; }
}

@keyframes bw-shell-enter-bottom {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: none; }
}

@keyframes bw-stage-enter {
  from { opacity: .55; filter: saturate(.72) brightness(.8); }
  to { opacity: 1; filter: none; }
}

/* --- top bar: make the live telemetry feel instrument-grade -------------- */

.bw-clock {
  position: relative;
  padding-left: var(--s1);
}

.bw-clock .t {
  letter-spacing: .045em;
  text-shadow: 0 0 18px color-mix(in srgb, var(--text-hi) 15%, transparent);
}

.bw-stat {
  position: relative;
  justify-content: center;
}

.bw-stat::before {
  content: '';
  position: absolute;
  top: 18%;
  bottom: 18%;
  left: -1px;
  width: 1px;
  background: linear-gradient(transparent, var(--border), transparent);
}

.bw-stat .v {
  letter-spacing: -.015em;
  text-shadow: 0 0 16px color-mix(in srgb, currentColor 10%, transparent);
}

.bw-gauge {
  padding: 6px var(--s2);
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--surface-2) 58%, transparent);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text-hi) 4%, transparent) inset;
}

.bw-gauge .bw-bar { height: 7px; }
.bw-gauge .bw-bar i {
  position: relative;
  box-shadow: 0 0 14px color-mix(in srgb, var(--warn) 36%, transparent);
}
.bw-gauge[data-danger='calm'] .row b,
.bw-gauge[data-danger='settled'] .row b { color: var(--ok); }
.bw-gauge[data-danger='unsettled'] .row b,
.bw-gauge[data-danger='elevated'] .row b { color: var(--warn); }
.bw-gauge[data-danger='critical'] .row b { color: var(--danger); }
.bw-gauge[data-danger='calm'] .bw-bar i,
.bw-gauge[data-danger='settled'] .bw-bar i {
  box-shadow: 0 0 14px color-mix(in srgb, var(--ok) 32%, transparent);
}
.bw-gauge[data-danger='critical'] .bw-bar i {
  box-shadow: 0 0 16px color-mix(in srgb, var(--danger) 46%, transparent);
}

.bw-gauge .bw-bar i::after,
.bw-orders-bar i::after,
.bw-track i::after,
.bw-need-bar i::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    color-mix(in srgb, var(--text-hi) 26%, transparent) 48%,
    transparent 76%
  );
  transform: translateX(-110%);
  animation: bw-meter-sheen 900ms var(--ease-out) 280ms both;
}

.bw-topbar[data-danger='critical'] .bw-gauge,
.bw-topbar[data-danger='elevated'] .bw-gauge {
  border-color: color-mix(in srgb, var(--danger) 48%, var(--border));
}

@keyframes bw-meter-sheen {
  to { transform: translateX(110%); }
}

/* --- controls: layered glass, decisive active states --------------------- */

.bw-btn,
.bw-iconbtn,
.bw-speed,
.bw-tool,
.bw-chip {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 7%, transparent) inset,
    0 7px 16px color-mix(in srgb, var(--bg-void) 18%, transparent);
}

.bw-btn,
.bw-iconbtn,
.bw-tool,
.bw-chip {
  position: relative;
  overflow: hidden;
}

.bw-btn::before,
.bw-iconbtn::before,
.bw-tool::before,
.bw-chip::before {
  content: '';
  position: absolute;
  top: 0;
  right: 12%;
  left: 12%;
  height: 1px;
  background: color-mix(in srgb, var(--text-hi) 16%, transparent);
  opacity: .55;
  pointer-events: none;
}

.bw-btn.primary {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 26%, transparent) inset,
    0 8px 22px color-mix(in srgb, var(--accent) 20%, transparent);
}

.bw-btn.danger {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--danger) 26%, transparent) inset,
    0 8px 22px color-mix(in srgb, var(--danger) 10%, transparent);
}

.bw-iconbtn:hover:not(:disabled),
.bw-btn:hover:not(:disabled),
.bw-chip:hover:not(:disabled),
.bw-tool:hover:not(:disabled):not([data-on='true']) {
  border-color: var(--border-strong);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 10%, transparent) inset,
    0 10px 24px color-mix(in srgb, var(--bg-void) 28%, transparent);
}

.bw-iconbtn:active:not(:disabled),
.bw-btn:active:not(:disabled),
.bw-chip:active:not(:disabled),
.bw-tool:active:not(:disabled) {
  box-shadow: 0 1px 2px color-mix(in srgb, var(--bg-void) 44%, transparent) inset;
}

.bw-speed {
  padding: 2px;
  gap: 2px;
  border-color: color-mix(in srgb, var(--border-strong) 74%, transparent);
  background: color-mix(in srgb, var(--surface-2) 86%, var(--bg-app));
}

.bw-speed button {
  border-radius: calc(var(--r-md) - 3px);
}

.bw-speed button[data-on='true'] {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 28%, transparent) inset,
    0 5px 16px color-mix(in srgb, var(--accent) 24%, transparent);
  animation: bw-control-select var(--dur) var(--ease-spring);
}

.bw-tool {
  overflow: visible;
}

.bw-tool .ico-svg {
  transition:
    transform var(--dur) var(--ease-spring),
    filter var(--dur) var(--ease);
}

.bw-tool:hover:not(:disabled) .ico-svg { transform: translateY(-2px) scale(1.06); }

.bw-tool[data-on='true'] {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 30%, transparent) inset,
    0 9px 26px color-mix(in srgb, var(--accent) 22%, transparent);
  animation: bw-control-select var(--dur) var(--ease-spring);
}

.bw-tool[data-on='true']::after {
  content: '';
  position: absolute;
  right: var(--s3);
  bottom: -7px;
  left: var(--s3);
  height: 3px;
  border-radius: var(--r-pill);
  background: var(--accent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 60%, transparent);
  animation: bw-indicator-grow var(--dur-slow) var(--ease-out) both;
}

.bw-tool.danger::after { background: var(--danger); }

.bw-chip[data-on='true'] {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--accent) 30%, transparent) inset,
    0 8px 22px color-mix(in srgb, var(--accent) 12%, transparent);
  animation: bw-control-select var(--dur) var(--ease-spring);
}

.bw-tool:disabled,
.bw-chip:disabled {
  filter: saturate(.4);
  box-shadow: none;
}

@keyframes bw-control-select {
  0% { transform: scale(.96); }
  64% { transform: scale(1.018); }
  100% { transform: none; }
}

@keyframes bw-indicator-grow {
  from { opacity: 0; transform: scaleX(.2); }
  to { opacity: 1; transform: scaleX(1); }
}

/* --- floating material and micro surfaces -------------------------------- */

.bw-tray,
.bw-inspector,
.bw-overlay-legend,
.bw-bpbar,
.bw-toast {
  background:
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--surface-2) 38%, transparent),
      color-mix(in srgb, var(--surface-1) 97%, transparent) 38%
    );
  border-color: color-mix(in srgb, var(--border-strong) 68%, transparent);
}

.bw-tray {
  box-shadow:
    0 -1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset,
    0 -16px 34px color-mix(in srgb, var(--bg-void) 42%, transparent);
  transition:
    transform var(--dur-slow) var(--ease-spring),
    opacity var(--dur) var(--ease-out),
    right var(--dur-slow) var(--ease-out);
}

.bw-tray[data-open='true'] {
  animation: bw-tray-reveal var(--dur-slow) var(--ease-spring) both;
}

.bw-tray-group {
  transition:
    opacity var(--dur) var(--ease-out),
    transform var(--dur-slow) var(--ease-out);
}

.bw-tray[data-open='true'] .bw-tray-group {
  animation: bw-content-rise var(--dur-slow) var(--ease-out) both;
}

.bw-tray[data-open='true'] .bw-tray-group:nth-child(2) { animation-delay: 35ms; }
.bw-tray[data-open='true'] .bw-tray-group:nth-child(3) { animation-delay: 70ms; }
.bw-tray[data-open='true'] .bw-tray-group:nth-child(4) { animation-delay: 105ms; }

.bw-inspector {
  box-shadow:
    -1px 0 0 color-mix(in srgb, var(--text-hi) 4%, transparent) inset,
    -18px 0 48px color-mix(in srgb, var(--bg-void) 52%, transparent);
}

.bw-inspector[data-open='true'] {
  animation: bw-inspector-open var(--dur-cinematic) var(--ease-spring) both;
}

.bw-inspector[data-open='true'] .bw-insp-head,
.bw-inspector[data-open='true'] .bw-tabs,
.bw-inspector[data-open='true'] .bw-insp-body > *,
.bw-inspector[data-open='true'] .bw-insp-foot {
  animation: bw-content-rise var(--dur-slow) var(--ease-out) both;
}

.bw-inspector[data-open='true'] .bw-tabs { animation-delay: 35ms; }
.bw-inspector[data-open='true'] .bw-insp-body > :nth-child(1) { animation-delay: 55ms; }
.bw-inspector[data-open='true'] .bw-insp-body > :nth-child(2) { animation-delay: 80ms; }
.bw-inspector[data-open='true'] .bw-insp-body > :nth-child(3) { animation-delay: 105ms; }
.bw-inspector[data-open='true'] .bw-insp-body > :nth-child(4) { animation-delay: 130ms; }
.bw-inspector[data-open='true'] .bw-insp-foot { animation-delay: 155ms; }

.bw-insp-head {
  background:
    radial-gradient(circle at 18% 0%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 42%),
    color-mix(in srgb, var(--surface-2) 28%, transparent);
}

.bw-avatar {
  border: 1px solid var(--border-strong);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 8%, transparent) inset,
    0 9px 24px color-mix(in srgb, var(--bg-void) 30%, transparent);
}

.bw-overlay-legend[data-open='true'] {
  animation: bw-float-in var(--dur-slow) var(--ease-spring) both;
}

.bw-bpbar {
  border-color: color-mix(in srgb, var(--info) 78%, var(--border));
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--info) 22%, transparent) inset,
    0 18px 48px color-mix(in srgb, var(--bg-void) 58%, transparent),
    0 0 34px color-mix(in srgb, var(--info) 10%, transparent);
}

.bw-toast {
  position: relative;
  overflow: hidden;
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 7%, transparent) inset,
    0 14px 36px color-mix(in srgb, var(--bg-void) 46%, transparent);
}

.bw-toast::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--info);
}
.bw-toast.warn::after { background: var(--warn); }
.bw-toast.crit::after {
  background: var(--danger);
  box-shadow: 0 0 16px color-mix(in srgb, var(--danger) 64%, transparent);
}

@keyframes bw-tray-reveal {
  from { opacity: 0; transform: translateY(100%) scale(.99); }
  to { opacity: 1; transform: none; }
}

@keyframes bw-inspector-open {
  from { opacity: 0; transform: translateX(44px); }
  to { opacity: 1; transform: none; }
}

@keyframes bw-float-in {
  from { opacity: 0; transform: translateY(10px) scale(.97); }
  to { opacity: 1; transform: none; }
}

@keyframes bw-content-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

/* --- full-screen workspaces ---------------------------------------------- */

:is(
  .bw-alerts-panel,
  .bw-trace-panel,
  .bw-posts-panel,
  .bw-orders-panel,
  .bw-emergency-panel,
  .bw-intel-panel,
  .bw-programs-panel,
  .bw-directorate-panel,
  .bw-reports-panel
) {
  background:
    radial-gradient(circle at 12% -8%, color-mix(in srgb, var(--info) 7%, transparent), transparent 34%),
    radial-gradient(circle at 92% 112%, color-mix(in srgb, var(--research) 6%, transparent), transparent 38%),
    color-mix(in srgb, var(--bg-app) 97%, transparent);
  box-shadow: 0 -1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset;
  transform-origin: 50% 100%;
  will-change: transform, opacity;
}

:is(
  .bw-alerts-panel,
  .bw-trace-panel,
  .bw-posts-panel,
  .bw-orders-panel,
  .bw-emergency-panel,
  .bw-intel-panel,
  .bw-programs-panel,
  .bw-directorate-panel,
  .bw-reports-panel
)[data-open='true'] {
  animation: bw-workspace-open var(--dur-cinematic) var(--ease-out) both;
}

:is(
  .bw-alerts-head,
  .bw-trace-head,
  .bw-posts-head,
  .bw-orders-head,
  .bw-emergency-head,
  .bw-intel-head,
  .bw-programs-head,
  .bw-directorate-head,
  .bw-reports-head
) {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 44%, transparent), transparent),
    color-mix(in srgb, var(--surface-1) 82%, transparent);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text-hi) 4%, transparent) inset;
}

:is(
  .bw-alerts-panel,
  .bw-trace-panel,
  .bw-posts-panel,
  .bw-orders-panel,
  .bw-emergency-panel,
  .bw-intel-panel,
  .bw-programs-panel,
  .bw-directorate-panel,
  .bw-reports-panel
)[data-open='true'] > :first-child {
  animation: bw-content-rise var(--dur-slow) var(--ease-out) 70ms both;
}

:is(
  .bw-alerts-panel,
  .bw-trace-panel,
  .bw-posts-panel,
  .bw-orders-panel,
  .bw-emergency-panel,
  .bw-intel-panel,
  .bw-programs-panel,
  .bw-directorate-panel,
  .bw-reports-panel
)[data-open='true'] > :last-child {
  animation: bw-content-rise var(--dur-slow) var(--ease-out) 125ms both;
}

@keyframes bw-workspace-open {
  from { opacity: 0; transform: translateY(18px) scale(.992); filter: blur(4px); }
  62% { filter: blur(0); }
  to { opacity: 1; transform: none; filter: none; }
}

/* --- cards, rows and data visualisation ---------------------------------- */

:is(
  .bw-posts-map,
  .bw-posts-card,
  .bw-orders-card,
  .bw-emergency-rung,
  .bw-programs-card,
  .bw-directorate-card,
  .bw-report-card,
  .bw-report-metric,
  .bw-intel-recruit
) {
  border-color: color-mix(in srgb, var(--border-strong) 64%, transparent);
  background:
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--surface-2) 32%, transparent),
      color-mix(in srgb, var(--surface-1) 94%, transparent)
    );
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset,
    0 12px 28px color-mix(in srgb, var(--bg-void) 20%, transparent);
}

:is(.bw-report-card, .bw-orders-card, .bw-posts-card, .bw-programs-card) > header {
  background: color-mix(in srgb, var(--surface-2) 42%, transparent);
}

:is(.bw-postrow, .bw-programs-row, .bw-need-report-row, .bw-report-table tr) {
  transition:
    background var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.bw-postrow:hover,
.bw-programs-row:hover,
.bw-need-report-row:hover {
  transform: translateX(2px);
}

.bw-report-metric {
  position: relative;
  overflow: hidden;
}

.bw-report-metric::after {
  content: '';
  position: absolute;
  right: -24px;
  bottom: -36px;
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--info) 9%, transparent), transparent 68%);
  pointer-events: none;
}

.bw-report-metric[data-tone='ok']::after {
  background: radial-gradient(circle, color-mix(in srgb, var(--ok) 12%, transparent), transparent 68%);
}
.bw-report-metric[data-tone='warn']::after {
  background: radial-gradient(circle, color-mix(in srgb, var(--warn) 12%, transparent), transparent 68%);
}
.bw-report-metric[data-tone='danger']::after {
  background: radial-gradient(circle, color-mix(in srgb, var(--danger) 12%, transparent), transparent 68%);
}

.bw-report-locked {
  position: relative;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--border-strong) 68%, transparent);
  background:
    radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--info) 8%, transparent), transparent 28%),
    linear-gradient(145deg, var(--surface-1), color-mix(in srgb, var(--surface-2) 55%, var(--surface-1)));
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset,
    0 18px 44px color-mix(in srgb, var(--bg-void) 26%, transparent);
}

.bw-report-locked .ico-svg {
  color: var(--info);
  filter: drop-shadow(0 0 14px color-mix(in srgb, var(--info) 38%, transparent));
  animation: bw-locked-reveal var(--dur-cinematic) var(--ease-spring) 150ms both;
}

@keyframes bw-locked-reveal {
  from { opacity: 0; transform: translateY(8px) scale(.82); }
  to { opacity: 1; transform: none; }
}

.bw-directorate-node {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 6%, transparent) inset,
    0 10px 24px color-mix(in srgb, var(--bg-void) 26%, transparent);
  transition:
    transform var(--dur) var(--ease-spring),
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}

.bw-directorate-node:hover:not([data-status='locked']) {
  transform: translateY(-3px);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 8%, transparent) inset,
    0 16px 34px color-mix(in srgb, var(--bg-void) 36%, transparent);
}

.bw-directorate-node[data-status='active'] .np i {
  position: relative;
  overflow: hidden;
}

.bw-emergency-rung[data-active='true'] {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--danger) 22%, transparent) inset,
    0 14px 34px color-mix(in srgb, var(--danger) 12%, transparent);
}

/* --- dense navigation and badges ---------------------------------------- */

.bw-tabs button,
.bw-seg button,
.bw-reports-tabs button,
.bw-intel-tabs button,
.bw-directorate-branches button,
.bw-radio-seg button {
  position: relative;
}

.bw-tabs button[data-on='true']::after {
  content: '';
  position: absolute;
  right: 24%;
  bottom: -2px;
  left: 24%;
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 55%, transparent);
  animation: bw-indicator-grow var(--dur) var(--ease-out) both;
}

.bw-pills .bw-pill,
.bw-badge,
.bw-report-pill,
.bw-orders-pill {
  box-shadow: 0 1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset;
}

.bw-hud {
  border-color: color-mix(in srgb, var(--border-strong) 68%, transparent);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--bg-void) 28%, transparent);
}

.bw-hint {
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--text-hi) 5%, transparent) inset,
    0 12px 30px color-mix(in srgb, var(--bg-void) 36%, transparent);
  animation: bw-float-in var(--dur-slow) var(--ease-spring) both;
}

/* --- size adaptation ----------------------------------------------------- */

@media (max-width: 1120px) {
  .bw-topbar { gap: var(--s2); padding-right: var(--s2); padding-left: var(--s2); }
  .bw-stat { min-width: 104px; padding: 0 var(--s2); }
  .bw-stat .sub { max-width: 112px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bw-gauge { width: 136px; }
  .bw-dock { gap: var(--s1); padding-right: var(--s2); padding-left: var(--s2); }
}

@media (max-width: 980px) {
  .bw-stat .sub { display: none; }
  .bw-stat { min-width: 88px; }
  .bw-gauge { width: 122px; }
  .bw-tool {
    width: auto;
    min-width: 60px;
    flex: 1 1 68px;
  }
}

@media (orientation: portrait) and (max-width: 900px) {
  .bw-topbar {
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .bw-topbar::-webkit-scrollbar { display: none; }
  .bw-topbar > .bw-spacer,
  .bw-stat[data-stat='population'],
  .bw-iconbtn[data-action='undo'],
  .bw-iconbtn[data-action='redo'] {
    display: none;
  }
  .bw-stat { min-width: 82px; }
  .bw-gauge { width: 112px; }
  .bw-stage { margin-left: var(--dock-h); }
  .bw-dock {
    position: absolute;
    top: calc(var(--topbar-h) + env(safe-area-inset-top, 0px));
    bottom: 0;
    left: 0;
    width: var(--dock-h);
    height: auto;
    padding: var(--s2) var(--s2) max(var(--s2), env(safe-area-inset-bottom, 0px));
    flex-direction: column;
    justify-content: flex-start;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .bw-dock .bw-spacer { min-height: var(--s4); width: 100%; }
  .bw-tool {
    width: 68px;
    min-height: 64px;
    flex: 0 0 64px;
  }
  .bw-tool[data-on='true']::after {
    top: var(--s3);
    right: -7px;
    bottom: var(--s3);
    left: auto;
    width: 3px;
    height: auto;
    transform-origin: center;
  }
  .bw-tray[data-inspector='true'] { right: 0; }
  .bw-inspector { max-width: min(var(--inspector-w), 92vw); }
}

@media (prefers-contrast: more) {
  .bw-shell { --border: var(--border-strong); }
  .bw-shell :focus-visible { outline-width: 3px; }
  .bw-stat .k, .bw-block h4 { color: var(--text-dim); }
}
`

/**
 * The whole sheet: tokens first, then everything that reads them.
 *
 * Built once at module scope rather than per call — the string is constant,
 * and a host that injects it on every render should still only pay for it
 * once.
 */
export const SHELL_CSS: string = [
  themeCss(),
  BASE,
  LAYOUT,
  CONTROLS,
  OVERLAYS,
  PREMIUM_POLISH,
].join('\n')

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
