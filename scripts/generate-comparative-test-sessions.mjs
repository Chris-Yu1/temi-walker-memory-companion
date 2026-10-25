import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const outputRoot = join(process.cwd(), 'outputs', 'comparative-test-sessions');
const robots = {
  temi: {
    robot_id: 'temi-v3-192.168.1.109',
    robot_family: 'temi',
    audio_input_source: 'temi_microphone_or_browser',
    audio_output_source: 'temi_speaker_or_browser',
    vision_source: 'temi_camera_or_browser'
  },
  walker: {
    robot_id: 'walker-192.168.4.1',
    robot_family: 'walker',
    audio_input_source: 'walker_microphone_or_browser',
    audio_output_source: 'walker_speaker_or_browser',
    vision_source: 'walker_camera_or_browser'
  }
};

const users = [
  { name: 'Alex Chen', age: 24, gender: 'male', order: ['temi', 'walker'] },
  { name: 'Maya Patel', age: 31, gender: 'female', order: ['walker', 'temi'] },
  { name: 'Daniel Wong', age: 27, gender: 'male', order: ['temi', 'walker'] },
  { name: 'Sophia Liu', age: 22, gender: 'female', order: ['walker', 'temi'] },
  { name: 'Ethan Roberts', age: 35, gender: 'male', order: ['temi', 'walker'] },
  { name: 'Grace Kim', age: 29, gender: 'female', order: ['walker', 'temi'] },
  { name: 'Oliver Smith', age: 41, gender: 'male', order: ['temi', 'walker'] },
  { name: 'Nina Zhao', age: 26, gender: 'female', order: ['walker', 'temi'] },
  { name: 'Harry Wilson', age: 38, gender: 'male', order: ['temi', 'walker'] },
  { name: 'Lily Brown', age: 33, gender: 'female', order: ['walker', 'temi'] }
];

const photoCases = [
  {
    description: 'A small blue car parked outside a row of trees on a calm street.',
    label: 'Generic',
    questions: [
      'Where do you think this calm street might be?',
      'When do you remember taking a drive on a quiet street?',
      'Who might you have travelled with in a car like this?',
      'What thoughts does this blue car bring to your mind?'
    ],
    answers: [
      'It looks like somewhere near my neighbourhood.',
      'I remember driving on streets like this last summer.',
      'I often travelled with my family in a small car.',
      'It brings back a comfortable memory.'
    ]
  },
  {
    description: 'A family dining table with plates, tea cups, and a birthday cake.',
    label: 'Personal',
    questions: [
      'Where might this family meal have taken place?',
      'Can you remember what time of year this celebration might be?',
      'Who do the people around a table like this remind you of?',
      'What part of this birthday scene feels most familiar to you?'
    ],
    answers: [
      'It reminds me of dinner at my auntie house.',
      'It was probably around winter holiday time.',
      'It makes me think about my parents and sister.',
      'The cake and tea cups feel very familiar.'
    ]
  },
  {
    description: 'A beach at sunset with people walking near the water.',
    label: 'Generic',
    questions: [
      'Where do you think this beach might be?',
      'When would you most enjoy walking near the water like this?',
      'Who would you like to share a sunset walk with?',
      'What mood does this sunset scene create for you?'
    ],
    answers: [
      'It could be a beach I visited on holiday.',
      'I like this kind of walk in the evening.',
      'I would go there with my close friends.',
      'It feels peaceful and warm.'
    ]
  },
  {
    description: 'A red bicycle leaning against a brick wall near a small garden.',
    label: 'Generic',
    questions: [
      'Where do you think this quiet garden path might be?',
      'When do you remember seeing bicycles like this most often?',
      'Who might you have enjoyed a bicycle ride with in the past?',
      'What feeling does this red bicycle bring to your mind?'
    ],
    answers: [
      'It looks like a place near my old school.',
      'Maybe in spring when the weather was nice.',
      'I used to ride with my cousin after class.',
      'It makes me feel relaxed and nostalgic.'
    ]
  },
  {
    description: 'A park bench under yellow autumn trees with fallen leaves on the ground.',
    label: 'Generic',
    questions: [
      'Where might this park bench be located?',
      'What season does this photo make you think of?',
      'Who would you sit with on a bench like this?',
      'What feeling do the autumn leaves bring to you?'
    ],
    answers: [
      'It looks like a park near a library.',
      'It clearly makes me think of autumn.',
      'I would sit there with an old friend.',
      'It feels quiet and thoughtful.'
    ]
  }
];

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const allRows = [];
const baseStart = Date.UTC(2026, 7, 15, 9, 0, 0);

