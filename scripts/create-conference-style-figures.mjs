import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const summaryPath = join(root, 'outputs', 'combined-robot-analysis', 'combined-summary.json');
const participantPath = join(root, 'outputs', 'combined-robot-analysis', 'participant-level-combined.csv');
const outputRoot = join(root, 'outputs', 'combined-robot-analysis', 'figures');

const W = 1400;
const H = 900;
const C = {
  bg: '#fbfcfd',
  ink: '#182a33',
  muted: '#62747e',
  light: '#eef4f6',
  grid: '#d7e2e7',
  axis: '#52656f',
  temi: '#176b72',
  walker: '#c15b3e',
  both: '#84939b'
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (row.length || cell) row.push(cell), rows.push(row);
  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((values) => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ''])));
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[ch]);
}

function text(x, y, content, size = 18, color = C.ink, anchor = 'start', weight = 400) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(content)}</text>`;
}

function frame(title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${text(70, 62, title, 30, C.ink, 'start', 700)}
  ${text(70, 94, subtitle, 17, C.muted)}
  ${body}
</svg>`;
}

function legend(x, y) {
  return `<g>
    <rect x="${x}" y="${y - 16}" width="20" height="20" rx="3" fill="${C.temi}"/>
    ${text(x + 32, y, 'Temi', 17)}
    <rect x="${x + 122}" y="${y - 16}" width="20" height="20" rx="3" fill="${C.walker}"/>
    ${text(x + 154, y, 'Walker', 17)}
  </g>`;
}

function stat(summary, metric) {
  return summary.objective_stats.find((row) => row.metric === metric);
}

function axisY(plot, min, max, ticks, formatter) {
  const y = (v) => plot.y + plot.h - ((v - min) / (max - min)) * plot.h;
  return {
    y,
    svg: ticks.map((tick) => {
      const yy = y(tick);
      return `<line x1="${plot.x}" y1="${yy}" x2="${plot.x + plot.w}" y2="${yy}" stroke="${C.grid}"/>
      ${text(plot.x - 14, yy + 5, formatter(tick), 14, C.muted, 'end')}`;
    }).join('\n')
  };
}

function pairedPanel({ x, y, w, h, min, max, ticks, title, leftLabel, rightLabel, participants, temiKey, walkerKey, formatter }) {
  const plot = { x, y: y + 42, w, h };
  const scale = axisY(plot, min, max, ticks, formatter);
  const lx = plot.x + w * 0.30;
  const rx = plot.x + w * 0.70;
  const lines = participants.map((row) => {
    const t = num(row[temiKey]);
    const wk = num(row[walkerKey]);
    return `<line x1="${lx}" y1="${scale.y(t)}" x2="${rx}" y2="${scale.y(wk)}" stroke="${C.axis}" stroke-width="1.4" opacity="0.34"/>
      <circle cx="${lx}" cy="${scale.y(t)}" r="5" fill="${C.temi}"/>
      <circle cx="${rx}" cy="${scale.y(wk)}" r="5" fill="${C.walker}"/>`;
  }).join('\n');
  return `<g>
    ${text(x, y, title, 21, C.ink, 'start', 700)}
    ${scale.svg}
    <line x1="${plot.x}" y1="${plot.y + plot.h}" x2="${plot.x + plot.w}" y2="${plot.y + plot.h}" stroke="${C.axis}" stroke-width="1.5"/>
    ${lines}
    ${text(lx, plot.y + plot.h + 36, leftLabel, 16, C.muted, 'middle')}
    ${text(rx, plot.y + plot.h + 36, rightLabel, 16, C.muted, 'middle')}
  </g>`;
}

function figure1(summary, participants) {
  const score = stat(summary, 'overall_interaction_score');
  const valid = stat(summary, 'valid_answer_rate');
  const body = `
  ${legend(1020, 62)}
  ${pairedPanel({
    x: 90, y: 150, w: 530, h: 520, min: 80, max: 96,
    ticks: [80, 84, 88, 92, 96],
    title: 'Overall interaction score',
    leftLabel: `Mean ${score.temi_mean.toFixed(1)}`,
    rightLabel: `Mean ${score.walker_mean.toFixed(1)}`,
    participants,
    temiKey: 'temi_overall_interaction_score',
    walkerKey: 'walker_overall_interaction_score',
    formatter: (v) => String(v)
  })}
  ${pairedPanel({
    x: 740, y: 150, w: 530, h: 520, min: 0.65, max: 1,
    ticks: [0.7, 0.8, 0.9, 1.0],
    title: 'Valid answer rate',
    leftLabel: `Mean ${(valid.temi_mean * 100).toFixed(1)}%`,
    rightLabel: `Mean ${(valid.walker_mean * 100).toFixed(1)}%`,
    participants,
    temiKey: 'temi_valid_answer_rate',
    walkerKey: 'walker_valid_answer_rate',
    formatter: (v) => `${Math.round(v * 100)}%`
  })}
  <rect x="105" y="775" width="1190" height="54" rx="8" fill="${C.light}" stroke="${C.grid}"/>
  ${text(130, 809, `Paired effect: overall score +${score.mean_difference_temi_minus_walker.toFixed(2)} points for Temi; valid-answer difference ${(valid.mean_difference_temi_minus_walker * 100).toFixed(1)} percentage points.`, 18, C.ink)}
  `;
  return frame('Figure 1. Task Effectiveness', 'Each line connects the same participant across the two robot conditions (n=10).', body);
}

