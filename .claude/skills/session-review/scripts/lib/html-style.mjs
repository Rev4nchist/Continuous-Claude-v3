// Page CSS for render-html.mjs. A fixed string: no review text reaches it.
// Fonts: display Bricolage Grotesque (headings, big numbers), body IBM Plex Sans, data IBM Plex Mono.

export const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..700&amp;family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap';

const COLS = Array.from({ length: 12 }, (_, i) => `.n${i + 1} { --n: ${i + 1}; }`).join('\n');

export const STYLE = `/* Layout: one .wrap column; sections stack with gap; wide blocks scroll inside .scroll. Tokens first, light then dark. */
:root {
  color-scheme: light;
  --bg: #f3f6fa;
  --surface: #ffffff;
  --surface-2: #e8eef5;
  --line: #cfdae6;
  --fg: #132033;
  --fg-muted: #46586d;
  --accent: #0f766e;
  --accent-fg: #0a4b46;
  --accent-bg: #d3efeb;
  --focus: #0b5fd1;
  --good: #1b7f4c;
  --good-fg: #0e5030;
  --good-bg: #d6f1e1;
  --warn: #b45309;
  --warn-fg: #74390a;
  --warn-bg: #fbe8c2;
  --crit: #b42318;
  --crit-fg: #85160e;
  --crit-bg: #fcdcd8;
  --chip-bg: #e3eaf2;
  --chip-fg: #1b2c40;
  --hm1-bg: #b42318;
  --hm1-fg: #ffffff;
  --hm2-bg: #f0a45d;
  --hm2-fg: #331a00;
  --hm3-bg: #ebe2a9;
  --hm3-fg: #2b2600;
  --hm4-bg: #8ccfc1;
  --hm4-fg: #052b26;
  --hm5-bg: #0f766e;
  --hm5-fg: #ffffff;
  --na-a: #e8eef5;
  --na-b: #dae3ed;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0d1520;
    --surface: #141f2e;
    --surface-2: #1b2a3d;
    --line: #2b3e54;
    --fg: #e5edf6;
    --fg-muted: #a1b4c8;
    --accent: #4fd1c1;
    --accent-fg: #93eadf;
    --accent-bg: #10393a;
    --focus: #7db4ff;
    --good: #4cc383;
    --good-fg: #9be8bd;
    --good-bg: #123a26;
    --warn: #e8a13d;
    --warn-fg: #f6c877;
    --warn-bg: #3f2b09;
    --crit: #f06a5c;
    --crit-fg: #ffb2a9;
    --crit-bg: #4b1814;
    --chip-bg: #1f3148;
    --chip-fg: #d3e0ee;
    --hm1-bg: #9f2418;
    --hm1-fg: #ffffff;
    --hm2-bg: #d9822b;
    --hm2-fg: #1f1000;
    --hm3-bg: #b9b06a;
    --hm3-fg: #1c1900;
    --hm4-bg: #3aa596;
    --hm4-fg: #021a17;
    --hm5-bg: #2dd4bf;
    --hm5-fg: #021f1b;
    --na-a: #1b2a3d;
    --na-b: #24374e;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0d1520;
  --surface: #141f2e;
  --surface-2: #1b2a3d;
  --line: #2b3e54;
  --fg: #e5edf6;
  --fg-muted: #a1b4c8;
  --accent: #4fd1c1;
  --accent-fg: #93eadf;
  --accent-bg: #10393a;
  --focus: #7db4ff;
  --good: #4cc383;
  --good-fg: #9be8bd;
  --good-bg: #123a26;
  --warn: #e8a13d;
  --warn-fg: #f6c877;
  --warn-bg: #3f2b09;
  --crit: #f06a5c;
  --crit-fg: #ffb2a9;
  --crit-bg: #4b1814;
  --chip-bg: #1f3148;
  --chip-fg: #d3e0ee;
  --hm1-bg: #9f2418;
  --hm1-fg: #ffffff;
  --hm2-bg: #d9822b;
  --hm2-fg: #1f1000;
  --hm3-bg: #b9b06a;
  --hm3-fg: #1c1900;
  --hm4-bg: #3aa596;
  --hm4-fg: #021a17;
  --hm5-bg: #2dd4bf;
  --hm5-fg: #021f1b;
  --na-a: #1b2a3d;
  --na-b: #24374e;
}

* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); margin: 0; font-family: "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", sans-serif; font-size: 15px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.wrap { max-width: 1080px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 56px; display: flex; flex-direction: column; gap: 32px; }
.wrap > * { min-width: 0; }
h1, h2, h3, h4, p { margin: 0; text-wrap: balance; }
h1, h2, .big, .rank { font-family: "Bricolage Grotesque", "Avenir Next", "Segoe UI", system-ui, sans-serif; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: clamp(1.7rem, 5vw, 2.4rem); line-height: 1.1; }
h2 { font-size: 1.35rem; line-height: 1.2; }
h3 { font-size: 1rem; font-weight: 600; line-height: 1.3; }
code, .mono, .chip, .tag, .pill, .eyebrow { font-family: "IBM Plex Mono", ui-monospace, "SF Mono", Consolas, "Liberation Mono", monospace; }
code { font-size: 0.86em; overflow-wrap: anywhere; }
.muted { color: var(--fg-muted); }
.sec { display: flex; flex-direction: column; gap: 14px; }
.sec > * { min-width: 0; }
.lead { color: var(--fg-muted); max-width: 70ch; }
a { color: var(--accent-fg); text-underline-offset: 2px; }
a:focus-visible, summary:focus-visible, .scroll:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }

.eyebrow { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-muted); }
.band { display: flex; flex-direction: column; gap: 16px; }
.example { background: var(--warn-bg); color: var(--warn-fg); padding: 8px 12px; border-radius: 8px; font-weight: 600; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stat .big { font-size: 1.75rem; line-height: 1.1; }
.stat .label { font-size: 0.78rem; color: var(--fg-muted); }
.stat .sub { font-size: 0.8rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.finding { background: var(--accent-bg); color: var(--accent-fg); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.finding .eyebrow { color: var(--accent-fg); }
.finding p { font-size: 1.05rem; font-weight: 500; max-width: 70ch; }

.scroll { overflow-x: auto; max-width: 100%; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.hmbox { min-width: 520px; padding: 10px; display: flex; flex-direction: column; gap: 4px; }
.hm-row { display: grid; grid-template-columns: minmax(150px, 1.6fr) repeat(var(--n), minmax(64px, 1fr)); gap: 4px; align-items: stretch; }
.hm-row > * { min-width: 0; }
${COLS}
.hm-head > div { font-size: 0.75rem; color: var(--fg-muted); padding: 2px 4px; font-family: "IBM Plex Mono", ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
.hm-head .flag { display: block; color: var(--warn-fg); }
.hm-label { padding: 8px 4px; font-size: 0.88rem; overflow-wrap: anywhere; }
.hm { border-radius: 6px; padding: 8px 4px; text-align: center; font-family: "IBM Plex Mono", ui-monospace, Consolas, monospace; font-weight: 500; font-size: 0.9rem; }
.hm-1 { background: var(--hm1-bg); color: var(--hm1-fg); }
.hm-2 { background: var(--hm2-bg); color: var(--hm2-fg); }
.hm-3 { background: var(--hm3-bg); color: var(--hm3-fg); }
.hm-4 { background: var(--hm4-bg); color: var(--hm4-fg); }
.hm-5 { background: var(--hm5-bg); color: var(--hm5-fg); }
.hm-na { background: repeating-linear-gradient(135deg, var(--na-a) 0 6px, var(--na-b) 6px 12px); color: var(--fg-muted); font-weight: 400; }
.hm-mean-row { border-top: 1px solid var(--line); padding-top: 6px; margin-top: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 0.8rem; color: var(--fg-muted); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { display: inline-block; width: 16px; height: 16px; border-radius: 4px; }

.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; min-width: 0; }
.imp { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 14px; }
.imp .rank { font-size: 1.9rem; line-height: 1; color: var(--accent); grid-row: span 2; }
.imp-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.row { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; min-width: 0; }
.chip, .tag, .pill { display: inline-block; font-size: 0.76rem; line-height: 1.2; padding: 3px 8px; border-radius: 999px; max-width: 100%; overflow-wrap: anywhere; }
.chip { background: var(--chip-bg); color: var(--chip-fg); }
.tag { background: transparent; color: var(--fg-muted); border: 1px solid var(--line); border-radius: 6px; }
.pill { font-weight: 500; }
.pill.good { background: var(--good-bg); color: var(--good-fg); }
.pill.warn { background: var(--warn-bg); color: var(--warn-fg); }
.pill.crit { background: var(--crit-bg); color: var(--crit-fg); }
.pill.idle { background: var(--surface-2); color: var(--fg-muted); }
.pill.info { background: var(--accent-bg); color: var(--accent-fg); }
.facts { font-size: 0.85rem; color: var(--fg-muted); }

.strip { list-style: none; margin: 0; padding: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.station { min-width: 0; background: var(--surface-2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.station.rail { border: 1px dashed var(--line); background: transparent; }
.station .num { font-family: "IBM Plex Mono", ui-monospace, Consolas, monospace; font-size: 0.75rem; color: var(--fg-muted); }
.station .sig { font-size: 0.82rem; color: var(--fg-muted); overflow-wrap: anywhere; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
.two > * { min-width: 0; }
.plain { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }

details.sess { padding: 0; }
details.sess > summary { cursor: pointer; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; list-style-position: inside; }
details.sess > summary > * { min-width: 0; }
.sess-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.kv { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.kv dt { color: var(--fg-muted); font-size: 0.85rem; }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.notes li { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.notes li > span:last-child { min-width: 0; overflow-wrap: anywhere; }

table { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 0.9rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { font-size: 0.78rem; color: var(--fg-muted); font-weight: 500; }
.spark { width: 100%; max-width: 560px; height: auto; display: block; }
.sp-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.sp-dot { fill: var(--surface); stroke: var(--accent); stroke-width: 1.5; }
.sp-end { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.sp-txt { fill: var(--fg-muted); font-family: "IBM Plex Mono", ui-monospace, Consolas, monospace; font-size: 10px; }
.sp-txt-end { fill: var(--fg); font-weight: 600; }
.foot { font-size: 0.8rem; color: var(--fg-muted); }

@media (max-width: 520px) {
  .kv { grid-template-columns: minmax(0, 1fr); }
  .imp { grid-template-columns: minmax(0, 1fr); }
  .imp .rank { grid-row: auto; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}`;