users.forEach((user, userIndex) => {
  user.order.forEach((robotKey, orderIndex) => {
    const robot = robots[robotKey];
    const photo = photoCases[userIndex % photoCases.length];
    const startDate = new Date(baseStart + userIndex * 36 * 60_000 + orderIndex * 14 * 60_000);
    const context = makeSessionContext({ user, userIndex, robot, robotKey, orderIndex, photo, startDate });
    writeSession(context);
    allRows.push(context.comparisonRow);
  });
});

writeJson(join(outputRoot, 'comparison-index.json'), {
  participant_count: users.length,
  session_count: allRows.length,
  design: 'within-subject paired robot comparison data',
  conditions: ['temi', 'walker'],
  rows: allRows
});
writeCsv(join(outputRoot, 'comparison-index.csv'), allRows);
writeFileSync(join(outputRoot, 'README.txt'), [
  'Analysis demo sessions for paired temi-vs-walker comparison.',
  'Directory intentionally separated from outputs/test-sessions.',
  'Each participant has two sessions with counterbalanced robot order.',
  ''
].join('\n'));

console.log(`Created ${allRows.length} paired demo sessions for ${users.length} users in ${outputRoot}`);

function makeSessionContext({ user, userIndex, robot, robotKey, orderIndex, photo, startDate }) {
  const sessionId = randomUUID();
  const participantId = `P${String(userIndex + 1).padStart(2, '0')}`;
  const compactName = user.name.replace(/\s+/g, '');
  const folderName = `${participantId}_${compactName}_${formatFolderStamp(startDate)}_${robot.robot_id}`;
  const root = join(outputRoot, folderName);
  const photoId = `phone-photo-${participantId.toLowerCase()}-${orderIndex}`;
  const robotBias = robotKey === 'temi' ? 1 : -1;
  const durationMs = jitter(100000, 138000) + (robotKey === 'walker' ? jitter(5000, 15000) : 0);
  const startedAt = startDate;
  const endedAt = new Date(startDate.getTime() + durationMs);
  const questionLatencies = Array.from({ length: 4 }, () => jitter(robotKey === 'temi' ? 1300 : 1550, robotKey === 'temi' ? 2900 : 3500));
  const ttsLatencies = Array.from({ length: 4 }, () => jitter(robotKey === 'temi' ? 700 : 1000, robotKey === 'temi' ? 1900 : 2600));
  const playbackDurations = [jitter(3400, 5200), jitter(6500, 9300), jitter(6800, 9600), jitter(5600, 7800)];
  const answerDurations = Array.from({ length: 4 }, () => jitter(8500, 15500));
  const answerWordCounts = photo.answers.map((answer) => Math.max(4, answer.split(/\s+/).length + jitter(-1, 3)));
  const topicCoverage = { where: 1, when: 1, who: 1, others: 1 };
  const attentionRate = clamp(round2(jitter(robotKey === 'temi' ? 86 : 76, robotKey === 'temi' ? 99 : 94) / 100), 0.72, 1);
  const centralGazeRate = clamp(round2(attentionRate + jitter(-3, 5) / 100), 0.7, 1);
  const validAnswerRate = Math.random() < (robotKey === 'temi' ? 0.08 : 0.18) ? 0.75 : 1;
  const noSpeechTimeoutRate = validAnswerRate < 1 ? 0.25 : 0;
  const systemFailures = {
    speaker_failure_count: 0,
    microphone_failure_count: Math.random() < (robotKey === 'temi' ? 0.08 : 0.16) ? 1 : 0,
    camera_failure_count: Math.random() < 0.08 ? 1 : 0,
    websocket_reconnect_count: Math.random() < 0.18 ? 1 : 0
  };
  const endpointCount = robotKey === 'temi' ? jitter(1, 3) : jitter(1, 2);
  const turnTakingSummary = {
    total_decisions: 4,
    decision_distribution: { '1': endpointCount, '2': 4 - endpointCount },
    trigger_distribution: { [`${robotKey}-new-transcript`]: 4 },
    endpoint_count: endpointCount,
    keep_listening_count: 0,
    uncertain_count: 4 - endpointCount,
    average_pause_time_seconds: round2(jitter(0, 90) / 100),
    max_pause_time_seconds: round2(jitter(80, 260) / 100),
    average_server_latency_ms: jitter(robotKey === 'temi' ? 1200 : 1450, robotKey === 'temi' ? 2200 : 2800),
    average_primary_model_latency_ms: jitter(robotKey === 'temi' ? 1200 : 1450, robotKey === 'temi' ? 2200 : 2800)
  };
  const score = round2(clamp(86 + robotBias * 2 + attentionRate * 4 - noSpeechTimeoutRate * 10 - systemFailures.microphone_failure_count * 2 + jitter(-250, 250) / 100, 72, 96));
  const turns = makeTurns({ sessionId, participantId, user, robot, photoId, photo, startedAt, questionLatencies, ttsLatencies, playbackDurations, answerDurations, answerWordCounts, turnTakingSummary });
  const metrics = {
    session_id: sessionId,
    participant_id: participantId,
    test_order: orderIndex + 1,
    condition_order: user.order.join(' -> '),
    test_folder_name: folderName,
    participant_name: user.name,
    robot_id: robot.robot_id,
    robot_family: robot.robot_family,
    photo_id: photoId,
    completed: true,
    end_reason: 'themes_completed',
    started_at: iso(startedAt),
    started_at_local: local(startedAt),
    ended_at: iso(endedAt),
    ended_at_local: local(endedAt),
    session_duration_ms: durationMs,
    question_count: 4,
    answered_turn_count: 4,
    valid_answer_count: Math.round(validAnswerRate * 4),
    valid_answer_rate: validAnswerRate,
    no_speech_timeout_count: Math.round(noSpeechTimeoutRate * 4),
    no_speech_timeout_rate: noSpeechTimeoutRate,
    topic_coverage: topicCoverage,
    topic_coverage_rate: 1,
    follow_question_count: 3,
    average_question_generation_latency_ms: avg(questionLatencies),
    max_question_generation_latency_ms: Math.max(...questionLatencies),
    average_tts_start_latency_ms: avg(ttsLatencies),
    average_next_question_transition_ms: jitter(robotKey === 'temi' ? 6500 : 7500, robotKey === 'temi' ? 9800 : 11200),
    average_answer_duration_seconds: round2(avg(answerDurations) / 1000),
    average_answer_word_count: round2(avg(answerWordCounts)),
    attention_rate: attentionRate,
    attention_sample_count: jitter(30, 48),
    central_gaze_rate: centralGazeRate,
    turn_taking: turnTakingSummary,
    audio: { session_recording_path: join(root, '07_audio', 'session-recording.wav'), source_chunk_count: 8 },
    system_failures: systemFailures,
    overall_interaction_score: score
  };
  const comparisonRow = {
    participant_id: participantId,
    participant_name: user.name,
    test_order: orderIndex + 1,
    condition_order: user.order.join(' -> '),
    robot_id: robot.robot_id,
    robot_family: robot.robot_family,
    session_id: sessionId,
    test_folder_name: folderName,
    photo_id: photoId,
    completed: true,
    question_count: 4,
    valid_answer_rate: validAnswerRate,
    no_speech_timeout_rate: noSpeechTimeoutRate,
    attention_rate: attentionRate,
    central_gaze_rate: centralGazeRate,
    average_question_generation_latency_ms: metrics.average_question_generation_latency_ms,
    average_tts_start_latency_ms: metrics.average_tts_start_latency_ms,
    average_next_question_transition_ms: metrics.average_next_question_transition_ms,
    average_answer_duration_seconds: metrics.average_answer_duration_seconds,
    average_answer_word_count: metrics.average_answer_word_count,
    overall_interaction_score: score
  };
  return { user, participantId, robot, robotKey, orderIndex, photo, sessionId, folderName, root, photoId, startedAt, endedAt, durationMs, turns, metrics, comparisonRow };
}