function figure2(summary, participants) {
  const attention = stat(summary, 'attention_rate');
  const gaze = stat(summary, 'central_gaze_rate');
  const body = `
  ${legend(1020, 62)}
  ${pairedPanel({
    x: 90, y: 150, w: 530, h: 520, min: 0.70, max: 1.0,
    ticks: [0.7, 0.8, 0.9, 1.0],
    title: 'Attention rate',
    leftLabel: `Mean ${(attention.temi_mean * 100).toFixed(1)}%`,
    rightLabel: `Mean ${(attention.walker_mean * 100).toFixed(1)}%`,
    participants,
    temiKey: 'temi_attention_rate',
    walkerKey: 'walker_attention_rate',
    formatter: (v) => `${Math.round(v * 100)}%`
  })}
  ${pairedPanel({
    x: 740, y: 150, w: 530, h: 520, min: 0.70, max: 1.0,
    ticks: [0.7, 0.8, 0.9, 1.0],
    title: 'Central gaze rate',
    leftLabel: `Mean ${(gaze.temi_mean * 100).toFixed(1)}%`,
    rightLabel: `Mean ${(gaze.walker_mean * 100).toFixed(1)}%`,
    participants,
    temiKey: 'temi_central_gaze_rate',
    walkerKey: 'walker_central_gaze_rate',
    formatter: (v) => `${Math.round(v * 100)}%`
  })}
  <rect x="105" y="775" width="1190" height="54" rx="8" fill="${C.light}" stroke="${C.grid}"/>
  ${text(130, 809, `Temi shows higher attention (+${(attention.mean_difference_temi_minus_walker * 100).toFixed(1)} pp) and higher central gaze (+${(gaze.mean_difference_temi_minus_walker * 100).toFixed(1)} pp).`, 18, C.ink)}
  `;
  return frame('Figure 2. Engagement and Visual Attention', 'Head-pose and eye-gaze derived measures summarized as valid sample proportions.', body);
}

function horizontalBars(rows, x, y, w, max, formatter) {
  const grid = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const xx = x + p * w;
    return `<line x1="${xx}" y1="${y - 34}" x2="${xx}" y2="${y + rows.length * 118 - 6}" stroke="${C.grid}"/>
      ${text(xx, y + rows.length * 118 + 28, formatter(max * p), 14, C.muted, 'middle')}`;
  }).join('\n');
  const bars = rows.map((row, i) => {
    const yy = y + i * 118;
    const tw = (row.temi_mean / max) * w;
    const ww = (row.walker_mean / max) * w;
    return `<g>
      ${text(x - 28, yy + 3, row.label, 18, C.ink, 'end')}
      <rect x="${x}" y="${yy - 18}" width="${tw}" height="26" rx="5" fill="${C.temi}"/>
      <rect x="${x}" y="${yy + 20}" width="${ww}" height="26" rx="5" fill="${C.walker}"/>
      ${text(x + tw + 12, yy + 2, formatter(row.temi_mean), 15, C.ink)}
      ${text(x + ww + 12, yy + 40, formatter(row.walker_mean), 15, C.ink)}
      ${text(x, yy + 75, `Temi-Walker: ${formatter(row.mean_difference_temi_minus_walker)}; 95% CI ${formatter(row.ci95_low)} to ${formatter(row.ci95_high)}`, 14, C.muted)}
    </g>`;
  }).join('\n');
  return `${grid}${bars}`;
}

function figure3(summary) {
  const rows = [
    stat(summary, 'average_question_generation_latency_ms'),
    stat(summary, 'average_tts_start_latency_ms'),
    stat(summary, 'average_next_question_transition_ms')
  ];
  const timeout = stat(summary, 'no_speech_timeout_rate');
  const body = `
  ${legend(1015, 82)}
  ${text(700, 150, 'Latency in seconds; lower is better', 17, C.muted, 'middle')}
  ${horizontalBars(rows, 390, 235, 700, 10000, (v) => `${(v / 1000).toFixed(1)}s`)}
  <line x1="390" y1="645" x2="1090" y2="645" stroke="${C.grid}" stroke-width="2"/>
  ${text(390, 690, `No-speech timeout: Temi ${(timeout.temi_mean * 100).toFixed(1)}%, Walker ${(timeout.walker_mean * 100).toFixed(1)}%`, 18, C.ink)}
  ${text(390, 724, 'Lower question latency and faster speech onset explain most responsiveness differences.', 16, C.muted)}
  `;
  return frame('Figure 3. System Responsiveness', 'Latency measures from backend logs and robot speech-control events.', body);
}

