import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const questionnaireRoot = join(root, 'outputs', 'comparative-questionnaires');
const sourceCsv = join(root, 'outputs', 'questionnaires', 'all-questionnaire-responses.csv');

const SUS_IDS = Array.from({ length: 10 }, (_, index) => `sus_q${index + 1}`);
const TLX_IDS = ['tlx_mental_demand', 'tlx_physical_demand', 'tlx_temporal_demand', 'tlx_performance', 'tlx_effort', 'tlx_frustration'];
const SASSI_GROUPS = {
  accuracy: ['accuracy_1', 'accuracy_2', 'accuracy_3', 'accuracy_4', 'accuracy_5', 'accuracy_6', 'accuracy_7', 'accuracy_8'],
  likeability: ['likeability_1', 'likeability_2', 'likeability_3', 'likeability_4', 'likeability_5', 'likeability_6', 'likeability_7', 'likeability_8'],
  cognitive_demand: ['cognitive_demand_1', 'cognitive_demand_2', 'cognitive_demand_3', 'cognitive_demand_4', 'cognitive_demand_5'],
  annoyance: ['annoyance_1', 'annoyance_2', 'annoyance_3', 'annoyance_4', 'annoyance_5'],
  habitability: ['habitability_1', 'habitability_2', 'habitability_3', 'habitability_4'],
  speed: ['speed_1', 'speed_2']
};

const positiveSus = new Set(['sus_q1', 'sus_q3', 'sus_q5', 'sus_q7', 'sus_q9']);
const positiveSassi = new Set([
  'accuracy_1', 'accuracy_5', 'accuracy_6', 'accuracy_7', 'accuracy_8',
  'likeability_1', 'likeability_2', 'likeability_3', 'likeability_4', 'likeability_5', 'likeability_6', 'likeability_7', 'likeability_8',
  'cognitive_demand_1', 'cognitive_demand_3', 'cognitive_demand_5',
  'habitability_2',
  'speed_1'
]);

const participants = [
  { id: 'P01', name: 'Alex Chen', age: 68, gender: 'male', order: 'temi_first', preferred: 'temi' },
  { id: 'P02', name: 'Maya Patel', age: 71, gender: 'female', order: 'walker_first', preferred: 'temi' },
  { id: 'P03', name: 'Daniel Wong', age: 66, gender: 'male', order: 'temi_first', preferred: 'both' },
  { id: 'P04', name: 'Sophia Liu', age: 74, gender: 'female', order: 'walker_first', preferred: 'temi' },
  { id: 'P05', name: 'Ethan Roberts', age: 69, gender: 'male', order: 'temi_first', preferred: 'walker' },
  { id: 'P06', name: 'Grace Kim', age: 72, gender: 'female', order: 'walker_first', preferred: 'temi' },
  { id: 'P07', name: 'Oliver Smith', age: 70, gender: 'male', order: 'temi_first', preferred: 'both' },
  { id: 'P08', name: 'Nina Zhao', age: 67, gender: 'female', order: 'walker_first', preferred: 'temi' },
  { id: 'P09', name: 'Harry Wilson', age: 76, gender: 'male', order: 'temi_first', preferred: 'temi' },
  { id: 'P10', name: 'Lily Brown', age: 65, gender: 'female', order: 'walker_first', preferred: 'both' }
];

const preferenceReasons = {
  temi: [
    'The voice felt clearer and the conversation moved more smoothly.',
    'It was easier to follow the questions and stay focused on the photo.',
    'The interaction felt calm, simple, and predictable.'
  ],
  walker: [
    'The physical presence felt more engaging and memorable.',
    'The larger robot felt more expressive during the interaction.'
  ],
  both: [
    'Both robots were useful in different ways.',
    'The experience was similar overall, with small differences in voice and timing.'
  ]
};

let seed = 20260814;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function scoreSus(values) {
  const total = SUS_IDS.reduce((sum, id, index) => {
    const value = values[id];
    return sum + (index % 2 === 0 ? value - 1 : 5 - value);
  }, 0);
  return Number((total * 2.5).toFixed(1));
}

function mean(values) {
  return Number((values.reduce((sum, value) => sum + Number(value), 0) / values.length).toFixed(3));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(header, row) {
  return header.map((key) => csvEscape(row[key])).join(',');
}

function localTimestamp(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(iso)).replace(',', ',');
}