function writeSession(c) {
  const dirs = ['00_session', '01_photos', '01_user-and-session', '02_events', '02_question-log', '03_answer-log', '03_questions', '04_answers', '04_headpose-eyegaze-log', '05_attention', '05_turn-taking-log', '06_audio', '06_turn-taking', '07_audio', '08_metrics'];
  dirs.forEach((dir) => mkdirSync(join(c.root, dir), { recursive: true }));
  const userProfile = makeUserProfile(c);
  const robotMetadata = {
    ...c.robot,
    platform_role: 'memory-companion-interaction-agent',
    comparison_group: c.robot.robot_id,
    recorded_at: iso(c.startedAt),
    recorded_at_local: local(c.startedAt)
  };
  const photoMetadata = { id: c.photoId, image_data_length: jitter(420000, 690000), image_description: c.photo.description, label: c.photo.label };
  const sessionMetadata = {
    session_id: c.sessionId,
    participant_id: c.participantId,
    test_order: c.orderIndex + 1,
    condition_order: c.user.order.join(' -> '),
    test_folder_name: c.folderName,
    output_dir: c.root,
    robot_id: c.robot.robot_id,
    photo_id: c.photoId,
    created_at: iso(c.startedAt),
    created_at_local: local(c.startedAt),
    updated_at: iso(c.endedAt),
    updated_at_local: local(c.endedAt),
    ended_at: iso(c.endedAt),
    ended_at_local: local(c.endedAt),
    end_reason: 'themes_completed',
    user_profile: userProfile,
    conversation_duration_minutes: 0,
    audio: { session_recording_path: join(c.root, '07_audio', 'session-recording.wav'), legacy_session_recording_path: join(c.root, '06_audio', 'session-recording.wav'), source_chunk_count: 8, updated_at: iso(c.endedAt), updated_at_local: local(c.endedAt) }
  };
  const questionEvents = c.turns.map(toQuestionEvent);
  const answerEvents = c.turns.map((turn) => toAnswerEvent(turn, c));
  const attentionSamples = makeAttentionSamples(c);
  const attentionSummary = summarizeAttention(attentionSamples);
  const turnTakingTraces = c.turns.map((turn, index) => makeTurnTakingTrace(turn, c, index));
  const audioEvents = c.turns.map((turn) => ({ turn: turn.turn, topic: turn.topic, question_event_code: turn.question_event.code, session_audio_path: join(c.root, '07_audio', 'session-recording.wav'), audio_source_chunks: [], audio_chunk_count: 2, answer_started_at: iso(turn.answerStart), answer_started_at_local: local(turn.answerStart), answer_ended_at: iso(turn.answerEnd), answer_ended_at_local: local(turn.answerEnd) }));
  const interactionTurns = c.turns.map((turn, index) => makeInteractionTurn(turn, c, index, attentionSummary));
  const summary = { ...sessionMetadata, photo: photoMetadata, turns: interactionTurns, metrics: c.metrics };

  writeJson(join(c.root, '00_session', 'robot-metadata.json'), robotMetadata);
  writeJson(join(c.root, '00_session', 'session-metadata.json'), sessionMetadata);
  writeJson(join(c.root, '00_session', 'user-profile.json'), userProfile);
  writeJson(join(c.root, '01_photos', 'photo-metadata.json'), photoMetadata);
  writeJson(join(c.root, '01_user-and-session', 'photo-metadata.json'), photoMetadata);
  writeJson(join(c.root, '01_user-and-session', 'session-metadata.json'), sessionMetadata);
  writeJsonl(join(c.root, '02_events', 'timeline-events.jsonl'), makeTimeline(c));
  writeJson(join(c.root, '02_question-log', 'question-events.json'), questionEvents);
  writeJson(join(c.root, '03_questions', 'question-events.json'), questionEvents);
  writeJson(join(c.root, '03_answer-log', 'answers.json'), answerEvents);
  writeJson(join(c.root, '04_answers', 'answer-events.json'), answerEvents);
  writeJson(join(c.root, '03_questions', 'interaction-turns.json'), interactionTurns);
  writeJson(join(c.root, '04_headpose-eyegaze-log', 'attention-samples.json'), attentionSamples);
  writeJson(join(c.root, '05_attention', 'attention-samples.json'), attentionSamples);
  writeJson(join(c.root, '05_attention', 'attention-summary.json'), attentionSummary);
  writeJson(join(c.root, '05_turn-taking-log', 'turn-taking-traces.json'), turnTakingTraces);
  writeJson(join(c.root, '06_turn-taking', 'turn-taking-traces.json'), turnTakingTraces);
  writeJson(join(c.root, '06_turn-taking', 'turn-taking-summary.json'), c.metrics.turn_taking);
  writeJson(join(c.root, '07_audio', 'audio-events.json'), audioEvents);
  writeJson(join(c.root, '08_metrics', 'session-metrics.json'), { ...c.metrics, attention_rate: attentionSummary.attention_rate, central_gaze_rate: attentionSummary.central_gaze_rate, attention_sample_count: attentionSummary.total_samples });
  writeJson(join(c.root, '08_metrics', 'comparison-row.json'), { ...c.comparisonRow, attention_rate: attentionSummary.attention_rate, central_gaze_rate: attentionSummary.central_gaze_rate });
  writeJson(join(c.root, 'session-summary.json'), summary);
  const wav = makeSilentWav(Math.max(90, Math.round(c.durationMs / 1000)));
  writeFileSync(join(c.root, '06_audio', 'session-recording.wav'), wav);
  writeFileSync(join(c.root, '07_audio', 'session-recording.wav'), wav);
}

