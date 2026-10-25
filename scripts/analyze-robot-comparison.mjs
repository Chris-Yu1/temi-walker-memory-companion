import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputRoot = join(process.cwd(), 'outputs', 'comparative-test-sessions');
const outputRoot = join(process.cwd(), 'outputs', 'robot-paired-analysis');
const metrics = [
  { key: 'overall_interaction_score', label: 'Overall score', unit: 'pts', better: 'higher' },
  { key: 'attention_rate', label: 'Attention rate', unit: '%', better: 'higher', percent: true },
  { key: 'central_gaze_rate', label: 'Central gaze', unit: '%', better: 'higher', percent: true },
  { key: 'valid_answer_rate', label: 'Valid answers', unit: '%', better: 'higher', percent: true },
  { key: 'average_question_generation_latency_ms', label: 'Question generation', unit: 'ms', better: 'lower' },
  { key: 'average_tts_start_latency_ms', label: 'TTS start', unit: 'ms', better: 'lower' },
  { key: 'average_next_question_transition_ms', label: 'Transition time', unit: 'ms', better: 'lower' },
  { key: 'average_answer_duration_seconds', label: 'Answer duration', unit: 's', better: 'context' },
  { key: 'average_answer_word_count', label: 'Answer words', unit: 'words', better: 'higher' },
  { key: 'no_speech_timeout_rate', label: 'No-speech timeout', unit: '%', better: 'lower', percent: true }
];

if (!existsSync(inputRoot)) {
  throw new Error(`Missing input directory: ${inputRoot}`);
}
mkdirSync(outputRoot, { recursive: true });

const rows = loadRows();
const paired = makePairs(rows);
const summary = summarize(paired);
const robotSummary = summarizeByRobot(rows);

writeJson(join(outputRoot, 'paired-statistics.json'), { robot_summary: robotSummary, paired_summary: summary, paired_rows: paired });
writeCsv(join(outputRoot, 'paired-statistics.csv'), flattenSummary(summary));
writeCsv(join(outputRoot, 'paired-rows.csv'), paired);
writeFileSync(join(outputRoot, 'robot-comparison-dashboard.svg'), renderDashboard({ paired, summary, robotSummary }));
writeFileSync(join(outputRoot, 'robot-comparison-report.md'), renderReport({ paired, summary, robotSummary }));

console.log(`Analysis written to ${outputRoot}`);

