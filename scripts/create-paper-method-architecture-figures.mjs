import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'outputs', 'paper-figures');

const C = {
  bg: '#fbfcfd',
  ink: '#17262f',
  muted: '#5f707a',
  grid: '#d7e2e7',
  blue: '#dcecff',
  blueStroke: '#2878b5',
  orange: '#ffe2c6',
  orangeStroke: '#c96d22',
  green: '#e0f3df',
  greenStroke: '#4a8f4d',
  yellow: '#fff0b8',
  yellowStroke: '#c29a18',
  purple: '#eadfff',
  purpleStroke: '#7760b8',
  teal: '#d9f1f1',
  tealStroke: '#176b72',
  red: '#ffe1df',
  redStroke: '#c15b3e',
  light: '#eef4f6',
  white: '#ffffff'
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[ch]);
}

function text(x, y, value, size = 28, color = C.ink, anchor = 'middle', weight = 600, style = '') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" ${style}>${esc(value)}</text>`;
}

function wrapText(x, y, lines, size = 24, color = C.ink, anchor = 'middle', gap = 30, weight = 500) {
  return lines.map((line, i) => text(x, y + i * gap, line, size, color, anchor, weight)).join('\n');
}

function rect(x, y, w, h, fill, stroke, radius = 16, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="3" ${extra}/>`;
}

function dashedRect(x, y, w, h, fill, stroke, radius = 20) {
  return rect(x, y, w, h, fill, stroke, radius, 'stroke-dasharray="14 10"');
}

function arrow(x1, y1, x2, y2, color = C.ink, width = 3, dashed = false) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" marker-end="url(#arrow)" ${dashed ? 'stroke-dasharray="10 8"' : ''}/>`;
}

function smallBox(x, y, w, h, label, fill = C.white, stroke = C.grid, size = 22) {
  return `${rect(x, y, w, h, fill, stroke, 12)}
  ${wrapText(x + w / 2, y + h / 2 - (Array.isArray(label) ? (label.length - 1) * 13 : 0) + 8, Array.isArray(label) ? label : [label], size, C.ink, 'middle', 26, 500)}`;
}

function defs() {
  return `<defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
      <path d="M 0 0 L 8 4 L 0 8 z" fill="${C.ink}"/>
    </marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="7" stdDeviation="7" flood-color="#1a2a33" flood-opacity="0.14"/>
    </filter>
    <linearGradient id="softBlue" x1="0" x2="1">
      <stop offset="0%" stop-color="#eef6ff"/>
      <stop offset="100%" stop-color="#d9ecff"/>
    </linearGradient>
    <linearGradient id="softTeal" x1="0" x2="1">
      <stop offset="0%" stop-color="#eefafa"/>
      <stop offset="100%" stop-color="#d9f1f1"/>
    </linearGradient>
  </defs>`;
}

function frame(title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1100" viewBox="0 0 1800 1100">
  ${defs()}
  <rect width="1800" height="1100" fill="${C.bg}"/>
  ${text(900, 70, title, 44, C.ink, 'middle', 700)}
  ${text(900, 112, subtitle, 24, C.muted, 'middle', 400)}
  ${body}
</svg>`;
}

function robotIcon(x, y, scale = 1, color = C.tealStroke) {
  const s = scale;
  return `<g transform="translate(${x},${y}) scale(${s})" stroke="${color}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-42" y="-26" width="84" height="64" rx="14" fill="#f8fbfc"/>
    <rect x="-22" y="-8" width="44" height="22" rx="6" fill="#e0f3ff"/>
    <circle cx="-18" cy="4" r="4" fill="${color}" stroke="none"/>
    <circle cx="18" cy="4" r="4" fill="${color}" stroke="none"/>
    <line x1="-24" y1="54" x2="24" y2="54"/>
    <line x1="-18" y1="38" x2="-18" y2="54"/>
    <line x1="18" y1="38" x2="18" y2="54"/>
    <line x1="-42" y1="-4" x2="-64" y2="16"/>
    <line x1="42" y1="-4" x2="64" y2="16"/>
    <circle cx="0" cy="-42" r="8" fill="${color}" stroke="none"/>
    <line x1="0" y1="-34" x2="0" y2="-26"/>
  </g>`;
}

function phoneIcon(x, y, scale = 1) {
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${C.blueStroke}" stroke-width="5" fill="none" stroke-linejoin="round">
    <rect x="-30" y="-58" width="60" height="116" rx="14" fill="#f8fbfc"/>
    <line x1="-13" y1="42" x2="13" y2="42"/>
    <rect x="-18" y="-28" width="36" height="36" rx="5" fill="#dcecff"/>
  </g>`;
}