function folderTimestamp(iso) {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

function safeName(name) {
  return name.replace(/[^a-z0-9_-]+/gi, '');
}

function choose(list) {
  return list[Math.floor(random() * list.length)];
}

function buildLikertResponses(baseQuality) {
  const sus = {};
  for (const id of SUS_IDS) {
    const positive = positiveSus.has(id);
    const center = positive ? baseQuality : 6 - baseQuality;
    sus[id] = clampInt(center + (random() - 0.5) * 1.15, 1, 5);
  }

  const sassi = {};
  for (const ids of Object.values(SASSI_GROUPS)) {
    for (const id of ids) {
      const positive = positiveSassi.has(id);
      const center = positive ? baseQuality : 6 - baseQuality;
      sassi[id] = clampInt(center + (random() - 0.5) * 1.35, 1, 5);
    }
  }

  const tlxBase = 8 - baseQuality;
  const tlx = {
    tlx_mental_demand: clampInt(tlxBase + (random() - 0.5) * 1.7, 1, 7),
    tlx_physical_demand: clampInt(tlxBase - 1.2 + (random() - 0.5) * 1.3, 1, 7),
    tlx_temporal_demand: clampInt(tlxBase - 0.2 + (random() - 0.5) * 1.6, 1, 7),
    tlx_performance: clampInt(baseQuality + 1.0 + (random() - 0.5) * 1.0, 1, 7),
    tlx_effort: clampInt(tlxBase + (random() - 0.5) * 1.6, 1, 7),
    tlx_frustration: clampInt(tlxBase - 1.5 + (random() - 0.5) * 1.5, 1, 7)
  };

  return { sus, tlx, sassi };
}

function buildRow(header, participant, index) {
  const qualityByPreference = { temi: 4.45, both: 4.2, walker: 4.05 };
  const baseQuality = qualityByPreference[participant.preferred] + (random() - 0.5) * 0.45;
  const responses = buildLikertResponses(baseQuality);
  const submitted = new Date(Date.UTC(2026, 7, 15, 11 + index, 10 + index * 3, 20 + index)).toISOString();
  const folderName = `${safeName(participant.name)}_${folderTimestamp(submitted)}_both`;
  const sassiMeans = Object.fromEntries(Object.entries(SASSI_GROUPS).map(([group, ids]) => [
    group,
    mean(ids.map((id) => responses.sassi[id]))
  ]));

  const row = Object.fromEntries(header.map((key) => [key, '']));
  Object.assign(row, {
    questionnaire_id: randomUUID(),
    folder_name: folderName,
    submitted_at: submitted,
    submitted_at_local: localTimestamp(submitted),
    participant_id: participant.id,
    participant_name: participant.name,
    age: participant.age,
    gender: participant.gender,
    robot_used: 'both',
    session_order: participant.order,
    session_date: '2026-08-15',
    consent_participate: true,
    consent_audio: true,
    consent_camera_attention: true,
    sus_score: scoreSus(responses.sus),
    nasa_tlx_mean: mean(Object.values(responses.tlx)),
    sassi_overall_mean: mean(Object.values(responses.sassi)),
    sassi_mean_accuracy: sassiMeans.accuracy,
    sassi_mean_likeability: sassiMeans.likeability,
    sassi_mean_cognitive_demand: sassiMeans.cognitive_demand,
    sassi_mean_annoyance: sassiMeans.annoyance,
    sassi_mean_habitability: sassiMeans.habitability,
    sassi_mean_speed: sassiMeans.speed,
    preferred_robot: participant.preferred,
    preference_reason: choose(preferenceReasons[participant.preferred]),
    influential_aspects: choose([
      'Voice clarity, response timing, and ease of following the instructions.',
      'Question quality, photo relevance, and smooth turn-taking.',
      'Comfort, screen readability, and how naturally the robot responded.'
    ]),
    disliked_aspects: choose([
      'Occasional waiting before the next question.',
      'Some speech recognition errors in longer answers.',
      'No major issue, but the timing could be smoother.'
    ]),
    improvement_suggestions: choose([
      'Make question generation faster and improve speech recognition robustness.',
      'Keep the robot response timing consistent and make voice prompts shorter.',
      'Add clearer progress feedback during photo upload and conversation.'
    ]),
    ...responses.sus,
    ...responses.tlx,
    ...responses.sassi
  });
  return row;
}

async function main() {
  const content = await readFile(sourceCsv, 'utf8');
  const [headerLine] = content.trim().split(/\r?\n/);
  const header = headerLine.split(',');
  const rows = participants.map((participant, index) => buildRow(header, participant, index));

  await mkdir(questionnaireRoot, { recursive: true });
  const aggregatePath = join(questionnaireRoot, 'all-questionnaire-responses.csv');
  await writeFile(aggregatePath, [header.join(','), ...rows.map((row) => csvLine(header, row))].join('\n') + '\n', 'utf8');

  for (const row of rows) {
    const folder = join(questionnaireRoot, row.folder_name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'questionnaire-response.csv'), [header.join(','), csvLine(header, row)].join('\n') + '\n', 'utf8');
    await writeFile(join(folder, 'questionnaire-response.json'), JSON.stringify(row, null, 2), 'utf8');
  }

  await writeFile(join(questionnaireRoot, 'README.txt'), [
    'Demo questionnaire responses generated for analysis only.',
    'The file structure follows outputs/questionnaires but is intentionally stored separately.',
    `Generated rows: ${rows.length}`
  ].join('\n') + '\n', 'utf8');

  console.log(`Wrote ${rows.length} questionnaire rows to ${aggregatePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
