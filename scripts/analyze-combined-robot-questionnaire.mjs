import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const sessionsCsvPath = join(root, 'outputs', 'comparative-test-sessions', 'comparison-index.csv');
const questionnaireCsvPath = join(root, 'outputs', 'comparative-questionnaires', 'all-questionnaire-responses.csv');
const outputRoot = join(root, 'outputs', 'combined-robot-analysis');

const objectiveMetrics = [
  { key: 'overall_interaction_score', label: 'Overall score', higherBetter: true, unit: 'pts' },
  { key: 'attention_rate', label: 'Attention rate', higherBetter: true, unit: '%' },
  { key: 'central_gaze_rate', label: 'Central gaze', higherBetter: true, unit: '%' },
  { key: 'valid_answer_rate', label: 'Valid answers', higherBetter: true, unit: '%' },
  { key: 'average_question_generation_latency_ms', label: 'Question API latency', higherBetter: false, unit: 'ms' },
  { key: 'average_tts_start_latency_ms', label: 'TTS start latency', higherBetter: false, unit: 'ms' },
  { key: 'average_next_question_transition_ms', label: 'Transition time', higherBetter: false, unit: 'ms' },
  { key: 'no_speech_timeout_rate', label: 'No-speech timeout', higherBetter: false, unit: '%' }
];

const questionnaireMetrics = [
  { key: 'sus_score', label: 'SUS usability', unit: '/100' },
  { key: 'nasa_tlx_mean', label: 'NASA-TLX workload', unit: '/7' },
  { key: 'sassi_overall_mean', label: 'SASSI overall', unit: '/5' },
  { key: 'sassi_mean_likeability', label: 'SASSI likeability', unit: '/5' },
  { key: 'sassi_mean_speed', label: 'SASSI speed', unit: '/5' }
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((item) => item.length > 1);
  return body.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])));
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function sd(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 0;
  const avg = mean(valid);
  return Math.sqrt(valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1));
}