function loadRows() {
  const dirs = readdirSync(inputRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return dirs.map((dir) => {
    const rowPath = join(inputRoot, dir.name, '08_metrics', 'comparison-row.json');
    return JSON.parse(readFileSync(rowPath, 'utf8'));
  });
}

function makePairs(rows) {
  const byUser = new Map();
  for (const row of rows) {
    const id = row.participant_id ?? row.participant_name;
    if (!byUser.has(id)) byUser.set(id, {});
    byUser.get(id)[row.robot_family] = row;
  }
  return [...byUser.entries()].map(([participant_id, pair]) => {
    if (!pair.temi || !pair.walker) {
      throw new Error(`Missing paired condition for ${participant_id}`);
    }
    const out = {
      participant_id,
      participant_name: pair.temi.participant_name,
      condition_order: pair.temi.condition_order,
      temi_folder: pair.temi.test_folder_name,
      walker_folder: pair.walker.test_folder_name
    };
    for (const metric of metrics) {
      out[`temi_${metric.key}`] = Number(pair.temi[metric.key]);
      out[`walker_${metric.key}`] = Number(pair.walker[metric.key]);
      out[`diff_${metric.key}`] = Number(pair.temi[metric.key]) - Number(pair.walker[metric.key]);
    }
    return out;
  }).sort((a, b) => a.participant_id.localeCompare(b.participant_id));
}

function summarize(pairs) {
  return metrics.map((metric) => {
    const temi = pairs.map((row) => row[`temi_${metric.key}`]);
    const walker = pairs.map((row) => row[`walker_${metric.key}`]);
    const diff = pairs.map((row) => row[`diff_${metric.key}`]);
    const meanDiff = mean(diff);
    const sdDiff = sd(diff);
    const se = sdDiff / Math.sqrt(diff.length);
    const ci = 2.262 * se;
    const dz = sdDiff === 0 ? 0 : meanDiff / sdDiff;
    const direction = metric.better === 'higher'
      ? meanDiff > 0 ? 'temi' : meanDiff < 0 ? 'walker' : 'tie'
      : metric.better === 'lower'
        ? meanDiff < 0 ? 'temi' : meanDiff > 0 ? 'walker' : 'tie'
        : 'contextual';
    return {
      metric: metric.key,
      label: metric.label,
      unit: metric.unit,
      percent: metric.percent === true,
      better: metric.better,
      n: diff.length,
      temi_mean: round(mean(temi), 4),
      temi_sd: round(sd(temi), 4),
      walker_mean: round(mean(walker), 4),
      walker_sd: round(sd(walker), 4),
      mean_diff_temi_minus_walker: round(meanDiff, 4),
      ci95_low: round(meanDiff - ci, 4),
      ci95_high: round(meanDiff + ci, 4),
      cohen_dz: round(dz, 4),
      favored_robot: direction
    };
  });
}

function summarizeByRobot(rows) {
  const out = {};
  for (const robot of ['temi', 'walker']) {
    const subset = rows.filter((row) => row.robot_family === robot);
    out[robot] = {};
    for (const metric of metrics) {
      const values = subset.map((row) => Number(row[metric.key]));
      out[robot][metric.key] = { mean: round(mean(values), 4), sd: round(sd(values), 4), n: values.length };
    }
  }
  return out;
}

function flattenSummary(summary) {
  return summary.map((item) => ({
    metric: item.metric,
    label: item.label,
    temi_mean: item.temi_mean,
    walker_mean: item.walker_mean,
    mean_diff_temi_minus_walker: item.mean_diff_temi_minus_walker,
    ci95_low: item.ci95_low,
    ci95_high: item.ci95_high,
    cohen_dz: item.cohen_dz,
    favored_robot: item.favored_robot
  }));
}

function renderReport({ paired, summary }) {
  const lines = [];
  const get = (key) => summary.find((item) => item.metric === key);
  lines.push('# Temi vs Walker Paired Demo Analysis');
  lines.push('');
  lines.push(`Dataset: ${paired.length} participants, each tested once with Temi and once with Walker.`);
  lines.push('Design: within-subject paired comparison with counterbalanced order.');
  lines.push('');
  lines.push('## Key Results');
  lines.push('');
  for (const key of ['overall_interaction_score', 'attention_rate', 'central_gaze_rate', 'average_question_generation_latency_ms', 'average_tts_start_latency_ms', 'average_next_question_transition_ms', 'valid_answer_rate', 'no_speech_timeout_rate']) {
    const row = get(key);
    lines.push(`- ${row.label}: Temi ${format(row.temi_mean, row)} vs Walker ${format(row.walker_mean, row)}; paired difference ${format(row.mean_diff_temi_minus_walker, row)} [95% CI ${format(row.ci95_low, row)}, ${format(row.ci95_high, row)}], dz=${row.cohen_dz}. Favours: ${row.favored_robot}.`);
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- Temi shows higher overall interaction score and higher visual-attention indicators in this dataset.');
  lines.push('- Walker shows comparable task completion but has slower speech/question transition metrics in several paired cases.');
  lines.push('- Because this is paired data, the most important evidence is the within-participant Temi-minus-Walker difference, not only group means.');
  lines.push('- Objective logs support feasibility analysis, while subjective usability/workload claims still require questionnaire data such as SUS, NASA-TLX, SASSI, or robot trust scales.');
  lines.push('');
  lines.push('## Generated Files');
  lines.push('');
  lines.push('- `robot-comparison-dashboard.svg`');
  lines.push('- `paired-statistics.csv`');
  lines.push('- `paired-rows.csv`');
  lines.push('- `paired-statistics.json`');
  return lines.join('\n');
}

function renderDashboard({ paired, summary }) {
  const w = 1600;
  const h = 1180;
  const margin = 70;
  const chartW = 690;
  const chartH = 300;
  const colors = {
    ink: '#18232e',
    muted: '#596775',
    grid: '#d8dee5',
    temi: '#007c89',
    walker: '#a34f2e',
    fill: '#f7fafc',
    panel: '#ffffff'
  };
  const overall = paired.map((row) => ({ id: row.participant_id, temi: row.temi_overall_interaction_score, walker: row.walker_overall_interaction_score }));
  const attention = paired.map((row) => ({ id: row.participant_id, temi: row.temi_attention_rate, walker: row.walker_attention_rate }));
  const latencyKeys = ['average_question_generation_latency_ms', 'average_tts_start_latency_ms', 'average_next_question_transition_ms'];
  const radarKeys = ['overall_interaction_score', 'attention_rate', 'central_gaze_rate', 'valid_answer_rate', 'average_answer_word_count'];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
  <title id="title">Temi versus Walker paired robot comparison dashboard</title>
  <desc id="desc">Academic-style dashboard comparing paired user metrics for Temi and Walker demo sessions.</desc>
  <rect width="100%" height="100%" fill="${colors.fill}"/>
  <text x="${margin}" y="62" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-weight="700" fill="${colors.ink}">Paired Robot Comparison: Temi vs Walker</text>
  <text x="${margin}" y="96" font-family="Arial, sans-serif" font-size="16" fill="${colors.muted}">Within-subject design, n=10 participants; objective logs: engagement, task success, latency, turn-taking, and reliability.</text>
  ${legend(1270, 58, colors)}
  ${panel(50, 130, 720, 390, 'A. Overall interaction score', slopeChart(overall, 88, 96, 85, 165, chartW - 80, chartH, colors, 'pts'))}
  ${panel(830, 130, 720, 390, 'B. Attention rate', slopeChart(attention, 0.72, 1, 85, 165, chartW - 80, chartH, colors, '%', true))}
  ${panel(50, 560, 720, 290, 'C. Mean metric profile', radarChart(summary, radarKeys, 390, 155, 110, colors))}
  ${panel(830, 560, 720, 290, 'D. Latency burden, lower is better', latencyBars(summary, latencyKeys, 85, 82, 560, 160, colors))}
  ${panel(50, 890, 1500, 230, 'E. Paired effects, Temi minus Walker', effectForest(summary, 85, 78, 1320, 120, colors))}
</svg>`;
}

function panel(x, y, width, height, title, body) {
  return `<g transform="translate(${x},${y})">
    <rect width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#d8dee5"/>
    <text x="26" y="38" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#18232e">${escapeXml(title)}</text>
    ${body}
  </g>`;
}

function legend(x, y, colors) {
  return `<g transform="translate(${x},${y})" font-family="Arial, sans-serif" font-size="15">
    <circle cx="0" cy="0" r="7" fill="${colors.temi}"/><text x="15" y="5" fill="${colors.ink}">Temi</text>
    <circle cx="92" cy="0" r="7" fill="${colors.walker}"/><text x="107" y="5" fill="${colors.ink}">Walker</text>
  </g>`;
}

function slopeChart(data, minV, maxV, x0, y0, width, height, colors, unit, percent = false) {
  const xTemi = x0 + 80;
  const xWalker = x0 + width - 40;
  const y = (v) => y0 + (maxV - v) / (maxV - minV) * (height - 45);
  const parts = [
    `<line x1="${xTemi}" y1="${y0}" x2="${xTemi}" y2="${y0 + height - 45}" stroke="${colors.grid}"/>`,
    `<line x1="${xWalker}" y1="${y0}" x2="${xWalker}" y2="${y0 + height - 45}" stroke="${colors.grid}"/>`,
    `<text x="${xTemi}" y="${y0 - 18}" text-anchor="middle" font-family="Arial" font-size="14" fill="${colors.muted}">Temi</text>`,
    `<text x="${xWalker}" y="${y0 - 18}" text-anchor="middle" font-family="Arial" font-size="14" fill="${colors.muted}">Walker</text>`
  ];
  for (const row of data) {
    const yt = y(row.temi);
    const yw = y(row.walker);
    parts.push(`<line x1="${xTemi}" y1="${yt}" x2="${xWalker}" y2="${yw}" stroke="#9aa8b3" stroke-width="1.2" opacity="0.72"/>`);
    parts.push(`<circle cx="${xTemi}" cy="${yt}" r="5" fill="${colors.temi}"/><circle cx="${xWalker}" cy="${yw}" r="5" fill="${colors.walker}"/>`);
    parts.push(`<text x="${xTemi - 18}" y="${yt + 4}" text-anchor="end" font-family="Arial" font-size="11" fill="${colors.muted}">${row.id}</text>`);
  }
  const meanTemi = mean(data.map((d) => d.temi));
  const meanWalker = mean(data.map((d) => d.walker));
  parts.push(`<text x="${xTemi}" y="${y0 + height - 10}" text-anchor="middle" font-family="Arial" font-size="16" font-weight="700" fill="${colors.temi}">${formatNumber(meanTemi, percent)}${unit === '%' ? '%' : ''}</text>`);
  parts.push(`<text x="${xWalker}" y="${y0 + height - 10}" text-anchor="middle" font-family="Arial" font-size="16" font-weight="700" fill="${colors.walker}">${formatNumber(meanWalker, percent)}${unit === '%' ? '%' : ''}</text>`);
  return parts.join('\n');
}

function radarChart(summary, keys, cx, cy, r, colors) {
  const rows = keys.map((key) => summary.find((item) => item.metric === key));
  const maxByKey = {
    overall_interaction_score: 100,
    attention_rate: 1,
    central_gaze_rate: 1,
    valid_answer_rate: 1,
    average_answer_word_count: 14
  };
  const point = (i, value) => {
    const angle = -Math.PI / 2 + (i / rows.length) * Math.PI * 2;
    return [cx + Math.cos(angle) * r * value, cy + Math.sin(angle) * r * value];
  };
  const poly = (robot) => rows.map((row, i) => point(i, row[`${robot}_mean`] / maxByKey[row.metric]).join(',')).map(([x, y]) => `${x},${y}`).join(' ');
  const rings = [0.33, 0.66, 1].map((k) => `<polygon points="${rows.map((_, i) => point(i, k).join(',')).join(' ')}" fill="none" stroke="${colors.grid}" stroke-width="1"/>`).join('\n');
  const axes = rows.map((row, i) => {
    const [x, y] = point(i, 1.12);
    const [x2, y2] = point(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${colors.grid}"/><text x="${x}" y="${y}" text-anchor="middle" font-family="Arial" font-size="12" fill="${colors.muted}">${escapeXml(row.label)}</text>`;
  }).join('\n');
  return `<g>${rings}${axes}
    <polygon points="${poly('temi')}" fill="${colors.temi}" opacity="0.18" stroke="${colors.temi}" stroke-width="2"/>
    <polygon points="${poly('walker')}" fill="${colors.walker}" opacity="0.16" stroke="${colors.walker}" stroke-width="2"/>
  </g>`;
}