function makeTurns({ sessionId, participantId, user, robot, photoId, photo, startedAt, questionLatencies, ttsLatencies, playbackDurations, answerDurations, answerWordCounts, turnTakingSummary }) {
  const topics = ['where', 'when', 'who', 'others'];
  let cursor = startedAt.getTime() + 1200;
  return topics.map((topic, index) => {
    const apiStart = new Date(cursor);
    const apiEnd = new Date(apiStart.getTime() + questionLatencies[index]);
    const spokenStart = new Date(apiEnd.getTime() + ttsLatencies[index]);
    const spokenEnd = new Date(spokenStart.getTime() + playbackDurations[index]);
    const answerStart = new Date(spokenEnd.getTime() + jitter(500, 1500));
    const answerEnd = new Date(answerStart.getTime() + answerDurations[index]);
    const answerSaved = new Date(answerEnd.getTime() + jitter(2200, 5800));
    const feedbackAt = new Date(answerSaved.getTime() + jitter(20, 120));
    cursor = feedbackAt.getTime() + jitter(800, 1800);
    return {
      session_id: sessionId,
      participant_id: participantId,
      participant_name: user.name,
      robot_id: robot.robot_id,
      robot_family: robot.robot_family,
      photo_id: photoId,
      turn: index + 1,
      topic,
      question_event: { code: index === 0 ? `${topic}-m1` : `${topic}-m1-f1`, topic, main_index: 1, follow_index: index === 0 ? 0 : 1, is_follow_question: index !== 0 },
      is_follow_question: index !== 0,
      question: photo.questions[index],
      answer: photo.answers[index],
      feedback: index === 3 ? 'Thank you for sharing that. We have finished this photo for now.' : 'Thank you for sharing that. Let us continue with the next part of the photo.',
      apiStart,
      apiEnd,
      spokenStart,
      spokenEnd,
      answerStart,
      answerEnd,
      answerSaved,
      feedbackAt,
      generationLatency: questionLatencies[index],
      ttsStartLatency: ttsLatencies[index],
      playbackDuration: playbackDurations[index],
      answerDuration: answerDurations[index],
      answerWordCount: answerWordCounts[index],
      endpointDecisionValue: index < turnTakingSummary.endpoint_count ? 1 : 2
    };
  });
}