function imageIcon(x, y, scale = 1) {
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${C.greenStroke}" stroke-width="5" fill="none" stroke-linejoin="round">
    <rect x="-58" y="-42" width="116" height="84" rx="10" fill="#f9fffa"/>
    <circle cx="-22" cy="-12" r="9" fill="#ffe2c6" stroke="${C.orangeStroke}"/>
    <path d="M -48 30 L -12 0 L 12 20 L 34 -10 L 50 30 Z" fill="#e0f3df"/>
  </g>`;
}

function micIcon(x, y, scale = 1) {
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${C.redStroke}" stroke-width="5" fill="none" stroke-linecap="round">
    <rect x="-20" y="-50" width="40" height="76" rx="20" fill="#fff5f4"/>
    <path d="M -42 -6 C -42 38 42 38 42 -6"/>
    <line x1="0" y1="38" x2="0" y2="64"/>
    <line x1="-28" y1="64" x2="28" y2="64"/>
  </g>`;
}

function brainIcon(x, y, scale = 1) {
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke="${C.purpleStroke}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M -46 8 C -66 -18 -42 -54 -12 -38 C -2 -66 42 -52 38 -20 C 66 -14 60 34 28 30 C 18 56 -24 50 -24 22 C -38 34 -56 26 -46 8 Z" fill="#f3edff"/>
    <path d="M -16 -34 C -8 -12 -32 -6 -20 18"/>
    <path d="M 20 -36 C 10 -14 36 -6 20 22"/>
    <path d="M -2 -2 C 10 0 18 8 20 22"/>
  </g>`;
}

function architectureFigure() {
  const body = `
  ${dashedRect(55, 165, 390, 760, C.blue, C.blueStroke)}
  ${text(250, 212, 'USER-FACING INTERACTION', 26, C.blueStroke, 'middle', 700)}
  ${smallBox(105, 250, 290, 72, ['Registration', 'name, age, gender'], C.white, C.blueStroke)}
  ${smallBox(105, 348, 290, 72, ['Camera calibration', 'head pose + gaze baseline'], C.white, C.blueStroke)}
  ${smallBox(105, 446, 290, 72, ['QR mobile upload', 'exactly two photos'], C.white, C.blueStroke)}
  ${smallBox(105, 544, 290, 72, ['Photo selection', 'one image per dialogue'], C.white, C.blueStroke)}
  ${smallBox(105, 642, 290, 72, ['Voice dialogue UI', 'question + answer loop'], C.white, C.blueStroke)}
  ${phoneIcon(250, 808, 0.82)}
  ${imageIcon(340, 808, 0.68)}

  ${arrow(445, 545, 545, 545, C.ink, 2.6)}

  ${dashedRect(545, 165, 710, 760, C.teal, C.tealStroke)}
  ${text(900, 212, 'CORE WEB APPLICATION AND BACKEND', 26, C.tealStroke, 'middle', 700)}

  ${smallBox(595, 258, 245, 84, ['Angular 17+', 'Signals, RxJS, Web APIs'], C.white, C.tealStroke, 21)}
  ${smallBox(595, 388, 245, 84, ['Socket.io', 'real-time events'], C.white, C.tealStroke, 21)}
  ${smallBox(595, 518, 245, 84, ['Node.js backend', 'sessions, API routes'], C.white, C.tealStroke, 21)}
  ${smallBox(595, 648, 245, 84, ['Structured storage', 'logs, audio, metrics'], C.white, C.tealStroke, 21)}

  ${smallBox(945, 258, 250, 84, ['Image module', 'description + labels'], C.white, C.purpleStroke, 21)}
  ${smallBox(945, 388, 250, 84, ['LLM dialogue engine', 'question + feedback'], C.white, C.purpleStroke, 21)}
  ${smallBox(945, 518, 250, 84, ['Turn-taking detector', 'endpoint decisions'], C.white, C.purpleStroke, 21)}
  ${smallBox(945, 648, 250, 84, ['Speech services', 'TTS + ASR'], C.white, C.purpleStroke, 21)}

  ${arrow(840, 300, 945, 300)}
  ${arrow(840, 430, 945, 430)}
  ${arrow(840, 560, 945, 560)}
  ${arrow(840, 690, 945, 690)}
  ${arrow(720, 342, 720, 388, C.ink, 3)}
  ${arrow(720, 472, 720, 518, C.ink, 3)}
  ${arrow(720, 602, 720, 648, C.ink, 3)}
  ${arrow(1070, 342, 1070, 388, C.ink, 3)}
  ${arrow(1070, 472, 1070, 518, C.ink, 3)}
  ${arrow(1070, 602, 1070, 648, C.ink, 3)}

  ${arrow(1255, 545, 1355, 545, C.ink, 2.6)}

  ${dashedRect(1355, 165, 390, 760, C.orange, C.orangeStroke)}
  ${text(1550, 212, 'ROBOT ADAPTATION LAYER', 26, C.orangeStroke, 'middle', 700)}
  ${smallBox(1405, 252, 290, 78, ['RobotDriverFactory', 'select driver by robot_id'], C.white, C.orangeStroke, 21)}
  ${smallBox(1405, 365, 290, 78, ['Temi driver', 'native TTS, WebView, camera'], C.white, C.tealStroke, 21)}
  ${smallBox(1405, 478, 290, 78, ['Walker driver', 'ROSBridge speaker + lights'], C.white, C.greenStroke, 21)}
  ${smallBox(1405, 591, 290, 78, ['Output control', 'speak, listen, light, camera'], C.white, C.redStroke, 21)}
  ${robotIcon(1485, 795, 0.85, C.tealStroke)}
  ${robotIcon(1610, 795, 0.85, C.greenStroke)}

  ${arrow(1550, 330, 1550, 365)}
  ${arrow(1550, 443, 1550, 478)}
  ${arrow(1550, 556, 1550, 591)}

  <rect x="510" y="955" width="780" height="70" rx="16" fill="${C.light}" stroke="${C.grid}" stroke-width="2"/>
  ${text(900, 998, 'Single reminiscence logic, platform-specific sensing and output drivers', 25, C.ink, 'middle', 600)}
  `;
  return frame('System Architecture for LLM-Guided Robotic Reminiscence', 'A modular web backend separates photo-guided dialogue intelligence from robot-specific hardware control.', body);
}

function methodFigure() {
  const body = `
  ${dashedRect(60, 170, 400, 675, C.blue, C.blueStroke)}
  ${text(260, 218, 'PHASE 1', 28, C.blueStroke, 'middle', 700)}
  ${text(260, 252, 'Participant Setup', 27, C.ink, 'middle', 700, 'font-style="italic"')}
  ${smallBox(110, 305, 300, 74, ['Consent and registration', 'name, age, gender'], C.white, C.blueStroke, 21)}
  ${smallBox(110, 420, 300, 74, ['Calibration', '50 head-pose/gaze samples'], C.white, C.blueStroke, 21)}
  ${smallBox(110, 535, 300, 74, ['Baseline attention model', 'up/down/left/right/central'], C.white, C.blueStroke, 21)}
  ${smallBox(110, 650, 300, 74, ['Instruction by robot voice', 'hands-free guidance'], C.white, C.blueStroke, 21)}
  ${arrow(260, 379, 260, 420)}
  ${arrow(260, 494, 260, 535)}
  ${arrow(260, 609, 260, 650)}

  ${arrow(460, 508, 555, 508, C.ink, 2.6)}

  ${dashedRect(555, 170, 690, 675, C.yellow, C.yellowStroke)}
  ${text(900, 218, 'PHASE 2', 28, C.yellowStroke, 'middle', 700)}
  ${text(900, 252, 'Photo-Guided Dialogue Session', 27, C.ink, 'middle', 700, 'font-style="italic"')}
  ${smallBox(600, 305, 260, 78, ['Upload two photos', 'mobile QR gateway'], C.white, C.yellowStroke, 21)}
  ${smallBox(600, 430, 260, 78, ['Select photo', 'start one image session'], C.white, C.yellowStroke, 21)}
  ${smallBox(600, 555, 260, 78, ['LLM question planning', 'where, when, who, others'], C.white, C.purpleStroke, 21)}
  ${smallBox(600, 680, 260, 78, ['Robot speech output', 'question + feedback'], C.white, C.redStroke, 21)}

  ${smallBox(940, 305, 260, 78, ['User spoken answer', 'microphone, en-GB ASR'], C.white, C.redStroke, 21)}
  ${smallBox(940, 430, 260, 78, ['Turn-taking model', '0 keep, 1 endpoint, 2 unsure'], C.white, C.purpleStroke, 21)}
  ${smallBox(940, 555, 260, 78, ['Follow-up context', 'previous Q/A + image'], C.white, C.purpleStroke, 21)}
  ${smallBox(940, 680, 260, 78, ['Photo completion', 'four themes completed'], C.white, C.yellowStroke, 21)}

  ${arrow(730, 383, 730, 430)}
  ${arrow(730, 508, 730, 555)}
  ${arrow(730, 633, 730, 680)}
  ${arrow(860, 719, 940, 719)}
  ${arrow(1070, 680, 1070, 633)}
  ${arrow(1070, 555, 1070, 508)}
  ${arrow(1070, 430, 1070, 383)}
  <path d="M 940 344 C 900 344 890 719 940 719" fill="none" stroke="${C.muted}" stroke-width="3.5" stroke-dasharray="9 7" marker-end="url(#arrow)"/>
  ${text(900, 808, 'Iterative four-theme dialogue per photo', 23, C.muted, 'middle', 600)}

  ${arrow(1245, 508, 1340, 508, C.ink, 2.6)}

  ${dashedRect(1340, 170, 400, 675, C.green, C.greenStroke)}
  ${text(1540, 218, 'PHASE 3', 28, C.greenStroke, 'middle', 700)}
  ${text(1540, 252, 'Cross-Platform Evaluation', 27, C.ink, 'middle', 700, 'font-style="italic"')}
  ${smallBox(1390, 305, 300, 74, ['Counterbalanced order', 'Temi first or Walker first'], C.white, C.greenStroke, 21)}
  ${smallBox(1390, 420, 300, 74, ['Objective logs', 'latency, answers, attention'], C.white, C.greenStroke, 21)}
  ${smallBox(1390, 535, 300, 74, ['Questionnaires', 'SUS, NASA-TLX, SASSI'], C.white, C.greenStroke, 21)}
  ${smallBox(1390, 650, 300, 74, ['Paired comparison', 'Temi vs Walker outcomes'], C.white, C.greenStroke, 21)}
  ${arrow(1540, 379, 1540, 420)}
  ${arrow(1540, 494, 1540, 535)}
  ${arrow(1540, 609, 1540, 650)}

  <rect x="250" y="900" width="1300" height="86" rx="18" fill="${C.light}" stroke="${C.grid}" stroke-width="2"/>
  ${text(900, 936, 'Primary analysis dimensions', 24, C.ink, 'middle', 700)}
  ${text(900, 970, 'Task effectiveness  |  Engagement and gaze  |  System responsiveness  |  Subjective experience', 24, C.muted, 'middle', 500)}
  `;
  return frame('Experimental Method for Cross-Robot Reminiscence Evaluation', 'A within-subject protocol compares the same photo-guided LLM dialogue on Temi and Walker.', body);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const files = [
    ['figure-method-core-experiment.svg', methodFigure()],
    ['figure-architecture-system.svg', architectureFigure()]
  ];
  await Promise.all(files.map(([name, content]) => writeFile(join(outDir, name), content, 'utf8')));
  console.log(`Wrote ${files.length} SVG figures to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