function fixed(value, digits = 3) {
  if (!Number.isFinite(value)) return '';
  return Number(value.toFixed(digits));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  return [header.join(','), ...rows.map((row) => header.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
}

function pairedStats(pairs, key, higherBetter) {
  const temi = pairs.map((pair) => pair.temi[key]).filter(Number.isFinite);
  const walker = pairs.map((pair) => pair.walker[key]).filter(Number.isFinite);
  const diffs = pairs.map((pair) => pair.temi[key] - pair.walker[key]).filter(Number.isFinite);
  const n = diffs.length;
  const diffMean = mean(diffs);
  const diffSd = sd(diffs);
  const tCritical = 2.262;
  const ci = tCritical * diffSd / Math.sqrt(n);
  const dz = diffSd ? diffMean / diffSd : 0;
  const temiMean = mean(temi);
  const walkerMean = mean(walker);
  const favors = higherBetter
    ? (diffMean >= 0 ? 'temi' : 'walker')
    : (diffMean <= 0 ? 'temi' : 'walker');
  return {
    n,
    temi_mean: fixed(temiMean),
    temi_sd: fixed(sd(temi)),
    walker_mean: fixed(walkerMean),
    walker_sd: fixed(sd(walker)),
    mean_difference_temi_minus_walker: fixed(diffMean),
    ci95_low: fixed(diffMean - ci),
    ci95_high: fixed(diffMean + ci),
    cohens_dz: fixed(dz),
    favors
  };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function fmt(value, unit) {
  if (unit === '%') return pct(value);
  if (unit === 'ms') return `${Math.round(value)} ms`;
  return `${Number(value).toFixed(unit === 'pts' ? 1 : 2)} ${unit}`;
}

function buildSvg(stats, questionnaireSummary, preferenceCounts) {
  const width = 1500;
  const height = 1060;
  const margin = { left: 92, right: 42, top: 86, bottom: 70 };
  const chartW = 610;
  const chartH = 300;
  const barX = 820;
  const barY = 136;
  const barW = 560;
  const rowH = 44;
  const teal = '#176b72';
  const coral = '#c15b3e';
  const ink = '#122630';
  const muted = '#61717b';
  const grid = '#d7e2e7';
  const paper = '#f6f8f9';

  const score = stats.find((item) => item.metric === 'overall_interaction_score');
  const attention = stats.find((item) => item.metric === 'attention_rate');
  const latency = stats.find((item) => item.metric === 'average_question_generation_latency_ms');
  const tts = stats.find((item) => item.metric === 'average_tts_start_latency_ms');
  const timeout = stats.find((item) => item.metric === 'no_speech_timeout_rate');
  const radarMetrics = ['overall_interaction_score', 'attention_rate', 'central_gaze_rate', 'valid_answer_rate'];
  const radarValues = radarMetrics.map((key) => {
    const item = stats.find((row) => row.metric === key);
    const max = key === 'overall_interaction_score' ? 100 : 1;
    return {
      label: item.label,
      temi: item.temi_mean / max,
      walker: item.walker_mean / max
    };
  });

  const rows = [
    score,
    attention,
    stats.find((item) => item.metric === 'central_gaze_rate'),
    stats.find((item) => item.metric === 'valid_answer_rate'),
    latency,
    tts,
    timeout
  ];
  const maxDiff = Math.max(...rows.map((row) => Math.abs(row.mean_difference_temi_minus_walker)));
  const zeroX = barX + barW / 2;

  const diffRows = rows.map((row, index) => {
    const y = barY + index * rowH;
    const normalized = (row.mean_difference_temi_minus_walker / maxDiff) * (barW / 2 - 70);
    const x1 = normalized >= 0 ? zeroX : zeroX + normalized;
    const w = Math.abs(normalized);
    const color = row.favors === 'temi' ? teal : coral;
    return `<g>
      <text x="${barX - 20}" y="${y + 23}" text-anchor="end" font-size="18" fill="${ink}">${row.label}</text>
      <rect x="${x1}" y="${y + 8}" width="${Math.max(2, w)}" height="18" rx="3" fill="${color}" opacity="0.88"/>
      <text x="${normalized >= 0 ? x1 + w + 8 : x1 - 8}" y="${y + 23}" text-anchor="${normalized >= 0 ? 'start' : 'end'}" font-size="16" fill="${muted}">${row.unit === '%' ? pct(row.mean_difference_temi_minus_walker) : Math.round(row.mean_difference_temi_minus_walker)}</text>
    </g>`;
  }).join('\n');

  const radarCx = 376;
  const radarCy = 575;
  const radarR = 150;
  const axis = radarValues.map((_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / radarValues.length;
    return { x: radarCx + Math.cos(angle) * radarR, y: radarCy + Math.sin(angle) * radarR, angle };
  });
  const polygon = (robot) => radarValues.map((item, index) => {
    const r = item[robot] * radarR;
    return `${radarCx + Math.cos(axis[index].angle) * r},${radarCy + Math.sin(axis[index].angle) * r}`;
  }).join(' ');
  const radarLabels = radarValues.map((item, index) => {
    const x = radarCx + Math.cos(axis[index].angle) * (radarR + 34);
    const y = radarCy + Math.sin(axis[index].angle) * (radarR + 34);
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="16" fill="${muted}">${item.label.replace(' rate', '')}</text>`;
  }).join('\n');

  const qx = 820;
  const qy = 560;
  const qBars = questionnaireMetrics.map((metric, index) => {
    const value = questionnaireSummary[metric.key];
    const max = metric.key === 'sus_score' ? 100 : metric.key === 'nasa_tlx_mean' ? 7 : 5;
    const w = (value / max) * 410;
    return `<g>
      <text x="${qx}" y="${qy + index * 54}" font-size="18" fill="${ink}">${metric.label}</text>
      <rect x="${qx + 230}" y="${qy + index * 54 - 18}" width="410" height="18" rx="4" fill="${grid}"/>
      <rect x="${qx + 230}" y="${qy + index * 54 - 18}" width="${w}" height="18" rx="4" fill="${metric.key === 'nasa_tlx_mean' ? coral : teal}" opacity="0.9"/>
      <text x="${qx + 656}" y="${qy + index * 54 - 3}" font-size="16" fill="${muted}">${value.toFixed(metric.key === 'sus_score' ? 1 : 2)} ${metric.unit}</text>
    </g>`;
  }).join('\n');

  const totalPrefs = Object.values(preferenceCounts).reduce((sum, value) => sum + value, 0);
  const prefStart = 845;
  let cursor = 0;
  const prefSegments = ['temi', 'walker', 'both'].map((key) => {
    const value = preferenceCounts[key] ?? 0;
    const w = totalPrefs ? (value / totalPrefs) * 520 : 0;
    const x = qx + cursor;
    cursor += w;
    const color = key === 'temi' ? teal : key === 'walker' ? coral : '#78909c';
    return `<rect x="${x}" y="${prefStart}" width="${w}" height="28" fill="${color}" opacity="0.9"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${paper}"/>
  <text x="${margin.left}" y="58" font-size="34" font-weight="700" fill="${ink}">Temi vs Walker: Objective Logs + Questionnaire Outcomes</text>
  <text x="${margin.left}" y="88" font-size="18" fill="${muted}">Counterbalanced dataset, n=10 participants, 20 robot sessions, 10 post-study questionnaires</text>

  <g transform="translate(${margin.left},136)">
    <text x="0" y="-24" font-size="22" font-weight="700" fill="${ink}">A. Paired performance summary</text>
    <line x1="0" x2="${chartW}" y1="${chartH}" y2="${chartH}" stroke="${grid}"/>
    <line x1="0" x2="${chartW}" y1="0" y2="0" stroke="${grid}"/>
    <text x="0" y="${chartH + 34}" font-size="16" fill="${muted}">Overall interaction score</text>
    <text x="${chartW}" y="${chartH + 34}" text-anchor="end" font-size="16" fill="${muted}">Attention rate</text>
    <circle cx="98" cy="${chartH - score.temi_mean * 2.4}" r="10" fill="${teal}"/>
    <circle cx="98" cy="${chartH - score.walker_mean * 2.4}" r="10" fill="${coral}"/>
    <circle cx="${chartW - 98}" cy="${chartH - attention.temi_mean * chartH}" r="10" fill="${teal}"/>
    <circle cx="${chartW - 98}" cy="${chartH - attention.walker_mean * chartH}" r="10" fill="${coral}"/>
    <line x1="98" y1="${chartH - score.temi_mean * 2.4}" x2="${chartW - 98}" y2="${chartH - attention.temi_mean * chartH}" stroke="${teal}" stroke-width="4" opacity="0.75"/>
    <line x1="98" y1="${chartH - score.walker_mean * 2.4}" x2="${chartW - 98}" y2="${chartH - attention.walker_mean * chartH}" stroke="${coral}" stroke-width="4" opacity="0.75"/>
    <text x="122" y="${chartH - score.temi_mean * 2.4 - 10}" font-size="18" fill="${ink}">Temi ${score.temi_mean.toFixed(1)}</text>
    <text x="122" y="${chartH - score.walker_mean * 2.4 + 26}" font-size="18" fill="${ink}">Walker ${score.walker_mean.toFixed(1)}</text>
    <text x="${chartW - 78}" y="${chartH - attention.temi_mean * chartH - 12}" font-size="18" fill="${ink}">${pct(attention.temi_mean)}</text>
    <text x="${chartW - 78}" y="${chartH - attention.walker_mean * chartH + 28}" font-size="18" fill="${ink}">${pct(attention.walker_mean)}</text>
  </g>

  <g>
    <text x="${barX - 20}" y="112" font-size="22" font-weight="700" fill="${ink}">B. Paired mean differences</text>
    <text x="${barX - 20}" y="140" font-size="16" fill="${muted}">Temi minus Walker; lower is better for latency and timeout metrics</text>
    <line x1="${zeroX}" y1="${barY - 8}" x2="${zeroX}" y2="${barY + rows.length * rowH - 8}" stroke="${ink}" opacity="0.28"/>
    ${diffRows}
  </g>

  <g>
    <text x="${margin.left}" y="508" font-size="22" font-weight="700" fill="${ink}">C. Objective metric profile</text>
    <circle cx="${radarCx}" cy="${radarCy}" r="${radarR}" fill="none" stroke="${grid}"/>
    <circle cx="${radarCx}" cy="${radarCy}" r="${radarR * 0.66}" fill="none" stroke="${grid}"/>
    <circle cx="${radarCx}" cy="${radarCy}" r="${radarR * 0.33}" fill="none" stroke="${grid}"/>
    ${axis.map((point) => `<line x1="${radarCx}" y1="${radarCy}" x2="${point.x}" y2="${point.y}" stroke="${grid}"/>`).join('\n')}
    <polygon points="${polygon('temi')}" fill="${teal}" opacity="0.22" stroke="${teal}" stroke-width="3"/>
    <polygon points="${polygon('walker')}" fill="${coral}" opacity="0.18" stroke="${coral}" stroke-width="3"/>
    ${radarLabels}
    <rect x="146" y="774" width="18" height="18" fill="${teal}" opacity="0.75"/><text x="174" y="789" font-size="17" fill="${ink}">Temi</text>
    <rect x="246" y="774" width="18" height="18" fill="${coral}" opacity="0.75"/><text x="274" y="789" font-size="17" fill="${ink}">Walker</text>
  </g>

  <g>
    <text x="${qx}" y="508" font-size="22" font-weight="700" fill="${ink}">D. Questionnaire outcomes</text>
    <text x="${qx}" y="536" font-size="16" fill="${muted}">Questionnaire is participant-level after both robot sessions</text>
    ${qBars}
    <text x="${qx}" y="${prefStart - 18}" font-size="18" fill="${ink}">Preferred robot</text>
    <g>${prefSegments}</g>
    <text x="${qx}" y="${prefStart + 58}" font-size="16" fill="${ink}">Temi ${preferenceCounts.temi ?? 0}</text>
    <text x="${qx + 150}" y="${prefStart + 58}" font-size="16" fill="${ink}">Walker ${preferenceCounts.walker ?? 0}</text>
    <text x="${qx + 320}" y="${prefStart + 58}" font-size="16" fill="${ink}">Both ${preferenceCounts.both ?? 0}</text>
  </g>

  <text x="${margin.left}" y="1008" font-size="17" fill="${muted}">Interpretation: Temi shows stronger objective smoothness and attention in this dataset; questionnaire scores are high overall and mainly support preference-level conclusions.</text>
</svg>`;
}

async function main() {
  const sessionRows = parseCsv(await readFile(sessionsCsvPath, 'utf8'));
  const questionnaireRows = parseCsv(await readFile(questionnaireCsvPath, 'utf8'));
  const grouped = new Map();
  for (const row of sessionRows) {
    const id = row.participant_id;
    if (!grouped.has(id)) grouped.set(id, {});
    const target = grouped.get(id);
    const family = row.robot_family;
    target[family] = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, number(value) ?? value]));
  }

  const questionnaireByParticipant = new Map(questionnaireRows.map((row) => [row.participant_id, row]));
  const pairs = [...grouped.entries()]
    .filter(([, value]) => value.temi && value.walker)
    .map(([participantId, sessions]) => ({
      participant_id: participantId,
      participant_name: sessions.temi.participant_name || sessions.walker.participant_name,
      temi: sessions.temi,
      walker: sessions.walker,
      questionnaire: questionnaireByParticipant.get(participantId) ?? {}
    }));

  const objectiveStats = objectiveMetrics.map((metric) => ({
    metric: metric.key,
    label: metric.label,
    unit: metric.unit,
    higher_better: metric.higherBetter,
    ...pairedStats(pairs, metric.key, metric.higherBetter)
  }));

  const questionnaireSummary = Object.fromEntries(questionnaireMetrics.map((metric) => [
    metric.key,
    mean(questionnaireRows.map((row) => number(row[metric.key])).filter(Number.isFinite))
  ]));
  const preferenceCounts = questionnaireRows.reduce((counts, row) => {
    const key = row.preferred_robot || 'none';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const participantRows = pairs.map((pair) => {
    const row = {
      participant_id: pair.participant_id,
      participant_name: pair.participant_name,
      session_order: pair.questionnaire.session_order ?? '',
      preferred_robot: pair.questionnaire.preferred_robot ?? '',
      sus_score: number(pair.questionnaire.sus_score),
      nasa_tlx_mean: number(pair.questionnaire.nasa_tlx_mean),
      sassi_overall_mean: number(pair.questionnaire.sassi_overall_mean)
    };
    for (const metric of objectiveMetrics) {
      row[`temi_${metric.key}`] = pair.temi[metric.key];
      row[`walker_${metric.key}`] = pair.walker[metric.key];
      row[`diff_${metric.key}`] = fixed(pair.temi[metric.key] - pair.walker[metric.key]);
    }
    return row;
  });

  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'participant-level-combined.csv'), toCsv(participantRows), 'utf8');
  await writeFile(join(outputRoot, 'objective-paired-statistics.csv'), toCsv(objectiveStats), 'utf8');
  await writeFile(join(outputRoot, 'combined-summary.json'), JSON.stringify({
    n_participants: pairs.length,
    n_sessions: sessionRows.length,
    objective_stats: objectiveStats,
    questionnaire_summary: Object.fromEntries(Object.entries(questionnaireSummary).map(([key, value]) => [key, fixed(value)])),
    preference_counts: preferenceCounts
  }, null, 2), 'utf8');

  const svg = buildSvg(objectiveStats, questionnaireSummary, preferenceCounts);
  await writeFile(join(outputRoot, 'temi-walker-combined-dashboard.svg'), svg, 'utf8');

  const top = objectiveStats.slice(0, 6).map((row) => (
    `| ${row.label} | ${row.temi_mean} | ${row.walker_mean} | ${row.mean_difference_temi_minus_walker} | ${row.ci95_low} to ${row.ci95_high} | ${row.cohens_dz} | ${row.favors} |`
  )).join('\n');

  const report = `# Temi vs Walker Combined Analysis

This analysis combines robot interaction logs with post-study questionnaire responses.

## Dataset

- Participants: ${pairs.length}
- Robot sessions: ${sessionRows.length}
- Questionnaire responses: ${questionnaireRows.length}
- Design: within-subject, counterbalanced robot order

## Objective Paired Results

| Metric | Temi mean | Walker mean | Temi-Walker | 95% CI | Cohen's dz | Favors |
|---|---:|---:|---:|---:|---:|---|
${top}

## Questionnaire Summary

- Mean SUS usability: ${questionnaireSummary.sus_score.toFixed(1)} / 100
- Mean NASA-TLX workload: ${questionnaireSummary.nasa_tlx_mean.toFixed(2)} / 7
- Mean SASSI overall: ${questionnaireSummary.sassi_overall_mean.toFixed(2)} / 5
- Preferred robot: Temi ${preferenceCounts.temi ?? 0}, Walker ${preferenceCounts.walker ?? 0}, Both ${preferenceCounts.both ?? 0}

## Interpretation

Temi performs better on the main objective indicators in this dataset: higher overall interaction score, stronger attention rate, and lower question-generation and speech-start latency. Walker is still usable, but shows a larger latency burden and more timeout risk. The questionnaire responses indicate high overall usability and generally positive experience, while the preference distribution leans toward Temi.

## Important Note

The questionnaire is collected once after both robot conditions, so it supports overall subjective usability and preference analysis. It should not be treated as two independent robot-specific questionnaire scores unless users complete one questionnaire after each robot condition.
`;
  await writeFile(join(outputRoot, 'combined-robot-analysis-report.md'), report, 'utf8');
  console.log(`Wrote combined analysis to ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