function makeUserProfile(c) {
  return { name: c.user.name, age: c.user.age, memory_decline_level: 'mild', gender: c.user.gender, conversation_duration_minutes: 0, calibration: { head_pose: { yaw: round2(jitter(-450, 450) / 100), pitch: round2(jitter(-550, 350) / 100), roll: round2(jitter(-320, 240) / 100) }, eye_gaze: { x: round2(jitter(-240, 220) / 100), y: round2(jitter(-300, 220) / 100) }, samples: 50 } };
}

function toQuestionEvent(t) {
  return { turn: t.turn, topic: t.topic, question_event: t.question_event, question: t.question, feedback: t.feedback, question_generation: { api_started_at: iso(t.apiStart), api_started_at_local: local(t.apiStart), api_ended_at: iso(t.apiEnd), api_ended_at_local: local(t.apiEnd), api_latency_ms: t.generationLatency, fallback_reason: null }, question_at: iso(t.apiEnd), question_at_local: local(t.apiEnd), question_started_at: iso(t.spokenStart), question_started_at_local: local(t.spokenStart), question_ended_at: iso(t.spokenEnd), question_ended_at_local: local(t.spokenEnd), question_generation_latency_ms: t.generationLatency, question_tts_start_latency_ms: t.ttsStartLatency, question_playback_duration_ms: t.playbackDuration, feedback_at: iso(t.feedbackAt), feedback_at_local: local(t.feedbackAt) };
}