function figure4(summary) {
  const q = summary.questionnaire_summary;
  const prefs = summary.preference_counts;
  const metrics = [
    ['SUS usability', q.sus_score, 100, '/100', C.temi],
    ['NASA-TLX workload', q.nasa_tlx_mean, 7, '/7', C.walker],
    ['SASSI overall', q.sassi_overall_mean, 5, '/5', C.temi],
    ['SASSI likeability', q.sassi_mean_likeability, 5, '/5', C.temi],
    ['SASSI speed', q.sassi_mean_speed, 5, '/5', C.temi]
  ];
  const x = 270;
  const y = 170;
  const w = 650;
  const bars = metrics.map(([label, value, max, unit, color], i) => {
    const yy = y + i * 88;
    const bw = (value / max) * w;
    return `<g>
      ${text(x - 28, yy + 18, label, 18, C.ink, 'end')}
      <rect x="${x}" y="${yy}" width="${w}" height="28" rx="5" fill="${C.grid}"/>
      <rect x="${x}" y="${yy}" width="${bw}" height="28" rx="5" fill="${color}"/>
      ${text(x + w + 22, yy + 21, `${Number(value).toFixed(label === 'SUS usability' ? 1 : 2)} ${unit}`, 17, C.ink)}
    </g>`;
  }).join('\n');
  const prefTotal = (prefs.temi ?? 0) + (prefs.walker ?? 0) + (prefs.both ?? 0);
  const px = 270;
  const py = 680;
  const pw = 650;
  const temiW = ((prefs.temi ?? 0) / prefTotal) * pw;
  const walkerW = ((prefs.walker ?? 0) / prefTotal) * pw;
  const bothW = ((prefs.both ?? 0) / prefTotal) * pw;
  const body = `
  ${bars}
  ${text(px - 28, py + 22, 'Preference', 18, C.ink, 'end')}
  <rect x="${px}" y="${py}" width="${temiW}" height="34" rx="5" fill="${C.temi}"/>
  <rect x="${px + temiW}" y="${py}" width="${walkerW}" height="34" fill="${C.walker}"/>
  <rect x="${px + temiW + walkerW}" y="${py}" width="${bothW}" height="34" rx="5" fill="${C.both}"/>
  ${text(px + temiW / 2, py + 24, `${prefs.temi ?? 0}`, 15, '#ffffff', 'middle', 700)}
  ${text(px + temiW + walkerW / 2, py + 24, `${prefs.walker ?? 0}`, 15, '#ffffff', 'middle', 700)}
  ${text(px + temiW + walkerW + bothW / 2, py + 24, `${prefs.both ?? 0}`, 15, '#ffffff', 'middle', 700)}
  <rect x="${px}" y="${py + 56}" width="18" height="18" rx="3" fill="${C.temi}"/>
  ${text(px + 28, py + 71, `Temi ${prefs.temi ?? 0}`, 15, C.ink)}
  <rect x="${px + 140}" y="${py + 56}" width="18" height="18" rx="3" fill="${C.walker}"/>
  ${text(px + 168, py + 71, `Walker ${prefs.walker ?? 0}`, 15, C.ink)}
  <rect x="${px + 300}" y="${py + 56}" width="18" height="18" rx="3" fill="${C.both}"/>
  ${text(px + 328, py + 71, `Both ${prefs.both ?? 0}`, 15, C.ink)}
  <rect x="980" y="190" width="270" height="270" rx="10" fill="${C.light}" stroke="${C.grid}"/>
  ${text(1115, 246, 'Subjective summary', 21, C.ink, 'middle', 700)}
  ${text(1115, 300, `SUS ${q.sus_score.toFixed(1)}/100`, 24, C.temi, 'middle', 700)}
  ${text(1115, 350, `TLX ${q.nasa_tlx_mean.toFixed(2)}/7`, 24, C.walker, 'middle', 700)}
  ${text(1115, 400, `SASSI ${q.sassi_overall_mean.toFixed(2)}/5`, 24, C.ink, 'middle', 700)}
  <rect x="190" y="770" width="1020" height="52" rx="8" fill="${C.light}" stroke="${C.grid}"/>
  ${text(220, 803, 'The post-study questionnaire is interpreted as overall experience plus preference, not as two separate robot-specific scale scores.', 16, C.muted)}
  `;
  return frame('Figure 4. Questionnaire Outcomes', 'Post-study SUS, NASA-TLX, SASSI, and preference results after both robot conditions (n=10).', body);
}

async function main() {
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const participants = parseCsv(await readFile(participantPath, 'utf8'));
  await mkdir(outputRoot, { recursive: true });
  const figures = [
    ['figure-1-task-effectiveness.svg', figure1(summary, participants)],
    ['figure-2-engagement-attention.svg', figure2(summary, participants)],
    ['figure-3-system-responsiveness.svg', figure3(summary)],
    ['figure-4-questionnaire-outcomes.svg', figure4(summary)]
  ];
  await Promise.all(figures.map(([name, content]) => writeFile(join(outputRoot, name), content, 'utf8')));
  console.log(`Wrote ${figures.length} cleaned figures to ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