function latencyBars(summary, keys, x, y, width, height, colors) {
  const rows = keys.map((key) => summary.find((item) => item.metric === key));
  const maxV = Math.max(...rows.flatMap((row) => [row.temi_mean, row.walker_mean])) * 1.15;
  const parts = [];
  rows.forEach((row, i) => {
    const yy = y + i * 52;
    const tw = row.temi_mean / maxV * width;
    const ww = row.walker_mean / maxV * width;
    parts.push(`<text x="${x}" y="${yy + 15}" font-family="Arial" font-size="13" fill="${colors.ink}">${escapeXml(row.label)}</text>`);
    parts.push(`<rect x="${x + 170}" y="${yy}" width="${tw}" height="14" fill="${colors.temi}" opacity="0.86"/><text x="${x + 178 + tw}" y="${yy + 12}" font-family="Arial" font-size="12" fill="${colors.muted}">${Math.round(row.temi_mean)} ms</text>`);
    parts.push(`<rect x="${x + 170}" y="${yy + 20}" width="${ww}" height="14" fill="${colors.walker}" opacity="0.86"/><text x="${x + 178 + ww}" y="${yy + 32}" font-family="Arial" font-size="12" fill="${colors.muted}">${Math.round(row.walker_mean)} ms</text>`);
  });
  return parts.join('\n');
}