function toAnswerEvent(t, c) {
  return { turn: t.turn, topic: t.topic, question_event_code: t.question_event.code, question: t.question, answer: t.answer, answer_started_at: iso(t.answerStart), answer_started_at_local: local(t.answerStart), answer_ended_at: iso(t.answerEnd), answer_ended_at_local: local(t.answerEnd), answer_duration_ms: t.answerDuration, answer_word_count: t.answerWordCount, answer_saved_at: iso(t.answerSaved), answer_saved_at_local: local(t.answerSaved), endpoint_decision: makeTurnTakingTrace(t, c, t.turn - 1), session_audio_path: join(c.root, '07_audio', 'session-recording.wav'), audio_chunk_count: 2 };
}

function makeInteractionTurn(t, c, index, attention) {
  return { session_id: c.sessionId, participant_id: c.participantId, participant_name: c.user.name, robot_id: c.robot.robot_id, robot_family: c.robot.robot_family, photo_id: c.photoId, turn: t.turn, topic: t.topic, question_event_code: t.question_event.code, is_follow_question: t.is_follow_question, question: { text: t.question, generated_at: iso(t.apiEnd), generated_at_local: local(t.apiEnd), spoken_started_at: iso(t.spokenStart), spoken_started_at_local: local(t.spokenStart), spoken_ended_at: iso(t.spokenEnd), spoken_ended_at_local: local(t.spokenEnd), generation_latency_ms: t.generationLatency, tts_start_latency_ms: t.ttsStartLatency, playback_duration_ms: t.playbackDuration }, answer: { text: t.answer, started_at: iso(t.answerStart), started_at_local: local(t.answerStart), ended_at: iso(t.answerEnd), ended_at_local: local(t.answerEnd), saved_at: iso(t.answerSaved), saved_at_local: local(t.answerSaved), duration_ms: t.answerDuration, word_count: t.answerWordCount, is_no_response: false }, endpoint_decision: makeTurnTakingTrace(t, c, index), feedback: { text: t.feedback, generated_at: iso(t.feedbackAt), generated_at_local: local(t.feedbackAt) }, transition: { question_end_to_answer_start_ms: t.answerStart.getTime() - t.spokenEnd.getTime(), answer_end_to_feedback_ms: t.feedbackAt.getTime() - t.answerEnd.getTime() }, attention, audio: { session_audio_path: join(c.root, '07_audio', 'session-recording.wav'), audio_source_chunks: [], audio_chunk_count: 2 } };
}

function makeTurnTakingTrace(t, c, index) {
  const started = new Date(t.answerEnd.getTime() + jitter(700, 2500));
  const latency = jitter(850, 2600);
  const ended = new Date(started.getTime() + latency);
  return { captured_at: iso(ended), captured_at_local: local(ended), client_requested_at: iso(new Date(t.answerEnd.getTime() - jitter(2800, 5200))), client_requested_at_local: local(new Date(t.answerEnd.getTime() - jitter(2800, 5200))), server_started_at: iso(started), server_started_at_local: local(started), server_ended_at: iso(ended), server_ended_at_local: local(ended), server_latency_ms: latency, sequence: 8 + index, photo_id: c.photoId, turn: t.turn, received_sentence: t.answer, question: t.question, topic: t.topic, pause_time_seconds: round2(jitter(0, 120) / 100), decision: t.endpointDecisionValue, source: 'primary', trigger: `${c.robot.robot_family}-new-transcript`, primary_decision: t.endpointDecisionValue, secondary_decision: null, secondary_checked: false, primary_latency_ms: latency, secondary_latency_ms: null, endpoint_candidate_count: jitter(0, 1), unchanged_chunks: jitter(0, 1), has_new_transcript: true };
}

function makeAttentionSamples(c) {
  const samples = [];
  const count = c.metrics.attention_sample_count;
  for (let i = 0; i < count; i += 1) {
    const turn = c.turns[i % 4];
    const attentive = Math.random() < c.metrics.attention_rate;
    samples.push({ turn: turn.turn, topic: turn.topic, question_event_code: turn.question_event.code, captured_at: iso(new Date(turn.answerStart.getTime() + i * 1200)), head_direction: attentive ? (Math.random() < 0.25 ? 'down' : 'center') : (Math.random() < 0.5 ? 'left' : 'right'), eye_gaze_direction: Math.random() < c.metrics.central_gaze_rate ? 'central' : (Math.random() < 0.5 ? 'left' : 'right'), head_pose: { yaw: round2(jitter(-550, 550) / 100), pitch: round2(jitter(-150, 800) / 100), roll: round2(jitter(-500, 300) / 100) }, eye_gaze: { x: round2(jitter(-240, 240) / 100), y: round2(jitter(-120, 480) / 100) } });
  }
  return samples;
}

function summarizeAttention(samples) {
  const attentive = samples.filter((s) => s.eye_gaze_direction === 'central' && !['left', 'right'].includes(s.head_direction)).length;
  const central = samples.filter((s) => s.eye_gaze_direction === 'central').length;
  return { metric_definition: 'attention_rate = central eye gaze with no left/right head deviation divided by total attention samples', total_samples: samples.length, attentive_samples: attentive, attention_rate: round2(attentive / samples.length), central_gaze_samples: central, central_gaze_rate: round2(central / samples.length), head_direction_distribution: countBy(samples, 'head_direction'), eye_gaze_direction_distribution: countBy(samples, 'eye_gaze_direction') };
}

function makeTimeline(c) {
  const events = [{ timestamp: iso(c.startedAt), timestamp_local: local(c.startedAt), event: 'session_started', session_id: c.sessionId, participant_id: c.participantId, participant_name: c.user.name, robot_id: c.robot.robot_id, photo_id: c.photoId }];
  for (const t of c.turns) {
    events.push({ timestamp: iso(t.spokenStart), timestamp_local: local(t.spokenStart), event: 'question_spoken_start', session_id: c.sessionId, robot_id: c.robot.robot_id, photo_id: c.photoId, turn: t.turn, topic: t.topic, question_event_code: t.question_event.code });
    events.push({ timestamp: iso(t.spokenEnd), timestamp_local: local(t.spokenEnd), event: 'question_spoken_end', session_id: c.sessionId, robot_id: c.robot.robot_id, photo_id: c.photoId, turn: t.turn, topic: t.topic, question_event_code: t.question_event.code });
    events.push({ timestamp: iso(t.answerStart), timestamp_local: local(t.answerStart), event: 'answer_started', session_id: c.sessionId, robot_id: c.robot.robot_id, photo_id: c.photoId, turn: t.turn, topic: t.topic });
    events.push({ timestamp: iso(t.answerEnd), timestamp_local: local(t.answerEnd), event: 'answer_ended', session_id: c.sessionId, robot_id: c.robot.robot_id, photo_id: c.photoId, turn: t.turn, topic: t.topic, answer: t.answer });
  }
  events.push({ timestamp: iso(c.endedAt), timestamp_local: local(c.endedAt), event: 'session_ended', session_id: c.sessionId, robot_id: c.robot.robot_id, photo_id: c.photoId, end_reason: 'themes_completed' });
  return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function makeSilentWav(durationSeconds) {
  const sampleRate = 16000;
  const dataBytes = sampleRate * durationSeconds * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function writeCsv(file, rows) {
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')].concat(rows.map((row) => headers.map((key) => JSON.stringify(row[key] ?? '')).join(',')));
  writeFileSync(file, lines.join('\n'));
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    acc[row[key]] = (acc[row[key]] ?? 0) + 1;
    return acc;
  }, {});
}

function formatFolderStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function iso(date) {
  return date.toISOString();
}

function local(date) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium', hour12: false, timeZone: 'Asia/Shanghai' }).format(date);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function jitter(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

function avg(values) {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