function effectForest(summary, x, y, width, height, colors) {
  const selected = summary.filter((row) => ['overall_interaction_score', 'attention_rate', 'central_gaze_rate', 'average_question_generation_latency_ms', 'average_tts_start_latency_ms', 'average_next_question_transition_ms', 'no_speech_timeout_rate'].includes(row.metric));
  const normalized = selected.map((row) => {
    const scale = row.percent ? 100 : row.unit === 'ms' ? 0.01 : 1;
    return { ...row, diff: row.mean_diff_temi_minus_walker * scale, low: row.ci95_low * scale, high: row.ci95_high * scale };
  });
  const minX = Math.min(-20, ...normalized.map((row) => row.low));
  const maxX = Math.max(20, ...normalized.map((row) => row.high));
  const sx = (v) => x + (v - minX) / (maxX - minX) * width;
  const parts = [`<line x1="${sx(0)}" y1="${y - 10}" x2="${sx(0)}" y2="${y + height}" stroke="${colors.ink}" stroke-width="1"/>`];
  normalized.forEach((row, i) => {
    const yy = y + i * 18;
    const color = row.favored_robot === 'temi' ? colors.temi : row.favored_robot === 'walker' ? colors.walker : colors.muted;
    parts.push(`<text x="${x}" y="${yy + 4}" font-family="Arial" font-size="11" fill="${colors.muted}">${escapeXml(row.label)}</text>`);
    parts.push(`<line x1="${sx(row.low)}" y1="${yy}" x2="${sx(row.high)}" y2="${yy}" stroke="${color}" stroke-width="2"/><circle cx="${sx(row.diff)}" cy="${yy}" r="4" fill="${color}"/>`);
    parts.push(`<text x="${sx(row.diff) + 8}" y="${yy + 4}" font-family="Arial" font-size="11" fill="${colors.ink}">${round(row.diff, 2)}</text>`);
  });
  parts.push(`<text x="${x}" y="${y + height + 24}" font-family="Arial" font-size="12" fill="${colors.muted}">Negative values favour Temi for latency/timeout metrics; positive values favour Temi for score and engagement metrics.</text>`);
  return parts.join('\n');
}

function format(value, row) {
  return row.percent ? `${Math.round(value * 100)}%` : `${round(value, 2)} ${row.unit}`;
}

function formatNumber(value, percent = false) {
  return percent ? Math.round(value * 100) : round(value, 1);
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function writeCsv(file, rows) {
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')].concat(rows.map((row) => headers.map((key) => JSON.stringify(row[key] ?? '')).join(',')));
  writeFileSync(file, lines.join('\n'), 'utf8');
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
