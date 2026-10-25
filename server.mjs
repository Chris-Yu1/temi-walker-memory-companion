import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import WebSocket from 'ws';

await loadLocalEnvironment();

const PORT = 3000;
const execFileAsync = promisify(execFile);
const TEMI_ADDRESS = '192.168.1.109:5555';
const TEMI_AUDIO_PATH = '/sdcard/temi-answer.wav';
const WALKER_SSH_HOST = process.env.WALKER_SSH_HOST || '192.168.4.1';
const WALKER_SSH_USER = process.env.WALKER_SSH_USER || 'pi';
const WALKER_SSH_PASSWORD = process.env.WALKER_SSH_PASSWORD || '';
const WALKER_RECORDING_PATH = '/tmp/memory_companion_walker_answer.wav';
let temiRecorder = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_FALLBACK_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini'];
const QUESTION_MODEL = process.env.QUESTION_MODEL || 'gpt-4o-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'shimmer';
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const THEME_LIBRARY = ['where', 'when', 'who', 'others'];
const TURN_TAKING_MODEL = process.env.TURN_TAKING_MODEL || 'gpt-realtime';
const TURN_TAKING_SECONDARY_PAUSE_SECONDS = Number(process.env.TURN_TAKING_SECONDARY_PAUSE_SECONDS ?? 1.2);
const CONVERSATION_LOG_DIR = join(process.cwd(), 'outputs', 'conversation-logs');
const SESSION_OUTPUT_ROOT = join(process.cwd(), 'outputs', 'test-sessions');
const QUESTIONNAIRE_OUTPUT_ROOT = join(process.cwd(), 'outputs', 'questionnaires');
const AUDIO_CHUNK_TEMP_DIR = join(tmpdir(), 'memory-companion-audio-chunks');
const PUBLIC_UPLOAD_URL_FILE = join(process.cwd(), '.public-upload-url');
const activeSessions = new Map();
const mobileUploadSessions = new Map();
let cachedReachableUploadBaseUrl = '';
let cachedReachableUploadBaseUrlCheckedAt = 0;

async function loadLocalEnvironment() {
  try {
    const content = await readFile(join(process.cwd(), '.env.local'), 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const httpServer = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && request.url === '/upload-health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'mobile-upload' }));
    return;
  }

  if (request.method === 'POST' && request.url === '/tts') {
    try {
      const body = await readJsonBody(request);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 1000) {
        throw new Error('TTS text must contain between 1 and 1000 characters.');
      }

      const audio = await synthesizeRobotSpeech(text);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ payload: audio.toString('base64'), mime_type: 'audio/wav' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Speech synthesis failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/questionnaire-submit') {
    try {
      const body = await readJsonBody(request, 400_000);
      const result = await saveQuestionnaireSubmission(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Questionnaire submission failed.';
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/walker/say') {
    try {
      const body = await readJsonBody(request, 80_000);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 1200) {
        throw new Error('Walker speech text must contain between 1 and 1200 characters.');
      }

      const result = await publishWalkerSpeechViaRosBridge({
        text,
        rosIp: typeof body.ros_ip === 'string' ? body.ros_ip : '',
        rosPort: typeof body.ros_port === 'string' ? body.ros_port : ''
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Walker ROSBridge speech failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/stt') {
    try {
      const body = await readJsonBody(request, 12_000_000);
      const audio = typeof body.audio === 'string' ? body.audio : '';
      if (!audio) {
        throw new Error('No WAV audio was provided.');
      }

      const transcript = await recognizeWindowsSpeech(audio);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ transcript }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local speech recognition failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/walker/play-audio') {
    try {
      const body = await readJsonBody(request, 12 * 1024 * 1024);
      const payload = typeof body.payload === 'string' ? body.payload.trim() : '';
      if (!payload) {
        throw new Error('Walker audio payload is required.');
      }

      await playWalkerAudioBuffer(Buffer.from(payload, 'base64'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, output: 'ssh_audio' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Walker audio playback failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/play-audio') {
    try {
      const body = await readJsonBody(request, 12 * 1024 * 1024);
      const payload = typeof body.payload === 'string' ? body.payload.trim() : '';
      if (!payload) {
        throw new Error('temi audio payload is required.');
      }

      await playTemiAudioBuffer(Buffer.from(payload, 'base64'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, output: 'adb_tinyplay' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'temi audio playback failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/walker/record/start') {
    try {
      await startWalkerRecording();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ recording: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start Walker recording.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/walker/record/stop') {
    try {
      const body = await readJsonBody(request, 80_000).catch(() => ({}));
      const result = await stopWalkerRecordingAndTranscribe(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not process Walker recording.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/turn-taking') {
    try {
      const body = await readJsonBody(request, 80_000);
      const result = await detectTurnTaking(body);
      await recordTurnTakingTrace(body, result);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Turn-taking detection failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/mobile-upload-session') {
    try {
      const sessionId = randomUUID();
      const uploadBaseUrl = await getMobileUploadBaseUrl();
      const uploadUrl = `${uploadBaseUrl}/mobile-upload/${sessionId}`;
      const qrDataUrl = await QRCode.toDataURL(uploadUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360
      });
      mobileUploadSessions.set(sessionId, {
        session_id: sessionId,
        upload_url: uploadUrl,
        created_at: Date.now(),
        photos: []
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        session_id: sessionId,
        upload_url: uploadUrl,
        qr_image_url: `/mobile-upload-session/${sessionId}/qr.png`,
        qr_data_url: qrDataUrl,
        upload_base_url: uploadBaseUrl,
        is_public_upload_url: isPublicUploadUrl(uploadBaseUrl)
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create mobile upload session.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'GET' && /^\/mobile-upload-session\/[^/]+\/qr\.png(?:\?.*)?$/.test(request.url ?? '')) {
    const pathname = new URL(request.url, `http://localhost:${PORT}`).pathname;
    const sessionId = decodeURIComponent(pathname.split('/')[2] ?? '');
    const session = mobileUploadSessions.get(sessionId);
    if (!session) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Upload session not found.' }));
      return;
    }

    try {
      const qrPng = await QRCode.toBuffer(session.upload_url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 360,
        type: 'png'
      });
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store'
      });
      response.end(qrPng);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not render QR image.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'GET' && request.url?.startsWith('/mobile-upload-session/')) {
    const sessionId = decodeURIComponent(request.url.split('/').at(-1) ?? '');
    const session = mobileUploadSessions.get(sessionId);
    if (!session) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Upload session not found.' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ session_id: sessionId, upload_url: session.upload_url, photos: session.photos }));
    return;
  }

  if (request.method === 'GET' && request.url?.startsWith('/mobile-upload/')) {
    const sessionId = decodeURIComponent(request.url.split('/').at(-1) ?? '');
    if (!mobileUploadSessions.has(sessionId)) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Upload session not found</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(renderMobileUploadPage(sessionId));
    return;
  }

  if (request.method === 'POST' && request.url?.startsWith('/mobile-upload/')) {
    try {
      const sessionId = decodeURIComponent(request.url.split('/').at(-1) ?? '');
      const session = mobileUploadSessions.get(sessionId);
      if (!session) {
        throw new Error('Upload session not found.');
      }
      const body = await readJsonBody(request, 30_000_000);
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, 2) : [];
      if (photos.length !== 2) {
        throw new Error('Please upload exactly two photos.');
      }
      session.photos = photos.map((photo, index) => ({
        id: typeof photo.id === 'string' ? photo.id : `mobile-photo-${index + 1}`,
        name: typeof photo.name === 'string' ? photo.name : `Photo ${index + 1}`,
        size: Number(photo.size ?? 0),
        dataUrl: typeof photo.dataUrl === 'string' ? photo.dataUrl : '',
        uploadedAt: Date.now()
      })).filter((photo) => photo.dataUrl.startsWith('data:image/'));
      if (session.photos.length !== 2) {
        throw new Error('Both files must be valid images.');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, photos: session.photos.map(({ dataUrl, ...photo }) => photo) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mobile upload failed.';
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/record/start') {
    try {
      await startTemiRecording();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ recording: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start temi recording.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/record/stop') {
    try {
      const body = await readJsonBody(request, 80_000).catch(() => ({}));
      const result = await stopTemiRecordingAndTranscribe(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not process temi recording.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/lock-position') {
    try {
      await applyTemiStaticLock();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'temi position locking failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/static-lock/start') {
    try {
      await applyTemiStaticLock();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'temi static lock failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/static-lock/heartbeat') {
    try {
      await applyTemiStaticLock();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'temi static lock heartbeat failed.';
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ locked: false, error: message }));
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/temi/static-lock/stop') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ locked: false }));
    return;
  }

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'ok', service: 'memory-conversation-socket' }));
});

const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('robot_message', async (message) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'image_upload') {
      console.log(`Image received for ${message.robot_id}`);
      return;
    }

    if (message.type === 'memory_conversation_start') {
      await createSessionRecord(message);
      await emitModelQuestion(socket, message, 1);
      return;
    }

    if (message.type === 'memory_answer') {
      await recordAnswer(message);
      const nextTurn = Number(message.turn) + 1;
      await emitAnswerFeedback(socket, message);
      if (message.end_after_answer === true) {
        await finishSession(message.session_id, 'themes_completed');
        socket.emit('memory_question', {
          type: 'memory_question',
          photo_id: message.photo_id,
          turn: nextTurn,
          question: '',
          is_final: true
        });
        return;
      }

      await emitModelQuestion(socket, message, nextTurn);
    }

    if (message.type === 'question_playback_event') {
      await recordQuestionPlaybackEvent(message);
    }
  });

  socket.on('disconnect', () => console.log(`Client disconnected: ${socket.id}`));
});

async function emitModelQuestion(socket, message, turn) {
  try {
    const apiStartedAt = Date.now();
    const generated = await generatePersonalisedQuestion(message, turn);
    const apiEndedAt = Date.now();
    const question = generated.question;
    const audioPayload = shouldPreSynthesizeQuestionAudio(message)
      ? await trySynthesizeQuestionAudio(question)
      : undefined;
    await recordQuestion(message, turn, question, generated.theme, {
      api_started_at: new Date(apiStartedAt).toISOString(),
      api_ended_at: new Date(apiEndedAt).toISOString(),
      api_latency_ms: apiEndedAt - apiStartedAt,
      image_description: generated.image_description
    });
    socket.emit('memory_question', {
      type: 'memory_question',
      photo_id: message.photo_id,
      turn,
      question,
      audio_payload: audioPayload,
      theme: generated.theme,
      image_description: generated.image_description
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown language model error.';
    console.error(`Question generation failed: ${detail}`);
    const record = getSessionRecord(message);
    const history = message.context?.conversation_history ?? [];
    const theme = chooseNextTheme(getThemeQuestionCounts(record, history));
    const question = generateLocalFallbackQuestion(message, turn, theme);
    const audioPayload = shouldPreSynthesizeQuestionAudio(message)
      ? await trySynthesizeQuestionAudio(question)
      : undefined;
    await recordQuestion(message, turn, question, theme, {
      api_started_at: null,
      api_ended_at: null,
      api_latency_ms: null,
      fallback_reason: describeModelError(detail)
    });
    socket.emit('memory_question', {
      type: 'memory_question',
      photo_id: message.photo_id,
      turn,
      question,
      audio_payload: audioPayload,
      theme,
      model_fallback_reason: describeModelError(detail)
    });
  }
}

function shouldPreSynthesizeQuestionAudio(message) {
  const robotId = String(message.robot_id ?? '').toLowerCase();
  return !robotId.includes('walker') && !robotId.includes('temi-v3');
}

async function emitAnswerFeedback(socket, message) {
  const feedback = generateImmediateAnswerFeedback(message);
  if (!feedback) {
    return;
  }

  await recordFeedback(message, feedback);
  socket.emit('memory_feedback', {
    type: 'memory_feedback',
    photo_id: message.photo_id,
    turn: Number(message.turn),
    feedback
  });
}

function generateImmediateAnswerFeedback(message) {
  const answer = String(message.answer ?? '').trim();
  const isEndingPhoto = message.end_after_answer === true;
  if (!answer || isNoResponseAnswer(answer)) {
    return isEndingPhoto
      ? "That's okay. We have finished this photo for now."
      : "That's okay. Let's gently try another part of the photo.";
  }

  const options = isEndingPhoto
    ? [
        'Thank you for sharing that. We have finished this photo for now.',
        'Thank you, that was helpful. This photo conversation is complete.',
        'I appreciate your answer. We can now pause this photo.',
        'That is nice to hear, thank you. We have completed this photo.'
      ]
    : [
        'Thank you for sharing that. Let us explore another part of the photo.',
        'Thank you, that is helpful. I will ask about another detail now.',
        'I appreciate your answer. Let us think about the photo a little more.',
        'That is nice to hear, thank you. Let us continue with one more gentle question.'
      ];
  const index = Math.abs(answer.length + Number(message.turn ?? 0)) % options.length;
  return options[index];
}

function generateLocalFallbackQuestion(message, turn, theme = '') {
  const profile = message.context?.user_profile ?? message.user_profile ?? {};
  const level = String(profile.memory_decline_level ?? 'mild');
  const history = message.context?.conversation_history ?? [];
  const hasAnswered = history.some((item) => String(item.answer ?? '').trim());
  const gentlePrefix = level === 'moderate' || level === 'severe'
    ? 'Take your time. '
    : '';
  const questionsByTheme = {
    where: 'Where do you think this photo was taken?',
    when: 'When do you think this moment might have happened?',
    who: 'Who does this photo make you think about?',
    others: 'What feeling does this photo bring back for you?'
  };
  if (turn > 1 && hasAnswered) {
    return `${gentlePrefix}${questionsByTheme[theme] ?? 'Thinking about what you just said, what other memory does this photo bring to mind?'}`;
  }
  return `${gentlePrefix}${questionsByTheme[theme] ?? 'What is the first thing you notice in this photo?'}`;
}

function generateLocalFallbackFeedback(message) {
  const answer = String(message.answer ?? '').trim();
  if (!answer || isNoResponseAnswer(answer)) {
    return "That's okay, let's try another gentle question.";
  }
  return 'Thank you, that is helpful to hear.';
}

async function trySynthesizeQuestionAudio(question) {
  try {
    const audio = await synthesizeRobotSpeech(question);
    return audio.toString('base64');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown TTS error.';
    console.warn(`Question audio pre-synthesis failed: ${detail}`);
    return undefined;
  }
}

function isNoResponseAnswer(answer) {
  return /^no response detected\.?$/i.test(String(answer ?? '').trim());
}

function describeModelError(detail) {
  if (detail.includes('OPENAI_API_KEY') || /invalid.*api.*key|incorrect api key|authentication/i.test(detail)) {
    return 'The OpenAI API key is missing or invalid. Check .env.local and restart the app.';
  }
  if (/quota|billing|credit|insufficient_quota/i.test(detail)) {
    return 'The OpenAI API account has no available credit. Check API billing and try again.';
  }
  if (/model.*not found|does not exist|access to model/i.test(detail)) {
    return `The configured language model is unavailable for this API account. The backend tried: ${getOpenAIModelCandidates().join(', ')}.`;
  }
  if (/abort|timeout|fetch failed|network/i.test(detail)) {
    return 'The language model request timed out or could not reach OpenAI. Check the computer network and try again.';
  }
  return `The personalised question could not be generated: ${detail}`;
}

async function detectTurnTaking(body) {
  const startedAt = new Date().toISOString();
  const sentence = String(body.sentence ?? '').trim();
  const question = String(body.question ?? '').trim();
  const ongoingDialog = String(body.ongoing_dialog ?? '').trim();
  const topic = String(body.topic ?? 'others').trim() || 'others';
  const pauseTimeSeconds = Number(body.pause_time_seconds ?? 0);
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};

  if (!sentence) {
    return {
      decision: 0,
      source: 'empty',
      trace: {
        client_requested_at: parseOptionalIso(body.client_requested_at) ?? null,
        server_started_at: startedAt,
        server_ended_at: new Date().toISOString(),
        sequence: Number(body.sequence ?? 0),
        metadata,
        received_sentence: sentence,
        question,
        topic,
        pause_time_seconds: pauseTimeSeconds,
        reason: 'empty-sentence'
      }
    };
  }

  const primaryPrompt = buildPrimaryTurnTakingPrompt({
    sentence,
    question,
    ongoingDialog,
    pauseTimeSeconds
  });
  const primaryStartedAt = new Date().toISOString();
  const primaryDecision = await requestRealtimeDigit(primaryPrompt, ['0', '1', '2']);
  const primaryEndedAt = new Date().toISOString();

  if (primaryDecision !== 2 || pauseTimeSeconds < TURN_TAKING_SECONDARY_PAUSE_SECONDS) {
    const endedAt = new Date().toISOString();
    return {
      decision: primaryDecision,
      source: 'primary',
      trace: {
        client_requested_at: parseOptionalIso(body.client_requested_at) ?? null,
        server_started_at: startedAt,
        server_ended_at: endedAt,
        server_latency_ms: durationMs(startedAt, endedAt),
        sequence: Number(body.sequence ?? 0),
        metadata,
        received_sentence: sentence,
        question,
        topic,
        pause_time_seconds: pauseTimeSeconds,
        primary_decision: primaryDecision,
        primary_started_at: primaryStartedAt,
        primary_ended_at: primaryEndedAt,
        primary_latency_ms: durationMs(primaryStartedAt, primaryEndedAt),
        secondary_decision: null,
        secondary_checked: false
      }
    };
  }

  const secondaryPrompt = buildSecondaryTurnTakingPrompt({
    topic,
    question,
    ongoingDialog,
    sentence
  });
  const secondaryStartedAt = new Date().toISOString();
  const secondaryDecision = await requestRealtimeDigit(secondaryPrompt, ['0', '1']);
  const secondaryEndedAt = new Date().toISOString();
  const endedAt = new Date().toISOString();
  return {
    decision: secondaryDecision,
    source: 'secondary',
    trace: {
      client_requested_at: parseOptionalIso(body.client_requested_at) ?? null,
      server_started_at: startedAt,
      server_ended_at: endedAt,
      server_latency_ms: durationMs(startedAt, endedAt),
      sequence: Number(body.sequence ?? 0),
      metadata,
      received_sentence: sentence,
      question,
      topic,
      pause_time_seconds: pauseTimeSeconds,
      primary_decision: primaryDecision,
      primary_started_at: primaryStartedAt,
      primary_ended_at: primaryEndedAt,
      primary_latency_ms: durationMs(primaryStartedAt, primaryEndedAt),
      secondary_decision: secondaryDecision,
      secondary_started_at: secondaryStartedAt,
      secondary_ended_at: secondaryEndedAt,
      secondary_latency_ms: durationMs(secondaryStartedAt, secondaryEndedAt),
      secondary_checked: true
    }
  };
}

function buildPrimaryTurnTakingPrompt({ sentence, question, ongoingDialog, pauseTimeSeconds }) {
  return `Analyse the following conversation snippet and determine whether the current speaker has yielded their turn.

Respond with:
- 1 if the speaker HAS yielded their turn (endpoint)
- 0 if the speaker HAS NOT yielded their turn (keep listening)
- 2 if you are UNCERTAIN and need additional evidence (e.g., could be complete but not sure)

Use the following criteria to make your decision:

(1) Sentence Completion:
Analyse whether the speaker's message represents a complete sentence or thought that suggests closure (Sentence: "${escapePromptValue(sentence)}").

(2) Turn-Yielding Cues:
Identify if the message includes any indicators such as questions, invitations for input, or pauses that might signal the speaker is yielding their turn.

(3) Context Dialogue:
Consider the ongoing conversation and the roles of the participants to understand the flow better (Context: "${escapePromptValue(ongoingDialog)}").

(4) Current System Question:
Consider what question or prompt the system/robot asked most recently, and whether the user's response appears complete relative to that question (Question: "${escapePromptValue(question)}").

(5) Pause Time:
Consider the time since the user last produced a final speech segment (Pause time: "${Number.isFinite(pauseTimeSeconds) ? pauseTimeSeconds.toFixed(2) : '0'}"). Longer pauses increase the chance the user has finished.

IMPORTANT:
The transcript is from live speech recognition. It may contain repeated words, fillers, false starts, missing punctuation, and small recognition errors.

Do NOT require perfect grammar.
A spoken answer can be complete even if it is grammatically messy.

For this experiment, false endpoints are worse than waiting slightly longer.
When in doubt, prefer 2 instead of 1.

Pause time alone should NOT determine the decision. A long pause may indicate thinking. Only treat long pauses as endpoint signals if the user's accumulated answer is already semantically reasonable for the robot's question.

Output 0 when the answer clearly ends mid-phrase, is semantically incomplete, or shows active continuation such as "and then", "because", "in the", "it was", "I remember", "we were", "there was", "what else", without completing the thought.

Output 1 only when the answer is both semantically complete for the robot question and does not sound like the user is about to continue.

Output 2 when the answer may be complete but could naturally continue with more memory detail.

Decision priority:
Semantic completeness relative to the robot question is MORE IMPORTANT than grammar.
Avoid interrupting older adults during reminiscence; give them extra time to continue.

Respond ONLY with a single digit:
0 or 1 or 2`;
}

function buildSecondaryTurnTakingPrompt({ topic, question, ongoingDialog, sentence }) {
  return `You are verifying whether the user's accumulated utterance is a reasonable and complete answer to the most recent system/robot question.

Task:
Given the topic (Topic: "${escapePromptValue(topic)}"), the question (Question: "${escapePromptValue(question)}"), the ongoing dialogue context (Context: "${escapePromptValue(ongoingDialog)}"), and the user's accumulated answer (Sentence: "${escapePromptValue(sentence)}"), decide if the user's answer is reasonable and complete enough that they likely finished speaking.

Use the topic to interpret what kind of answer is expected:
- If topic is "when", short date, month, year, or season answers can be complete.
- If topic is "where", short location or place answers can be complete.
- If topic is "who", short person or relationship answers can be complete.
- If topic is "others" or "end", short opinion, feeling, or experience answers can be complete.

Short spoken answers can be complete when they directly answer the robot's question. Do not require a full sentence.
For example, "yes", "no", "fine","I don't know", "maybe", "in the morning", "at the park", or "my sister" can be complete answers depending on the question.

Respond with:
- 1 if the user's answer is reasonable/complete for the question (treat as endpoint)
- 0 if the user's answer is not yet reasonable/complete (not endpoint)

Respond ONLY with a single digit:
1 or 0`;
}

async function requestRealtimeDigit(prompt, allowedDigits) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(TURN_TAKING_MODEL)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let outputText = '';
    const timeout = setTimeout(() => finish(new Error('Realtime turn-taking request timed out.')), 12_000);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: 'You are a turn-taking detector. Follow the user prompt exactly and output only one digit.',
          output_modalities: ['text'],
          max_output_tokens: 4
        }
      }));
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }]
        }
      }));
      ws.send(JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['text'],
          max_output_tokens: 4
        }
      }));
    });

    ws.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (event.type === 'error') {
        finish(new Error(event.error?.message ?? 'Realtime API returned an error.'));
        return;
      }

      if (typeof event.delta === 'string' && event.type?.includes('text')) {
        outputText += event.delta;
      }

      if (typeof event.text === 'string' && event.type?.includes('text')) {
        outputText += event.text;
      }

      if (event.type === 'response.done') {
        const fallbackText = extractRealtimeOutputText(event.response);
        const text = `${outputText} ${fallbackText}`.trim();
        const digit = text.match(/[012]/)?.[0];
        if (!digit || !allowedDigits.includes(digit)) {
          finish(new Error(`Realtime turn-taking returned an invalid decision: ${text || '(empty)'}`));
          return;
        }
        finish(Number(digit));
      }
    });

    ws.on('error', (error) => finish(error instanceof Error ? error : new Error('Realtime WebSocket failed.')));
  });
}

function extractRealtimeOutputText(response) {
  const parts = [];
  for (const item of response?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
      if (typeof content.transcript === 'string') parts.push(content.transcript);
    }
  }
  return parts.join(' ');
}

function escapePromptValue(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').slice(0, 4000);
}

async function generatePersonalisedQuestion(message, turn) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const record = getSessionRecord(message);
  const profile = message.context?.user_profile ?? message.user_profile ?? {};
  const history = message.context?.conversation_history ?? [];
  if (Number(turn) === 1 && !record.photo.image_description && message.image_data) {
    return await generateFastFirstQuestion(record, message, profile, apiKey);
  }
  const imageDescription = await ensureImageDescription(record, message.image_data, apiKey);
  const label = record.photo.label ?? inferImageLabel(imageDescription);
  record.photo.label = label;
  const remainingSeconds = getRemainingSeconds(record);
  const allQuestions = history.map((item) => item.question).filter(Boolean);
  const allAnswers = history.map((item) => item.answer).filter(Boolean);
  const previousQuestionsText = allQuestions.length ? allQuestions.map((question, index) => `${index + 1}. ${question}`).join('\n') : 'None.';
  const themeQuestionCounts = getThemeQuestionCounts(record, history);
  const requiredTheme = chooseNextTheme(themeQuestionCounts);
  const prompt = buildQuestionGenerationPrompt({
    turn,
    profile,
    remainingSeconds,
    themeQuestionCounts,
    requiredTheme,
    imageDescription,
    label,
    previousQuestionsText,
    allQuestions,
    allAnswers
  });

  const result = await requestTextResponse(apiKey, {
    model: QUESTION_MODEL,
    input: prompt,
    max_output_tokens: 140,
    temperature: 0.5
  });

  const parsed = parseQuestionJson(extractResponseText(result), requiredTheme);
  return {
    question: parsed.question,
    theme: parsed.theme,
    image_description: imageDescription
  };
}

async function generateFastFirstQuestion(record, message, profile, apiKey) {
  const theme = chooseNextTheme(getThemeQuestionCounts(record, message.context?.conversation_history ?? []));
  const result = await requestTextResponse(apiKey, {
    model: QUESTION_MODEL,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `You are a gentle reminiscence assistant. Look at the image and return only valid JSON: {"image_description":"one concise sentence","theme":"${theme}","question":"one short, warm question based on the image"}. The question must use theme ${theme}. If theme is where, ask where the photo may have been taken or what place it reminds the user of. Keep the question easy for an older adult. User profile: name=${profile.name || 'unknown'}, age=${profile.age ?? 'unknown'}, gender=${profile.gender || 'unknown'}.`
        },
        { type: 'input_image', image_url: message.image_data, detail: 'low' }
      ]
    }],
    max_output_tokens: 130,
    temperature: 0.35
  });

  const rawParsed = parseJsonObject(extractResponseText(result));
  const parsed = parseQuestionJson(JSON.stringify(rawParsed), theme);
  const description = String(rawParsed.image_description ?? '').trim() || `A photo that may support a ${theme} memory question.`;
  record.photo.image_description = description;
  record.photo.label = inferImageLabel(description);
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
  return {
    question: parsed.question,
    theme: parsed.theme,
    image_description: description
  };
}

function parseJsonObject(text) {
  const trimmed = String(text ?? '').trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Model returned invalid JSON: ${trimmed}`);
    return JSON.parse(match[0]);
  }
}

async function ensureImageDescription(record, imageData, apiKey) {
  if (record.photo.image_description) {
    return record.photo.image_description;
  }

  const result = await requestTextResponse(apiKey, {
    model: QUESTION_MODEL,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image in 2 concise sentences for a reminiscence therapy conversation. Mention visible people, places, objects, activities, and mood, but do not identify unknown people.' },
        { type: 'input_image', image_url: imageData, detail: 'low' }
      ]
    }],
    max_output_tokens: 140,
    temperature: 0.2
  });

  const description = extractResponseText(result).trim();
  if (!description) {
    throw new Error('The language model returned an empty image description.');
  }
  record.photo.image_description = description;
  record.photo.label = inferImageLabel(description);
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
  return description;
}

async function generateAnswerFeedback(message) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return generateLocalFallbackFeedback(message);
  }

  const history = message.context?.conversation_history ?? [];
  const currentTurn = history.find((item) => Number(item.turn) === Number(message.turn));
  const robotQuestion = currentTurn?.question ?? history.at(-1)?.question ?? '';
  const latestUserInput = String(message.answer ?? '').trim();
  if (!latestUserInput) {
    return '';
  }
  if (isNoResponseAnswer(latestUserInput)) {
    return generateLocalFallbackFeedback(message);
  }

  const topic = inferTurnTheme(robotQuestion);
  const toneInstruction = Math.random() < 0.5
    ? "Give a neutral short response, yet still polite. Don't ask questions back to the user."
    : "Provide a short warm and friendly feedback based on the user's answer. Don't ask questions back to the user.";

  try {
    const result = await requestTextResponse(apiKey, {
      model: QUESTION_MODEL,
      input: [
        { role: 'system', content: 'You are a friendly robot assistant providing feedback to a user during a reminiscence session.' },
        { role: 'system', content: `The topic is '${topic}'.` },
        { role: 'user', content: `The robot asked: '${robotQuestion}'.` },
        { role: 'user', content: `The user answered: '${latestUserInput}'.` },
        { role: 'system', content: toneInstruction }
      ],
      max_output_tokens: 70,
      temperature: 0.6
    });
    return sanitizeFeedback(extractResponseText(result));
  } catch (error) {
    console.warn(`Feedback generation failed: ${error instanceof Error ? error.message : error}`);
    return generateLocalFallbackFeedback(message);
  }
}

function buildQuestionGenerationPrompt({
  profile,
  remainingSeconds,
  themeQuestionCounts,
  requiredTheme,
  imageDescription,
  label,
  previousQuestionsText,
  allQuestions,
  allAnswers
}) {
  return `
You are a reminiscence therapy assistant for people living with dementia.

Generate exactly one warm, simple, open-ended main question, and choose the best theme for this turn.

Session progress:
- There is no fixed time limit for this photo.
- End this photo only after where, when, who, and others have each been covered once.

User profile:
- Name: ${profile.name ?? 'not provided'}
- Age: ${profile.age ?? 'unknown'}
- Gender: ${profile.gender ?? 'not provided'}

Theme coverage so far:
- Theme question counts: ${JSON.stringify(themeQuestionCounts)}
- Available themes: ${JSON.stringify(THEME_LIBRARY)}
- Required theme for this turn: ${requiredTheme}

Output format (STRICT):
{"theme":"one of where/when/who/others","question":"one sentence question"}

Build the question based on:
- Photo description: "${escapePromptValue(imageDescription)}"
- Label: "${label}"

Theme rules:
- If theme == "where" and label == "Personal": ask where the photo was taken first.
- If theme == "where" and label == "Generic": ask whether the user can recognise anything in the photo first.
- If theme == "when": ask about time, season, or historical context.
- If theme == "who": ask about people in the photo and their relationships.
- If theme == "others": ask about feelings, activities, or objects.

Previous main questions already used:
${previousQuestionsText}

Checking all the questions ${JSON.stringify(allQuestions)} and answers ${JSON.stringify(allAnswers)} already generated to avoid any confusion and repetition.
For example:
Questions: "Can you tell me who the young person in the foreground might be, or if they remind you of anyone special in your life?"
Answer: "It's me."
Further question should not ask as if the young person is unknown; it should build on the answer naturally.

Requirements:
- Use the required theme for this turn unless it would be completely impossible from the photo description.
- Choose a theme that helps balance coverage across all themes.
- Make the question short, gentle, and easy to answer.
- Use one sentence only.
- Make the new question clearly different from the previous main questions.
- Do not repeat or closely paraphrase any previous main question.
- Avoid medical advice.
- Encourage personal memories.
- Use British English.
- Return only valid JSON in the exact format requested, with no preface and no markdown.
- Main question must be based on the photo description.
`.trim();
}

async function requestTextResponse(apiKey, body) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error?.message ?? `OpenAI returned HTTP ${response.status}.`);
  }
  return result;
}

function extractResponseText(result) {
  if (typeof result?.output_text === 'string') {
    return result.output_text;
  }
  const parts = [];
  for (const item of result?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
      if (typeof content.transcript === 'string') parts.push(content.transcript);
    }
  }
  return parts.join(' ');
}

function parseQuestionJson(text, requiredTheme = '') {
  const trimmed = String(text ?? '').trim().replace(/^```json\s*|\s*```$/g, '');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Question generation returned invalid JSON: ${trimmed}`);
    }
    parsed = JSON.parse(match[0]);
  }

  const parsedTheme = THEME_LIBRARY.includes(parsed.theme) ? parsed.theme : inferTurnTheme(parsed.question);
  const theme = THEME_LIBRARY.includes(requiredTheme) ? requiredTheme : parsedTheme;
  const question = String(parsed.question ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!question) {
    throw new Error('Question generation returned empty question text.');
  }
  return { theme, question };
}

function chooseNextTheme(themeQuestionCounts) {
  const uncovered = THEME_LIBRARY.find((theme) => Number(themeQuestionCounts?.[theme] ?? 0) === 0);
  if (uncovered) {
    return uncovered;
  }
  return THEME_LIBRARY
    .map((theme) => ({ theme, count: Number(themeQuestionCounts?.[theme] ?? 0) }))
    .sort((a, b) => a.count - b.count)[0]?.theme ?? 'others';
}

function sanitizeFeedback(text) {
  return String(text ?? '')
    .trim()
    .replace(/^feedback\s*:\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .split(/\n+/)[0]
    .slice(0, 180);
}

function getThemeQuestionCounts(record, history) {
  const counts = Object.fromEntries(THEME_LIBRARY.map((theme) => [theme, 0]));
  for (const turn of record.turns ?? []) {
    if (THEME_LIBRARY.includes(turn.theme)) counts[turn.theme] += 1;
  }
  for (const item of history) {
    const theme = item.theme ?? inferTurnTheme(item.question);
    if (THEME_LIBRARY.includes(theme) && !record.turns?.some((turn) => turn.turn === item.turn)) {
      counts[theme] += 1;
    }
  }
  return counts;
}

function inferTurnTheme(question) {
  const lower = String(question ?? '').toLowerCase();
  if (/\bwhere\b|which place|what place|location|recognise anything/.test(lower)) return 'where';
  if (/\bwhen\b|what time|what year|which year|what month|season|historical/.test(lower)) return 'when';
  if (/\bwho\b|whose|person|people|friend|family|mother|father|sister|brother|relationship/.test(lower)) return 'who';
  return 'others';
}

function inferImageLabel(description) {
  return /\b(family|friend|friends|home|birthday|wedding|portrait|people|person|child|children|man|woman|group)\b/i.test(description)
    ? 'Personal'
    : 'Generic';
}

function getRemainingSeconds(record) {
  const durationMinutes = Number(record.conversation_duration_minutes ?? 2);
  const createdAt = Date.parse(record.created_at);
  if (!Number.isFinite(createdAt)) {
    return durationMinutes * 60;
  }
  return Math.max(0, Math.ceil((createdAt + durationMinutes * 60_000 - Date.now()) / 1000));
}

async function requestQuestionFromOpenAI(apiKey, prompt, imageData) {
  const models = getOpenAIModelCandidates();
  const errors = [];

  for (const model of models) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imageData, detail: 'low' }
            ]
          }],
          max_output_tokens: 120
        }),
        signal: AbortSignal.timeout(45_000)
      });
      const result = await response.json();
      if (response.ok) {
        if (model !== OPENAI_MODEL) {
          console.warn(`Question generation used fallback model: ${model}`);
        }
        return result;
      }

      const message = result?.error?.message ?? `OpenAI returned HTTP ${response.status}.`;
      errors.push(`${model}: ${message}`);
      if (!isRetryableModelError(message)) {
        throw new Error(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown OpenAI request error.';
      errors.push(`${model}: ${message}`);
      if (!isRetryableModelError(message)) {
        throw new Error(message);
      }
    }
  }

  throw new Error(errors.join(' | '));
}

function getOpenAIModelCandidates() {
  return [OPENAI_MODEL, ...OPENAI_FALLBACK_MODELS]
    .filter(Boolean)
    .filter((model, index, models) => models.indexOf(model) === index);
}

function isRetryableModelError(message) {
  return /model.*not found|does not exist|access to model|unsupported.*model|invalid.*model|reasoning/i.test(message);
}

async function createSessionRecord(message) {
  const sessionId = normaliseSessionId(message.session_id);
  const profile = message.context?.user_profile ?? message.user_profile ?? {};
  const createdAt = new Date().toISOString();
  const robotId = message.robot_id ?? 'unknown';
  const outputDir = getSessionOutputDir(sessionId, profile, createdAt, robotId);
  const record = {
    session_id: sessionId,
    test_folder_name: outputDir.split(/[\\/]/).at(-1),
    output_dir: outputDir,
    robot_id: robotId,
    photo_id: message.photo_id ?? 'unknown',
    created_at: createdAt,
    created_at_local: toLocalTimestamp(createdAt),
    updated_at: createdAt,
    updated_at_local: toLocalTimestamp(createdAt),
    ended_at: null,
    ended_at_local: null,
    end_reason: null,
    user_profile: profile,
    conversation_duration_minutes: Number(profile.conversation_duration_minutes ?? 5),
    photo: {
      id: message.photo_id ?? 'unknown',
      image_data_length: typeof message.image_data === 'string' ? message.image_data.length : 0,
      image_description: '',
      label: ''
    },
    turns: [],
    turn_taking_traces: []
  };
  activeSessions.set(sessionId, record);
  await saveSessionRecord(record);
}

async function recordQuestion(message, turn, question, theme = inferTurnTheme(question), metadata = {}) {
  const record = getSessionRecord(message);
  const existingTurn = record.turns.find((item) => item.turn === turn);
  const questionAt = new Date().toISOString();
  const event = buildQuestionEvent(record, Number(turn), theme);
  if (existingTurn) {
    existingTurn.question = question;
    existingTurn.theme = theme;
    existingTurn.question_event = event;
    existingTurn.question_at = questionAt;
    existingTurn.question_at_local = toLocalTimestamp(questionAt);
    existingTurn.question_generation = formatQuestionGenerationMetadata(metadata);
  } else {
    record.turns.push({
      turn,
      theme,
      question_event: event,
      question,
      question_at: questionAt,
      question_at_local: toLocalTimestamp(questionAt),
      question_generation: formatQuestionGenerationMetadata(metadata),
      question_started_at: null,
      question_started_at_local: null,
      question_ended_at: null,
      question_ended_at_local: null,
      answer: null,
      answer_at: null,
      answer_at_local: null
    });
  }
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
}

async function recordAnswer(message) {
  const record = getSessionRecord(message);
  const turn = Number(message.turn);
  const existingTurn = record.turns.find((item) => item.turn === turn);
  const answerAt = new Date().toISOString();
  const answerStartedAt = parseOptionalIso(message.answer_started_at) ?? answerAt;
  const answerEndedAt = parseOptionalIso(message.answer_ended_at) ?? answerAt;
  if (existingTurn) {
    existingTurn.answer = String(message.answer ?? '');
    existingTurn.answer_started_at = answerStartedAt;
    existingTurn.answer_started_at_local = toLocalTimestamp(answerStartedAt);
    existingTurn.answer_ended_at = answerEndedAt;
    existingTurn.answer_ended_at_local = toLocalTimestamp(answerEndedAt);
    existingTurn.answer_at = answerAt;
    existingTurn.answer_at_local = toLocalTimestamp(answerAt);
    existingTurn.audio_source_chunks = mergeUniquePaths(existingTurn.audio_source_chunks, message.audio_paths);
    existingTurn.attention_samples = Array.isArray(message.attention_samples) ? message.attention_samples : [];
  } else {
    record.turns.push({
      turn,
      question: message.context?.conversation_history?.find((item) => item.turn === turn)?.question ?? '',
      question_at: null,
      answer: String(message.answer ?? ''),
      answer_started_at: answerStartedAt,
      answer_started_at_local: toLocalTimestamp(answerStartedAt),
      answer_ended_at: answerEndedAt,
      answer_ended_at_local: toLocalTimestamp(answerEndedAt),
      answer_at: answerAt,
      answer_at_local: toLocalTimestamp(answerAt),
      audio_source_chunks: Array.isArray(message.audio_paths) ? message.audio_paths : [],
      attention_samples: Array.isArray(message.attention_samples) ? message.attention_samples : []
    });
  }
  await combineSessionAudio(record).catch((error) => {
    console.warn(`Could not combine session audio: ${error instanceof Error ? error.message : error}`);
  });
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
}

async function recordFeedback(message, feedback) {
  const record = getSessionRecord(message);
  const turn = Number(message.turn);
  const existingTurn = record.turns.find((item) => item.turn === turn);
  const feedbackAt = new Date().toISOString();
  if (existingTurn) {
    existingTurn.feedback = feedback;
    existingTurn.feedback_at = feedbackAt;
    existingTurn.feedback_at_local = toLocalTimestamp(feedbackAt);
  } else {
    record.turns.push({
      turn,
      theme: inferTurnTheme(message.context?.conversation_history?.find((item) => item.turn === turn)?.question ?? ''),
      question: message.context?.conversation_history?.find((item) => item.turn === turn)?.question ?? '',
      question_at: null,
      answer: String(message.answer ?? ''),
      answer_at: feedbackAt,
      answer_at_local: toLocalTimestamp(feedbackAt),
      feedback,
      feedback_at: feedbackAt,
      feedback_at_local: toLocalTimestamp(feedbackAt)
    });
  }
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
}

async function finishSession(sessionId, reason) {
  const record = activeSessions.get(normaliseSessionId(sessionId));
  if (!record) return;
  record.ended_at = new Date().toISOString();
  record.ended_at_local = toLocalTimestamp(record.ended_at);
  record.end_reason = reason;
  updateRecordTimestamp(record, record.ended_at);
  await saveSessionRecord(record);
}

function getSessionRecord(message) {
  const sessionId = normaliseSessionId(message.session_id);
  let record = activeSessions.get(sessionId);
  if (!record) {
    const profile = message.context?.user_profile ?? message.user_profile ?? {};
    const createdAt = new Date().toISOString();
    const robotId = message.robot_id ?? 'unknown';
    const outputDir = getSessionOutputDir(sessionId, profile, createdAt, robotId);
    record = {
      session_id: sessionId,
      test_folder_name: outputDir.split(/[\\/]/).at(-1),
      output_dir: outputDir,
      robot_id: robotId,
      photo_id: message.photo_id ?? 'unknown',
      created_at: createdAt,
      created_at_local: toLocalTimestamp(createdAt),
      updated_at: createdAt,
      updated_at_local: toLocalTimestamp(createdAt),
      ended_at: null,
      ended_at_local: null,
      end_reason: null,
      user_profile: profile,
      conversation_duration_minutes: Number(profile.conversation_duration_minutes ?? 5),
      photo: {
        id: message.photo_id ?? 'unknown',
        image_data_length: typeof message.image_data === 'string' ? message.image_data.length : 0,
        image_description: '',
        label: ''
      },
      turns: [],
      turn_taking_traces: []
    };
    activeSessions.set(sessionId, record);
  }
  return record;
}

async function recordQuestionPlaybackEvent(message) {
  const record = getSessionRecord(message);
  const turn = Number(message.turn);
  const existingTurn = record.turns.find((item) => item.turn === turn);
  if (!existingTurn) return;
  const timestamp = parseOptionalIso(message.timestamp) ?? new Date().toISOString();
  if (message.event === 'start') {
    existingTurn.question_started_at = timestamp;
    existingTurn.question_started_at_local = toLocalTimestamp(timestamp);
  } else if (message.event === 'end') {
    existingTurn.question_ended_at = timestamp;
    existingTurn.question_ended_at_local = toLocalTimestamp(timestamp);
  }
  updateRecordTimestamp(record);
  await saveSessionRecord(record);
}

async function recordTurnTakingTrace(body, result) {
  const sessionId = body?.session_id;
  if (!sessionId) return;
  const record = activeSessions.get(normaliseSessionId(sessionId));
  if (!record) return;
  record.turn_taking_traces ??= [];
  const capturedAt = new Date().toISOString();
  record.turn_taking_traces.push({
    captured_at: capturedAt,
    captured_at_local: toLocalTimestamp(capturedAt),
    client_requested_at: result.trace?.client_requested_at ?? null,
    client_requested_at_local: result.trace?.client_requested_at ? toLocalTimestamp(result.trace.client_requested_at) : null,
    server_started_at: result.trace?.server_started_at ?? null,
    server_started_at_local: result.trace?.server_started_at ? toLocalTimestamp(result.trace.server_started_at) : null,
    server_ended_at: result.trace?.server_ended_at ?? capturedAt,
    server_ended_at_local: toLocalTimestamp(result.trace?.server_ended_at ?? capturedAt),
    server_latency_ms: result.trace?.server_latency_ms ?? null,
    sequence: result.trace?.sequence ?? Number(body.sequence ?? 0),
    photo_id: body.photo_id ?? record.photo_id,
    turn: Number(body.turn ?? 0),
    received_sentence: String(body.sentence ?? ''),
    question: String(body.question ?? ''),
    topic: String(body.topic ?? ''),
    pause_time_seconds: Number(body.pause_time_seconds ?? 0),
    decision: result.decision,
    source: result.source,
    trigger: result.trace?.metadata?.trigger ?? null,
    primary_decision: result.trace?.primary_decision ?? null,
    secondary_decision: result.trace?.secondary_decision ?? null,
    secondary_checked: result.trace?.secondary_checked ?? false,
    primary_latency_ms: result.trace?.primary_latency_ms ?? null,
    secondary_latency_ms: result.trace?.secondary_latency_ms ?? null,
    endpoint_candidate_count: result.trace?.metadata?.endpoint_candidate_count ?? null,
    unchanged_chunks: result.trace?.metadata?.unchanged_chunks ?? null,
    has_new_transcript: result.trace?.metadata?.has_new_transcript ?? null,
    trace: result.trace ?? null
  });
  updateRecordTimestamp(record, capturedAt);
  await saveSessionRecord(record);
}

function buildQuestionEvent(record, turn, theme) {
  const sameThemeBefore = (record.turns ?? []).filter((item) => item.theme === theme && Number(item.turn) !== Number(turn));
  const mainIndex = sameThemeBefore.length + 1;
  const hasPreviousAnswer = (record.turns ?? []).some((item) => String(item.answer ?? '').trim());
  const followIndex = hasPreviousAnswer ? mainIndex : 0;
  return {
    code: followIndex > 0 ? `${theme}-m${mainIndex}-f${followIndex}` : `${theme}-m${mainIndex}`,
    topic: theme,
    main_index: mainIndex,
    follow_index: followIndex,
    is_follow_question: followIndex > 0
  };
}

function formatQuestionGenerationMetadata(metadata) {
  const startedAt = parseOptionalIso(metadata.api_started_at);
  const endedAt = parseOptionalIso(metadata.api_ended_at);
  return {
    api_started_at: startedAt,
    api_started_at_local: startedAt ? toLocalTimestamp(startedAt) : null,
    api_ended_at: endedAt,
    api_ended_at_local: endedAt ? toLocalTimestamp(endedAt) : null,
    api_latency_ms: Number.isFinite(Number(metadata.api_latency_ms)) ? Number(metadata.api_latency_ms) : null,
    image_description: metadata.image_description ?? null,
    fallback_reason: metadata.fallback_reason ?? null
  };
}

function updateRecordTimestamp(record, timestamp = new Date().toISOString()) {
  record.updated_at = timestamp;
  record.updated_at_local = toLocalTimestamp(timestamp);
}

function parseOptionalIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toLocalTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-GB', {
    timeZone: process.env.LOCAL_TIME_ZONE || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

async function saveSessionRecord(record) {
  const outputDir = record.output_dir || getSessionOutputDir(record.session_id, record.user_profile, record.created_at, record.robot_id);
  record.output_dir = outputDir;
  record.test_folder_name = outputDir.split(/[\\/]/).at(-1);

  const directories = {
    root: outputDir,
    session: join(outputDir, '00_session'),
    photos: join(outputDir, '01_photos'),
    events: join(outputDir, '02_events'),
    questionsV2: join(outputDir, '03_questions'),
    answersV2: join(outputDir, '04_answers'),
    attentionV2: join(outputDir, '05_attention'),
    turnTakingV2: join(outputDir, '06_turn-taking'),
    audioV2: join(outputDir, '07_audio'),
    metrics: join(outputDir, '08_metrics'),
    metadata: join(outputDir, '01_user-and-session'),
    questions: join(outputDir, '02_question-log'),
    answers: join(outputDir, '03_answer-log'),
    attention: join(outputDir, '04_headpose-eyegaze-log'),
    turnTaking: join(outputDir, '05_turn-taking-log'),
    audio: join(outputDir, '06_audio')
  };

  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
  await mkdir(CONVERSATION_LOG_DIR, { recursive: true });

  const questionEvents = buildQuestionEvents(record);
  const answerEvents = buildAnswerEvents(record);
  const attentionEvents = buildAttentionEvents(record);
  const turnTakingEvents = record.turn_taking_traces ?? [];
  const sessionMetrics = buildSessionMetrics(record, {
    questionEvents,
    answerEvents,
    attentionEvents,
    turnTakingEvents
  });

  await Promise.all([
    writeJson(join(directories.root, 'session-summary.json'), buildCleanSessionSummary(record)),
    writeJson(join(directories.session, 'session-metadata.json'), buildSessionMetadata(record)),
    writeJson(join(directories.session, 'user-profile.json'), record.user_profile ?? {}),
    writeJson(join(directories.session, 'robot-metadata.json'), buildRobotMetadata(record)),
    writeJson(join(directories.photos, 'photo-metadata.json'), record.photo ?? {}),
    writeJsonl(join(directories.events, 'timeline-events.jsonl'), buildTimelineEvents(record)),
    writeJson(join(directories.questionsV2, 'question-events.json'), questionEvents),
    writeJson(join(directories.questionsV2, 'interaction-turns.json'), buildInteractionTurns(record)),
    writeJson(join(directories.answersV2, 'answer-events.json'), answerEvents),
    writeJson(join(directories.attentionV2, 'attention-samples.json'), attentionEvents),
    writeJson(join(directories.attentionV2, 'attention-summary.json'), buildAttentionSummary(attentionEvents)),
    writeJson(join(directories.turnTakingV2, 'turn-taking-traces.json'), turnTakingEvents),
    writeJson(join(directories.turnTakingV2, 'turn-taking-summary.json'), buildTurnTakingSummary(turnTakingEvents)),
    writeJson(join(directories.audioV2, 'audio-events.json'), buildAudioEvents(record)),
    writeJson(join(directories.metrics, 'session-metrics.json'), sessionMetrics),
    writeJson(join(directories.metrics, 'comparison-row.json'), buildComparisonRow(record, sessionMetrics)),
    writeJson(join(directories.metadata, 'session-metadata.json'), buildSessionMetadata(record)),
    writeJson(join(directories.metadata, 'photo-metadata.json'), record.photo ?? {}),
    writeJson(join(directories.questions, 'question-events.json'), questionEvents),
    writeJson(join(directories.answers, 'answers.json'), answerEvents),
    writeJson(join(directories.attention, 'attention-samples.json'), attentionEvents),
    writeJson(join(directories.turnTaking, 'turn-taking-traces.json'), turnTakingEvents),
    writeJson(join(CONVERSATION_LOG_DIR, `${record.session_id}.json`), {
      session_id: record.session_id,
      test_folder_name: record.test_folder_name,
      output_dir: record.output_dir,
      created_at: record.created_at,
      created_at_local: record.created_at_local,
      updated_at: record.updated_at,
      updated_at_local: record.updated_at_local,
      metrics_path: join(directories.metrics, 'session-metrics.json'),
      comparison_row_path: join(directories.metrics, 'comparison-row.json')
    })
  ]);
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function writeJsonl(path, rows) {
  const content = (rows ?? []).map((row) => JSON.stringify(row)).join('\n');
  await writeFile(path, content ? `${content}\n` : '', 'utf8');
}

async function saveQuestionnaireSubmission(body) {
  const participant = body?.participant ?? {};
  const consent = body?.consent ?? {};
  const sus = body?.sus ?? {};
  const nasaTlx = body?.nasa_tlx ?? {};
  const sassi = body?.sassi ?? {};
  const comparison = body?.comparison ?? {};

  const participantName = String(participant.name ?? '').trim();
  const participantId = String(participant.participant_id ?? '').trim();
  const robotUsed = String(participant.robot_used ?? '').trim();
  if (!participantName) throw new Error('Participant name is required.');
  if (consent.agreed_to_participate !== true) throw new Error('Consent to participate is required.');
  validateQuestionnaireResponses('SUS', sus, QUESTIONNAIRE_SUS_IDS, 1, 5);
  validateQuestionnaireResponses('NASA-TLX', nasaTlx, QUESTIONNAIRE_TLX_IDS, 1, 7);
  validateQuestionnaireResponses('SASSI', sassi, QUESTIONNAIRE_SASSI_IDS, 1, 5);

  const submittedAt = new Date().toISOString();
  const folderName = `${sanitizePathPart(participantName)}_${formatFolderTimestamp(submittedAt)}`;
  const outputDir = join(QUESTIONNAIRE_OUTPUT_ROOT, folderName);
  await mkdir(outputDir, { recursive: true });
  await mkdir(QUESTIONNAIRE_OUTPUT_ROOT, { recursive: true });

  const scores = scoreQuestionnaire({ sus, nasa_tlx: nasaTlx, sassi });
  const record = {
    questionnaire_id: randomUUID(),
    folder_name: folderName,
    output_dir: outputDir,
    submitted_at: submittedAt,
    submitted_at_local: toLocalTimestamp(submittedAt),
    participant: {
      name: participantName,
      participant_id: participantId,
      age: numberOrNull(participant.age),
      gender: String(participant.gender ?? ''),
      robot_used: robotUsed,
      session_order: String(participant.session_order ?? ''),
      session_date: String(participant.session_date ?? '')
    },
    consent: {
      agreed_to_participate: consent.agreed_to_participate === true,
      agreed_to_audio_recording: consent.agreed_to_audio_recording === true,
      agreed_to_camera_attention_metrics: consent.agreed_to_camera_attention_metrics === true
    },
    responses: {
      sus: normalizeNumericResponses(sus, QUESTIONNAIRE_SUS_IDS),
      nasa_tlx: normalizeNumericResponses(nasaTlx, QUESTIONNAIRE_TLX_IDS),
      sassi: normalizeNumericResponses(sassi, QUESTIONNAIRE_SASSI_IDS),
      comparison: {
        preferred_robot: String(comparison.preferred_robot ?? ''),
        preference_reason: String(comparison.preference_reason ?? ''),
        influential_aspects: String(comparison.influential_aspects ?? ''),
        disliked_aspects: String(comparison.disliked_aspects ?? ''),
        improvement_suggestions: String(comparison.improvement_suggestions ?? '')
      }
    },
    scores
  };
  const row = buildQuestionnaireCsvRow(record);

  await Promise.all([
    writeJson(join(outputDir, 'questionnaire-response.json'), record),
    writeCsv(join(outputDir, 'questionnaire-response.csv'), [row]),
    appendQuestionnaireAggregate(row)
  ]);

  return {
    questionnaire_id: record.questionnaire_id,
    folder_name: folderName,
    output_dir: outputDir,
    json_path: join(outputDir, 'questionnaire-response.json'),
    csv_path: join(outputDir, 'questionnaire-response.csv'),
    aggregate_csv_path: join(QUESTIONNAIRE_OUTPUT_ROOT, 'all-questionnaire-responses.csv')
  };
}

function validateQuestionnaireResponses(label, responses, ids, min, max) {
  for (const id of ids) {
    const value = Number(responses?.[id]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${label} response ${id} is missing or invalid.`);
    }
  }
}

function normalizeNumericResponses(responses, ids) {
  return Object.fromEntries(ids.map((id) => [id, Number(responses[id])]));
}

function scoreQuestionnaire(responses) {
  const sus = normalizeNumericResponses(responses.sus, QUESTIONNAIRE_SUS_IDS);
  const tlx = normalizeNumericResponses(responses.nasa_tlx, QUESTIONNAIRE_TLX_IDS);
  const sassi = normalizeNumericResponses(responses.sassi, QUESTIONNAIRE_SASSI_IDS);
  const susContribution = QUESTIONNAIRE_SUS_IDS.reduce((sum, id, index) => {
    const value = sus[id];
    return sum + (index % 2 === 0 ? value - 1 : 5 - value);
  }, 0);

  const sassiCategoryMeans = Object.fromEntries(Object.entries(QUESTIONNAIRE_SASSI_CATEGORIES).map(([category, ids]) => [
    category,
    mean(ids.map((id) => sassi[id]))
  ]));

  return {
    sus_score: Number((susContribution * 2.5).toFixed(2)),
    nasa_tlx_mean: mean(Object.values(tlx)),
    nasa_tlx: Object.fromEntries(QUESTIONNAIRE_TLX_IDS.map((id) => [id, tlx[id]])),
    sassi_category_means: sassiCategoryMeans,
    sassi_overall_mean: mean(Object.values(sassi))
  };
}

function buildQuestionnaireCsvRow(record) {
  const base = {
    questionnaire_id: record.questionnaire_id,
    folder_name: record.folder_name,
    submitted_at: record.submitted_at,
    submitted_at_local: record.submitted_at_local,
    participant_id: record.participant.participant_id,
    participant_name: record.participant.name,
    age: record.participant.age,
    gender: record.participant.gender,
    robot_used: record.participant.robot_used,
    session_order: record.participant.session_order,
    session_date: record.participant.session_date,
    consent_participate: record.consent.agreed_to_participate,
    consent_audio: record.consent.agreed_to_audio_recording,
    consent_camera_attention: record.consent.agreed_to_camera_attention_metrics,
    sus_score: record.scores.sus_score,
    nasa_tlx_mean: record.scores.nasa_tlx_mean,
    sassi_overall_mean: record.scores.sassi_overall_mean,
    ...prefixKeys(record.scores.sassi_category_means, 'sassi_mean_'),
    preferred_robot: record.responses.comparison.preferred_robot,
    preference_reason: record.responses.comparison.preference_reason,
    influential_aspects: record.responses.comparison.influential_aspects,
    disliked_aspects: record.responses.comparison.disliked_aspects,
    improvement_suggestions: record.responses.comparison.improvement_suggestions,
    ...record.responses.sus,
    ...prefixKeys(record.responses.nasa_tlx, 'tlx_'),
    ...record.responses.sassi
  };
  return base;
}

async function appendQuestionnaireAggregate(row) {
  const path = join(QUESTIONNAIRE_OUTPUT_ROOT, 'all-questionnaire-responses.csv');
  let rows = [];
  try {
    const existing = await readFile(path, 'utf8');
    rows = existing.trim() ? existing.trim().split(/\r?\n/) : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const header = Object.keys(row);
  const line = csvLine(header.map((key) => row[key]));
  if (!rows.length) {
    rows.push(csvLine(header));
  }
  rows.push(line);
  await writeFile(path, `${rows.join('\n')}\n`, 'utf8');
}

async function writeCsv(path, rows) {
  if (!rows.length) {
    await writeFile(path, '', 'utf8');
    return;
  }
  const header = Object.keys(rows[0]);
  const content = [csvLine(header), ...rows.map((row) => csvLine(header.map((key) => row[key])))].join('\n');
  await writeFile(path, `${content}\n`, 'utf8');
}

function csvLine(values) {
  return values.map(csvEscape).join(',');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function prefixKeys(object, prefix) {
  return Object.fromEntries(Object.entries(object ?? {}).map(([key, value]) => [`${prefix}${key}`, value]));
}

function mean(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  if (!numbers.length) return null;
  return Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(3));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const QUESTIONNAIRE_SUS_IDS = Array.from({ length: 10 }, (_, index) => `sus_q${index + 1}`);
const QUESTIONNAIRE_TLX_IDS = ['mental_demand', 'physical_demand', 'temporal_demand', 'performance', 'effort', 'frustration'];
const QUESTIONNAIRE_SASSI_CATEGORIES = {
  accuracy: Array.from({ length: 8 }, (_, index) => `accuracy_${index + 1}`),
  likeability: Array.from({ length: 8 }, (_, index) => `likeability_${index + 1}`),
  cognitive_demand: Array.from({ length: 5 }, (_, index) => `cognitive_demand_${index + 1}`),
  annoyance: Array.from({ length: 5 }, (_, index) => `annoyance_${index + 1}`),
  habitability: Array.from({ length: 4 }, (_, index) => `habitability_${index + 1}`),
  speed: Array.from({ length: 2 }, (_, index) => `speed_${index + 1}`)
};
const QUESTIONNAIRE_SASSI_IDS = Object.values(QUESTIONNAIRE_SASSI_CATEGORIES).flat();

function buildSessionMetadata(record) {
  return {
    session_id: record.session_id,
    test_folder_name: record.test_folder_name,
    output_dir: record.output_dir,
    robot_id: record.robot_id,
    photo_id: record.photo_id,
    created_at: record.created_at,
    created_at_local: record.created_at_local,
    updated_at: record.updated_at,
    updated_at_local: record.updated_at_local,
    ended_at: record.ended_at,
    ended_at_local: record.ended_at_local,
    end_reason: record.end_reason,
    user_profile: record.user_profile,
    conversation_duration_minutes: record.conversation_duration_minutes,
    audio: record.audio ?? null
  };
}

function buildRobotMetadata(record) {
  const robotId = String(record.robot_id ?? 'unknown');
  return {
    robot_id: robotId,
    robot_family: inferRobotFamily(robotId),
    platform_role: 'memory-companion-interaction-agent',
    comparison_group: robotId,
    audio_input_source: robotId.toLowerCase().includes('walker') ? 'walker_microphone_or_bridge' : 'temi_microphone_or_browser',
    audio_output_source: robotId.toLowerCase().includes('walker') ? 'walker_speaker_or_bridge' : 'temi_speaker_or_browser',
    vision_source: robotId.toLowerCase().includes('walker') ? 'walker_camera_or_bridge' : 'temi_camera_or_browser',
    recorded_at: record.created_at,
    recorded_at_local: record.created_at_local
  };
}

function inferRobotFamily(robotId) {
  const value = String(robotId ?? '').toLowerCase();
  if (value.includes('walker')) return 'walker';
  if (value.includes('temi')) return 'temi';
  return 'unknown';
}

function buildTimelineEvents(record) {
  const events = [];
  addTimelineEvent(events, record.created_at, 'session_started', {
    session_id: record.session_id,
    participant_name: record.user_profile?.name ?? null,
    robot_id: record.robot_id,
    photo_id: record.photo_id
  });

  for (const turn of record.turns ?? []) {
    const base = {
      session_id: record.session_id,
      robot_id: record.robot_id,
      photo_id: record.photo_id,
      turn: turn.turn,
      topic: turn.theme ?? null,
      question_event_code: turn.question_event?.code ?? null
    };
    addTimelineEvent(events, turn.question_at, 'question_generated', {
      ...base,
      question: turn.question ?? '',
      api_latency_ms: turn.question_generation?.api_latency_ms ?? null,
      fallback_reason: turn.question_generation?.fallback_reason ?? null
    });
    addTimelineEvent(events, turn.question_started_at, 'question_spoken_start', base);
    addTimelineEvent(events, turn.question_ended_at, 'question_spoken_end', base);
    addTimelineEvent(events, turn.answer_started_at, 'user_answer_start', base);
    addTimelineEvent(events, turn.answer_ended_at, 'user_answer_end', {
      ...base,
      answer: turn.answer ?? null,
      answer_duration_ms: durationMs(turn.answer_started_at, turn.answer_ended_at)
    });
    addTimelineEvent(events, turn.feedback_at, 'feedback_generated', {
      ...base,
      feedback: turn.feedback ?? null
    });
  }

  for (const trace of record.turn_taking_traces ?? []) {
    addTimelineEvent(events, trace.captured_at, 'turn_taking_decision', {
      session_id: record.session_id,
      robot_id: record.robot_id,
      photo_id: trace.photo_id ?? record.photo_id,
      turn: trace.turn,
      topic: trace.topic,
      received_sentence: trace.received_sentence,
      pause_time_seconds: trace.pause_time_seconds,
      decision: trace.decision,
      source: trace.source,
      trace: trace.trace ?? null
    });
  }

  addTimelineEvent(events, record.ended_at, 'session_ended', {
    session_id: record.session_id,
    robot_id: record.robot_id,
    photo_id: record.photo_id,
    end_reason: record.end_reason
  });

  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function addTimelineEvent(events, timestamp, event, payload = {}) {
  if (!timestamp) return;
  events.push({
    timestamp,
    timestamp_local: toLocalTimestamp(timestamp),
    event,
    ...payload
  });
}

function buildSessionMetrics(record, datasets = {}) {
  const questionEvents = datasets.questionEvents ?? buildQuestionEvents(record);
  const answerEvents = datasets.answerEvents ?? buildAnswerEvents(record);
  const attentionEvents = datasets.attentionEvents ?? buildAttentionEvents(record);
  const turnTakingEvents = datasets.turnTakingEvents ?? record.turn_taking_traces ?? [];
  const questionCount = questionEvents.length;
  const answers = answerEvents.filter((event) => String(event.answer ?? '').trim());
  const noSpeechAnswers = answers.filter((event) => isNoResponseAnswer(event.answer));
  const validAnswers = answers.filter((event) => !isNoResponseAnswer(event.answer));
  const llmLatencies = questionEvents.map((event) => event.question_generation?.api_latency_ms).filter(isFiniteNumber);
  const ttsLatencies = questionEvents
    .map((event) => durationMs(event.question_at, event.question_started_at))
    .filter(isFiniteNumber);
  const answerDurations = answerEvents
    .map((event) => durationMs(event.answer_started_at, event.answer_ended_at))
    .filter(isFiniteNumber);
  const transitionDurations = computeQuestionTransitionDurations(record.turns ?? []);
  const attentionSummary = buildAttentionSummary(attentionEvents);
  const turnTakingSummary = buildTurnTakingSummary(turnTakingEvents);
  const completedTopics = new Set(questionEvents.map((event) => event.topic).filter(Boolean));
  const topicCoverageRate = THEME_LIBRARY.length
    ? roundNumber(completedTopics.size / THEME_LIBRARY.length, 4)
    : null;
  const validAnswerRate = questionCount ? roundNumber(validAnswers.length / questionCount, 4) : null;
  const noSpeechTimeoutRate = questionCount ? roundNumber(noSpeechAnswers.length / questionCount, 4) : null;
  const completionScore = record.ended_at ? 1 : questionCount >= THEME_LIBRARY.length ? 0.8 : 0;
  const speechQualityScore = average([
    validAnswerRate ?? 0,
    1 - (noSpeechTimeoutRate ?? 0),
    clamp01(1 - (average(ttsLatencies) ?? 0) / 5000),
    clamp01(1 - (turnTakingSummary.average_pause_time_seconds ?? 0) / 7)
  ]);
  const overallInteractionScore = roundNumber(100 * (
    0.3 * completionScore +
    0.25 * (speechQualityScore ?? 0) +
    0.2 * (attentionSummary.attention_rate ?? 0) +
    0.15 * clamp01((average(answerEvents.map((event) => countWords(event.answer)).filter(isFiniteNumber)) ?? 0) / 18) +
    0.1 * 1
  ), 2);

  return {
    session_id: record.session_id,
    test_folder_name: record.test_folder_name,
    participant_name: record.user_profile?.name ?? null,
    robot_id: record.robot_id,
    robot_family: inferRobotFamily(record.robot_id),
    photo_id: record.photo_id,
    completed: Boolean(record.ended_at),
    end_reason: record.end_reason ?? null,
    started_at: record.created_at,
    started_at_local: record.created_at_local,
    ended_at: record.ended_at,
    ended_at_local: record.ended_at_local,
    session_duration_ms: durationMs(record.created_at, record.ended_at),
    question_count: questionCount,
    answered_turn_count: answers.length,
    valid_answer_count: validAnswers.length,
    valid_answer_rate: validAnswerRate,
    no_speech_timeout_count: noSpeechAnswers.length,
    no_speech_timeout_rate: noSpeechTimeoutRate,
    topic_coverage: Object.fromEntries(THEME_LIBRARY.map((theme) => [
      theme,
      questionEvents.filter((event) => event.topic === theme).length
    ])),
    topic_coverage_rate: topicCoverageRate,
    follow_question_count: questionEvents.filter((event) => event.question_event?.is_follow_question).length,
    average_question_generation_latency_ms: roundNumber(average(llmLatencies), 2),
    max_question_generation_latency_ms: roundNumber(max(llmLatencies), 2),
    average_tts_start_latency_ms: roundNumber(average(ttsLatencies), 2),
    average_next_question_transition_ms: roundNumber(average(transitionDurations), 2),
    average_answer_duration_seconds: roundNumber((average(answerDurations) ?? 0) / 1000, 2),
    average_answer_word_count: roundNumber(average(validAnswers.map((event) => countWords(event.answer))), 2),
    attention_rate: attentionSummary.attention_rate,
    attention_sample_count: attentionSummary.total_samples,
    central_gaze_rate: attentionSummary.central_gaze_rate,
    turn_taking: turnTakingSummary,
    audio: {
      session_recording_path: record.audio?.session_recording_path ?? null,
      source_chunk_count: record.audio?.source_chunk_count ?? 0
    },
    system_failures: {
      speaker_failure_count: 0,
      microphone_failure_count: noSpeechAnswers.length,
      camera_failure_count: attentionEvents.length ? 0 : null,
      websocket_reconnect_count: 0
    },
    overall_interaction_score: overallInteractionScore
  };
}

function buildComparisonRow(record, metrics) {
  return {
    participant_name: metrics.participant_name,
    robot_id: metrics.robot_id,
    robot_family: metrics.robot_family,
    session_id: metrics.session_id,
    test_folder_name: metrics.test_folder_name,
    photo_id: metrics.photo_id,
    completed: metrics.completed,
    question_count: metrics.question_count,
    valid_answer_rate: metrics.valid_answer_rate,
    no_speech_timeout_rate: metrics.no_speech_timeout_rate,
    attention_rate: metrics.attention_rate,
    central_gaze_rate: metrics.central_gaze_rate,
    average_question_generation_latency_ms: metrics.average_question_generation_latency_ms,
    average_tts_start_latency_ms: metrics.average_tts_start_latency_ms,
    average_next_question_transition_ms: metrics.average_next_question_transition_ms,
    average_answer_duration_seconds: metrics.average_answer_duration_seconds,
    average_answer_word_count: metrics.average_answer_word_count,
    overall_interaction_score: metrics.overall_interaction_score
  };
}

function buildAttentionSummary(samples) {
  const total = samples.length;
  const centralGaze = samples.filter((sample) => getGazeDirection(sample) === 'central').length;
  const attentive = samples.filter((sample) => {
    const gaze = getGazeDirection(sample);
    const head = getHeadDirection(sample);
    return gaze === 'central' && head !== 'left' && head !== 'right';
  }).length;
  return {
    metric_definition: 'attention_rate = central eye gaze with no left/right head deviation divided by total attention samples',
    total_samples: total,
    attentive_samples: attentive,
    attention_rate: total ? roundNumber(attentive / total, 4) : null,
    central_gaze_samples: centralGaze,
    central_gaze_rate: total ? roundNumber(centralGaze / total, 4) : null,
    head_direction_distribution: countBy(samples, getHeadDirection),
    eye_gaze_direction_distribution: countBy(samples, getGazeDirection)
  };
}

function buildTurnTakingSummary(traces) {
  const total = traces.length;
  const decisions = countBy(traces, (trace) => String(trace.decision ?? 'unknown'));
  const pauseTimes = traces.map((trace) => Number(trace.pause_time_seconds)).filter(isFiniteNumber);
  const serverLatencies = traces.map((trace) => trace.server_latency_ms ?? trace.trace?.server_latency_ms).filter(isFiniteNumber);
  const primaryLatencies = traces.map((trace) => trace.primary_latency_ms ?? trace.trace?.primary_latency_ms).filter(isFiniteNumber);
  return {
    total_decisions: total,
    decision_distribution: decisions,
    trigger_distribution: countBy(traces, (trace) => trace.trigger ?? trace.trace?.metadata?.trigger ?? 'unknown'),
    endpoint_count: decisions['1'] ?? 0,
    keep_listening_count: decisions['0'] ?? 0,
    uncertain_count: decisions['2'] ?? 0,
    average_pause_time_seconds: roundNumber(average(pauseTimes), 3),
    max_pause_time_seconds: roundNumber(max(pauseTimes), 3),
    average_server_latency_ms: roundNumber(average(serverLatencies), 2),
    average_primary_model_latency_ms: roundNumber(average(primaryLatencies), 2)
  };
}

function buildAudioEvents(record) {
  return (record.turns ?? []).map((turn) => ({
    turn: turn.turn,
    topic: turn.theme ?? null,
    question_event_code: turn.question_event?.code ?? null,
    session_audio_path: record.audio?.session_recording_path ?? null,
    audio_source_chunks: Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks : [],
    audio_chunk_count: Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks.length : 0,
    answer_started_at: turn.answer_started_at ?? null,
    answer_started_at_local: turn.answer_started_at_local ?? null,
    answer_ended_at: turn.answer_ended_at ?? null,
    answer_ended_at_local: turn.answer_ended_at_local ?? null
  }));
}

function buildCleanSessionSummary(record) {
  return {
    ...record,
    turns: (record.turns ?? []).map(({ audio_source_chunks, ...turn }) => ({
      ...turn,
      session_audio_path: record.audio?.session_recording_path ?? null,
      audio_chunk_count: Array.isArray(audio_source_chunks) ? audio_source_chunks.length : 0
    }))
  };
}

function buildQuestionEvents(record) {
  return (record.turns ?? []).map((turn) => ({
    turn: turn.turn,
    topic: turn.theme,
    question_event: turn.question_event,
    question: turn.question,
    feedback: turn.feedback ?? null,
    question_generation: turn.question_generation ?? null,
    question_at: turn.question_at ?? null,
    question_at_local: turn.question_at_local ?? null,
    question_started_at: turn.question_started_at ?? null,
    question_started_at_local: turn.question_started_at_local ?? null,
    question_ended_at: turn.question_ended_at ?? null,
    question_ended_at_local: turn.question_ended_at_local ?? null,
    question_generation_latency_ms: turn.question_generation?.api_latency_ms ?? null,
    question_tts_start_latency_ms: durationMs(turn.question_at, turn.question_started_at),
    question_playback_duration_ms: durationMs(turn.question_started_at, turn.question_ended_at),
    feedback_at: turn.feedback_at ?? null,
    feedback_at_local: turn.feedback_at_local ?? null
  }));
}

function buildAnswerEvents(record) {
  return (record.turns ?? []).map((turn) => {
    const endpointTrace = findEndpointTraceForTurn(record, turn.turn);
    return {
      turn: turn.turn,
      topic: turn.theme,
      question_event_code: turn.question_event?.code ?? null,
      question: turn.question ?? '',
      answer: turn.answer ?? null,
      answer_started_at: turn.answer_started_at ?? null,
      answer_started_at_local: turn.answer_started_at_local ?? null,
      answer_ended_at: turn.answer_ended_at ?? null,
      answer_ended_at_local: turn.answer_ended_at_local ?? null,
      answer_duration_ms: durationMs(turn.answer_started_at, turn.answer_ended_at),
      answer_word_count: countWords(turn.answer),
      answer_saved_at: turn.answer_at ?? null,
      answer_saved_at_local: turn.answer_at_local ?? null,
      endpoint_decision: endpointTrace ? {
        captured_at: endpointTrace.captured_at ?? null,
        captured_at_local: endpointTrace.captured_at_local ?? null,
        pause_time_seconds: endpointTrace.pause_time_seconds ?? null,
        decision: endpointTrace.decision ?? null,
        source: endpointTrace.source ?? null,
        trigger: endpointTrace.trigger ?? null,
        received_sentence: endpointTrace.received_sentence ?? null,
        server_latency_ms: endpointTrace.server_latency_ms ?? null
      } : null,
      session_audio_path: record.audio?.session_recording_path ?? null,
      audio_chunk_count: Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks.length : 0
    };
  });
}

function buildInteractionTurns(record) {
  return (record.turns ?? []).map((turn) => {
    const attentionSamples = turn.attention_samples ?? [];
    return {
      session_id: record.session_id,
      participant_name: record.user_profile?.name ?? null,
      robot_id: record.robot_id,
      robot_family: inferRobotFamily(record.robot_id),
      photo_id: record.photo_id,
      turn: turn.turn,
      topic: turn.theme ?? null,
      question_event_code: turn.question_event?.code ?? null,
      is_follow_question: turn.question_event?.is_follow_question ?? false,
      question: {
        text: turn.question ?? '',
        generated_at: turn.question_at ?? null,
        generated_at_local: turn.question_at_local ?? null,
        spoken_started_at: turn.question_started_at ?? null,
        spoken_started_at_local: turn.question_started_at_local ?? null,
        spoken_ended_at: turn.question_ended_at ?? null,
        spoken_ended_at_local: turn.question_ended_at_local ?? null,
        generation_latency_ms: turn.question_generation?.api_latency_ms ?? null,
        tts_start_latency_ms: durationMs(turn.question_at, turn.question_started_at),
        playback_duration_ms: durationMs(turn.question_started_at, turn.question_ended_at),
        generation: turn.question_generation ?? null
      },
      answer: {
        text: turn.answer ?? null,
        started_at: turn.answer_started_at ?? null,
        started_at_local: turn.answer_started_at_local ?? null,
        ended_at: turn.answer_ended_at ?? null,
        ended_at_local: turn.answer_ended_at_local ?? null,
        saved_at: turn.answer_at ?? null,
        saved_at_local: turn.answer_at_local ?? null,
        duration_ms: durationMs(turn.answer_started_at, turn.answer_ended_at),
        word_count: countWords(turn.answer),
        is_no_response: isNoResponseAnswer(turn.answer)
      },
      endpoint_decision: findEndpointTraceForTurn(record, turn.turn),
      feedback: {
        text: turn.feedback ?? null,
        generated_at: turn.feedback_at ?? null,
        generated_at_local: turn.feedback_at_local ?? null
      },
      transition: {
        question_end_to_answer_start_ms: durationMs(turn.question_ended_at, turn.answer_started_at),
        answer_end_to_feedback_ms: durationMs(turn.answer_ended_at, turn.feedback_at)
      },
      attention: buildAttentionSummary(attentionSamples.map((sample) => ({
        turn: turn.turn,
        topic: turn.theme,
        question_event_code: turn.question_event?.code ?? null,
        ...sample
      }))),
      audio: {
        session_audio_path: record.audio?.session_recording_path ?? null,
        audio_source_chunks: Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks : [],
        audio_chunk_count: Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks.length : 0
      }
    };
  });
}

function buildAttentionEvents(record) {
  return (record.turns ?? []).flatMap((turn) =>
    (turn.attention_samples ?? []).map((sample) => ({
      turn: turn.turn,
      topic: turn.theme,
      question_event_code: turn.question_event?.code ?? null,
      ...sample
    }))
  );
}

async function combineSessionAudio(record) {
  const chunks = (record.turns ?? [])
    .flatMap((turn) => Array.isArray(turn.audio_source_chunks) ? turn.audio_source_chunks : [])
    .filter((path, index, paths) => path && paths.indexOf(path) === index);
  if (!chunks.length) {
    return;
  }

  const outputDir = record.output_dir || getSessionOutputDir(record.session_id, record.user_profile, record.created_at, record.robot_id);
  const audioDir = join(outputDir, '07_audio');
  const legacyAudioDir = join(outputDir, '06_audio');
  await mkdir(audioDir, { recursive: true });
  await mkdir(legacyAudioDir, { recursive: true });
  const outputPath = join(audioDir, 'session-recording.wav');
  const wav = await concatenateWavFiles(chunks);
  await writeFile(outputPath, wav);
  await writeFile(join(legacyAudioDir, 'session-recording.wav'), wav);
  const updatedAt = new Date().toISOString();
  record.audio = {
    session_recording_path: outputPath,
    legacy_session_recording_path: join(legacyAudioDir, 'session-recording.wav'),
    source_chunk_count: chunks.length,
    updated_at: updatedAt,
    updated_at_local: toLocalTimestamp(updatedAt)
  };
}

async function concatenateWavFiles(paths) {
  const pcmParts = [];
  let sampleRate = 44100;
  let channels = 2;
  let bitsPerSample = 16;

  for (const path of paths) {
    let buffer;
    try {
      buffer = await readFile(path);
    } catch {
      continue;
    }
    const parsed = parseWavBuffer(buffer);
    if (!parsed) continue;
    sampleRate = parsed.sampleRate;
    channels = parsed.channels;
    bitsPerSample = parsed.bitsPerSample;
    pcmParts.push(parsed.data);
  }

  if (!pcmParts.length) {
    throw new Error('No valid audio chunks were available to combine.');
  }

  return createWavBuffer(Buffer.concat(pcmParts), { sampleRate, channels, bitsPerSample });
}

function parseWavBuffer(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(chunkStart, Math.min(chunkStart + chunkSize, buffer.length));
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!format || !data || format.audioFormat !== 1) {
    return null;
  }

  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    data
  };
}

function createWavBuffer(pcmData, { sampleRate, channels, bitsPerSample }) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function mergeUniquePaths(existing, incoming) {
  return [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .filter(Boolean)
    .filter((path, index, paths) => paths.indexOf(path) === index);
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const duration = endMs - startMs;
  return duration >= 0 ? duration : null;
}

function average(values) {
  const clean = values.filter(isFiniteNumber);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function max(values) {
  const clean = values.filter(isFiniteNumber);
  return clean.length ? Math.max(...clean) : null;
}

function roundNumber(value, digits = 2) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value) {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function countWords(value) {
  const words = String(value ?? '').trim().match(/[A-Za-z0-9']+/g);
  return words ? words.length : 0;
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item) || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function getHeadDirection(sample) {
  return String(sample?.head_direction ?? sample?.headDirection ?? sample?.headPoseDirection ?? 'unknown').toLowerCase();
}

function getGazeDirection(sample) {
  return String(sample?.eye_gaze_direction ?? sample?.eyeGazeDirection ?? sample?.gazeDirection ?? 'unknown').toLowerCase();
}

function computeQuestionTransitionDurations(turns) {
  return [...turns]
    .sort((a, b) => Number(a.turn ?? 0) - Number(b.turn ?? 0))
    .map((turn, index, sortedTurns) => {
      const nextTurn = sortedTurns[index + 1];
      if (!nextTurn) return null;
      return durationMs(turn.answer_ended_at ?? turn.feedback_at, nextTurn.question_started_at ?? nextTurn.question_at);
    })
    .filter(isFiniteNumber);
}

function findEndpointTraceForTurn(record, turn) {
  return [...(record.turn_taking_traces ?? [])]
    .filter((trace) => Number(trace.turn) === Number(turn) && Number(trace.decision) === 1)
    .sort((a, b) => new Date(b.captured_at ?? 0).getTime() - new Date(a.captured_at ?? 0).getTime())[0] ?? null;
}

function normaliseSessionId(sessionId) {
  return String(sessionId || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getSessionOutputDir(sessionId, profile = {}, createdAt = new Date().toISOString(), robotId = 'unknown') {
  const userName = sanitizePathPart(profile?.name || 'unknown-user');
  const robotName = sanitizePathPart(robotId || 'unknown-robot');
  const timestamp = formatFolderTimestamp(createdAt);
  const baseName = `${userName}_${timestamp}_${robotName}`;
  return join(SESSION_OUTPUT_ROOT, baseName);
}

function sanitizePathPart(value) {
  const safe = String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (safe || 'unknown-user').slice(0, 60);
}

function formatFolderTimestamp(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.LOCAL_TIME_ZONE || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(Number.isNaN(date.getTime()) ? new Date() : date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

function getLocalNetworkAddress() {
  const interfaces = networkInterfaces();
  const candidates = Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
  return candidates.find((address) => address.startsWith('192.168.1.')) ?? candidates[0] ?? '127.0.0.1';
}

async function getMobileUploadBaseUrl() {
  const localBaseUrl = `http://${getLocalNetworkAddress()}:${PORT}`;
  const now = Date.now();
  if (cachedReachableUploadBaseUrl && now - cachedReachableUploadBaseUrlCheckedAt < 300_000) {
    return cachedReachableUploadBaseUrl;
  }

  const configured = normaliseUploadBaseUrl(process.env.PUBLIC_UPLOAD_BASE_URL);
  if (configured && await isReachableUploadBaseUrl(configured, 900)) {
    cachedReachableUploadBaseUrl = configured;
    cachedReachableUploadBaseUrlCheckedAt = now;
    return configured;
  }

  try {
    const fileValue = await readFile(PUBLIC_UPLOAD_URL_FILE, 'utf8');
    const fromFile = normaliseUploadBaseUrl(fileValue);
    if (fromFile && fromFile !== configured && await isReachableUploadBaseUrl(fromFile, 900)) {
      cachedReachableUploadBaseUrl = fromFile;
      cachedReachableUploadBaseUrlCheckedAt = now;
      return fromFile;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Could not read public upload URL file: ${error instanceof Error ? error.message : error}`);
    }
  }

  cachedReachableUploadBaseUrl = '';
  cachedReachableUploadBaseUrlCheckedAt = now;
  return localBaseUrl;
}

async function isReachableUploadBaseUrl(baseUrl, timeoutMs = 900) {
  try {
    const response = await fetch(`${baseUrl}/upload-health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function normaliseUploadBaseUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.includes('your-public-url')) {
    return '';
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isPublicUploadUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname)
      && !hostname.startsWith('192.168.')
      && !hostname.startsWith('10.')
      && !/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
  } catch {
    return false;
  }
}

function renderMobileUploadPage(sessionId) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload Photos</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #eef3f5; color: #14232c; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    section { width: min(560px, 100%); background: #fff; border: 1px solid #d8e1e5; border-radius: 8px; padding: 28px; box-shadow: 0 18px 50px rgba(20, 35, 44, 0.12); }
    h1 { margin: 0 0 10px; font-size: 2rem; }
    p { color: #5d6d78; line-height: 1.5; }
    input { width: 100%; padding: 16px; border: 1px solid #bdcbd3; border-radius: 6px; box-sizing: border-box; background: #fbfcfd; }
    button { width: 100%; min-height: 52px; margin-top: 18px; border: 0; border-radius: 6px; background: #176b72; color: #fff; font-size: 1rem; font-weight: 800; }
    .status { margin-top: 18px; font-weight: 800; color: #176b72; }
    .error { color: #a72d2d; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Upload Two Photos</h1>
      <p>Select exactly two image files. They will appear on the robot screen for the reminiscence conversation.</p>
      <input id="files" type="file" accept="image/*" multiple />
      <button id="upload" type="button">Upload Photos</button>
      <p id="status" class="status"></p>
    </section>
  </main>
  <script>
    const status = document.getElementById('status');
    const files = document.getElementById('files');
    const upload = document.getElementById('upload');
    const uploadEndpoint = new URL(window.location.pathname, window.location.origin).toString();
    const toDataUrl = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the image.'));
      reader.readAsDataURL(file);
    });
    const compressImage = async (file) => {
      const original = await toDataUrl(file);
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Could not decode the image.'));
        image.src = original;
      });
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.82);
    };
    upload.addEventListener('click', async () => {
      status.className = 'status';
      status.textContent = '';
      const selected = Array.from(files.files || []);
      if (selected.length !== 2) {
        status.className = 'status error';
        status.textContent = 'Please choose exactly two photos.';
        return;
      }
      try {
        upload.disabled = true;
        status.textContent = "Cool! I'm processing your photos. Please wait a few seconds.";
        const photos = await Promise.all(selected.map(async (file, index) => ({
          id: 'phone-photo-' + Date.now().toString(36) + '-' + index,
          name: file.name,
          size: file.size,
          dataUrl: await compressImage(file)
        })));
        const response = await fetch(uploadEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ photos })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Upload failed.');
        status.textContent = "Your photos are ready. Please return to the robot screen and let's continue with the reminiscence.";
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Upload failed.';
      } finally {
        upload.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function publishWalkerSpeechViaRosBridge({ text, rosIp, rosPort }) {
  try {
    await publishWalkerSpeechViaDirectAudio(text);
    return { ros_bridge_url: null, fallback: 'ssh_audio' };
  } catch (error) {
    console.warn(`Walker direct audio playback failed: ${error instanceof Error ? error.message : error}`);
  }

  const candidates = getWalkerRosBridgeCandidates(rosIp, rosPort);
  const failures = [];

  for (const url of candidates) {
    try {
      await publishWalkerSpeechToUrl(url, text);
      return { ros_bridge_url: url };
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await publishWalkerSpeechViaSsh(text);
    return { ros_bridge_url: null, fallback: 'ssh_rostopic' };
  } catch (error) {
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to Walker ROSBridge. Tried ${failures.join('; ')}. SSH /say fallback failed: ${fallbackMessage}`);
  }
}

async function publishWalkerSpeechViaDirectAudio(text) {
  const audio = await synthesizeWindowsSpeech(text);
  await playWalkerAudioBuffer(audio);
}

async function playWalkerAudioBuffer(audio) {
  const remotePath = `/tmp/memory_companion_speech_${Date.now()}.wav`;
  const command = [
    `cat > ${remotePath}`,
    `USB_SINK=$(pactl list short sinks 2>/dev/null | awk '/usb-Jieli|UACDemo/{print $1; exit}')`,
    `if [ -n "$USB_SINK" ]; then pactl set-default-sink "$USB_SINK" || true; pactl set-sink-mute "$USB_SINK" 0 || true; pactl set-sink-volume "$USB_SINK" 60% || true; fi`,
    `(paplay ${remotePath} || aplay -q ${remotePath})`,
    `rm -f ${remotePath}`
  ].join('; ');
  await runWalkerSshWithInput(command, audio, 35_000);
}

async function playTemiAudioBuffer(audio) {
  const playableAudio = ensureStereoPcmWav(audio);
  const localAudio = join(tmpdir(), `temi-speech-${randomUUID()}.wav`);
  const remoteAudio = `/sdcard/memory_companion_speech_${Date.now()}.wav`;
  await writeFile(localAudio, playableAudio);
  try {
    await execFileAsync(adbPath(), ['connect', TEMI_ADDRESS], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'push', localAudio, remoteAudio], {
      windowsHide: true,
      timeout: 20_000
    });
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '5'], {
      windowsHide: true,
      timeout: 8_000
    }).catch(() => undefined);
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'tinyplay', remoteAudio], {
      windowsHide: true,
      timeout: 35_000
    });
  } finally {
    await unlink(localAudio).catch(() => undefined);
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'rm', '-f', remoteAudio], {
      windowsHide: true,
      timeout: 5_000
    }).catch(() => undefined);
  }
}

function ensureStereoPcmWav(audio) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return audio;
  }

  let offset = 12;
  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (id === 'fmt ') {
      fmtOffset = payloadOffset;
      fmtSize = size;
    } else if (id === 'data') {
      dataOffset = payloadOffset;
      dataSize = size;
      break;
    }
    offset = payloadOffset + size + (size % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0 || fmtSize < 16) {
    return audio;
  }

  const audioFormat = audio.readUInt16LE(fmtOffset);
  const channels = audio.readUInt16LE(fmtOffset + 2);
  const sampleRate = audio.readUInt32LE(fmtOffset + 4);
  const bitsPerSample = audio.readUInt16LE(fmtOffset + 14);
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
    return audio;
  }

  const mono = audio.subarray(dataOffset, dataOffset + dataSize);
  const stereo = Buffer.alloc(mono.length * 2);
  for (let source = 0, target = 0; source + 1 < mono.length; source += 2, target += 4) {
    const sample = mono.readInt16LE(source);
    stereo.writeInt16LE(sample, target);
    stereo.writeInt16LE(sample, target + 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + stereo.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * 2, 28);
  header.writeUInt16LE(2 * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(stereo.length, 40);
  return Buffer.concat([header, stereo]);
}

async function publishWalkerSpeechViaSsh(text) {
  const textBase64 = Buffer.from(String(text), 'utf8').toString('base64');
  const command = [
    'source /opt/ros/melodic/setup.bash',
    'source /home/pi/catkin_ws/devel/setup.bash',
    `python -c "import base64, rospy; from std_msgs.msg import String; rospy.init_node('memory_companion_say_once', anonymous=True); pub=rospy.Publisher('/say', String, queue_size=1, latch=True); rospy.sleep(0.4); pub.publish(String(data=base64.b64decode('${textBase64}').decode('utf-8'))); rospy.sleep(3.0)"`
  ].join('; ');
  await runWalkerSsh(command, 12_000);
}

function getWalkerRosBridgeCandidates(rosIp, rosPort) {
  const ips = [
    rosIp,
    process.env.WALKER_ROS_IP,
    'localhost',
    '127.0.0.1',
    '192.168.4.1'
  ].map(normaliseRosHost).filter(Boolean);
  const ports = [
    rosPort,
    process.env.WALKER_ROS_PORT,
    '9090',
    '9091'
  ].map((value) => String(value ?? '').trim()).filter(Boolean);

  const urls = [];
  for (const ip of uniqueStrings(ips)) {
    for (const port of uniqueStrings(ports)) {
      urls.push(`ws://${ip}:${port}`);
    }
  }
  return uniqueStrings(urls);
}

function normaliseRosHost(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `ws://${trimmed}`);
    return parsed.hostname;
  } catch {
    return trimmed.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
  }
}

function uniqueStrings(values) {
  return values.filter((value, index, array) => value && array.indexOf(value) === index);
}

function publishWalkerSpeechToUrl(url, text) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let lightTimer = null;
    let talking = false;
    let observedTalking = false;
    let settled = false;
    const startedAt = Date.now();
    const fallbackMs = estimateWalkerSpeechDurationMs(text);

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (lightTimer) clearInterval(lightTimer);
      if (socket.readyState === WebSocket.OPEN) {
        publishWalkerLights(socket, false);
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Ignore close errors.
        }
      }, 60);
      if (error) reject(error);
      else resolve();
    };

    const connectTimeout = setTimeout(() => finish(new Error('connection timeout')), 2500);

    socket.on('open', async () => {
      clearTimeout(connectTimeout);
      advertiseRosTopic(socket, '/lights/str', 'std_msgs/String');
      advertiseRosTopic(socket, '/say', 'std_msgs/String');
      subscribeRosTopic(socket, '/talking', 'std_msgs/Bool');

      await new Promise((ready) => setTimeout(ready, 140));
      publishRosString(socket, '/say', text.trim());

      const speechTimer = setInterval(() => {
        observedTalking = observedTalking || talking;
        const elapsed = Date.now() - startedAt;
        if (observedTalking && !talking && elapsed > 650) {
          clearInterval(speechTimer);
          finish();
        } else if (elapsed > fallbackMs) {
          clearInterval(speechTimer);
          finish();
        }
      }, 160);
    });

    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.topic === '/talking') {
          talking = message.msg?.data === true;
        }
      } catch {
        // Ignore non-JSON bridge traffic.
      }
    });

    socket.on('error', () => finish(new Error('websocket error')));
    socket.on('close', () => {
      if (!settled) finish(new Error('connection closed'));
    });
  });
}

function advertiseRosTopic(socket, topic, type) {
  socket.send(JSON.stringify({ op: 'advertise', topic, type }));
}

function subscribeRosTopic(socket, topic, type) {
  socket.send(JSON.stringify({ op: 'subscribe', topic, type }));
}

function publishRosString(socket, topic, data) {
  socket.send(JSON.stringify({ op: 'publish', topic, msg: { data } }));
}

function publishWalkerLights(socket, enabled) {
  const commands = enabled
    ? ['left,40,180,120,220', 'right,40,180,120,220']
    : ['left,1,1,1,0', 'right,1,1,1,0'];
  for (const command of commands) {
    publishRosString(socket, '/lights/str', command);
  }
}

function estimateWalkerSpeechDurationMs(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1500, Math.min(16_000, words * 430 + 900));
}

async function readJsonBody(request, maxSize = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function recognizeWindowsSpeech(base64Audio) {
  const inputPath = join(tmpdir(), `memory-answer-${randomUUID()}.wav`);
  await writeFile(inputPath, Buffer.from(base64Audio, 'base64'));
  const python = join(process.cwd(), 'speech-local', 'Scripts', 'python.exe');
  const transcriber = join(process.cwd(), 'scripts', 'transcribe_vosk.py');
  const model = join(tmpdir(), 'temi-vosk-model', 'vosk-model-small-en-us-0.15');

  try {
    const { stdout } = await execFileAsync(python, [transcriber, inputPath, model], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } finally {
    await unlink(inputPath).catch(() => undefined);
  }
}

async function startWalkerRecording() {
  const command = `pkill -x arecord || true; sleep 0.2; rm -f ${WALKER_RECORDING_PATH}; nohup arecord -q -D plughw:CARD=C920,DEV=0 -f S16_LE -r 16000 -c 1 ${WALKER_RECORDING_PATH} >/tmp/memory_companion_walker_arecord.log 2>&1 </dev/null & echo started`;
  await runWalkerSsh(command, 10_000);
}

async function stopWalkerRecordingAndTranscribe(metadata = {}) {
  const command = [
    'pkill -x arecord || true',
    'sleep 0.35',
    `if [ ! -s ${WALKER_RECORDING_PATH} ]; then cat /tmp/memory_companion_walker_arecord.log 2>/dev/null >&2; exit 2; fi`,
    `base64 -w 0 ${WALKER_RECORDING_PATH}`
  ].join('; ');
  const { stdout } = await runWalkerSsh(command, 25_000, 16 * 1024 * 1024);
  const audio = stdout.trim();
  if (!audio) {
    throw new Error('Walker microphone did not return audio.');
  }

  const localAudio = join(tmpdir(), `walker-answer-${randomUUID()}.wav`);
  await writeFile(localAudio, Buffer.from(audio, 'base64'));
  try {
    const archivedAudioPath = await archiveTemiAudio(localAudio, metadata);
    const transcript = await transcribeWavFile(localAudio);
    return { transcript, audio_path: archivedAudioPath };
  } finally {
    await unlink(localAudio).catch(() => undefined);
  }
}

async function runWalkerSsh(command, timeout = 15_000, maxBuffer = 1024 * 1024) {
  const plink = join(process.cwd(), 'tools', 'plink.exe');
  const args = [
    '-ssh',
    `${WALKER_SSH_USER}@${WALKER_SSH_HOST}`,
    '-pw',
    WALKER_SSH_PASSWORD,
    '-batch',
    '-hostkey',
    'ssh-ed25519 255 SHA256:ni13P4DdEqtYmwVzTw9/9gbQ+5M9e83fe4WTuw9u/Ko',
    command
  ];
  return await execFileAsync(plink, args, { windowsHide: true, timeout, maxBuffer });
}

function runWalkerSshWithInput(command, input, timeout = 15_000) {
  const plink = join(process.cwd(), 'tools', 'plink.exe');
  const args = [
    '-ssh',
    `${WALKER_SSH_USER}@${WALKER_SSH_HOST}`,
    '-pw',
    WALKER_SSH_PASSWORD,
    '-batch',
    '-hostkey',
    'ssh-ed25519 255 SHA256:ni13P4DdEqtYmwVzTw9/9gbQ+5M9e83fe4WTuw9u/Ko',
    command
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(plink, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Walker SSH audio playback timed out after ${timeout}ms.`));
    }, timeout);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        if (stderrText) console.warn(`Walker SSH audio stderr: ${stderrText}`);
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText });
      } else {
        reject(new Error(stderrText || `Walker SSH audio playback exited with code ${code}.`));
      }
    });

    child.stdin.end(input);
  });
}

function adbPath() {
  return join(process.cwd(), 'android-tools', 'platform-tools', 'adb.exe');
}

async function applyTemiStaticLock() {
  await execFileAsync(adbPath(), ['connect', TEMI_ADDRESS], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
  const settings = [
    ['global', 'follow_me', '0'],
    ['secure', 'follow_me', '0'],
    ['system', 'follow_me', '0'],
    ['global', 'face_tracking_enabled', '0'],
    ['secure', 'face_tracking_enabled', '0'],
    ['system', 'face_tracking_enabled', '0'],
    ['global', 'user_tracking_enabled', '0'],
    ['secure', 'user_tracking_enabled', '0'],
    ['system', 'user_tracking_enabled', '0'],
    ['global', 'aob_auto_enable', '0'],
    ['secure', 'aob_auto_enable', '0'],
    ['system', 'aob_auto_enable', '0'],
    ['global', 'aob_enabled', '0'],
    ['secure', 'aob_enabled', '0'],
    ['system', 'aob_enabled', '0'],
    ['global', 'auto_obstacle_bypass', '0'],
    ['secure', 'auto_obstacle_bypass', '0'],
    ['system', 'auto_obstacle_bypass', '0'],
    ['system', 'accelerometer_rotation', '0'],
    ['system', 'user_rotation', '0']
  ];

  for (const [namespace, key, value] of settings) {
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'settings', 'put', namespace, key, value], {
      windowsHide: true,
      timeout: 10_000
    }).catch(() => undefined);
  }

  await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'am', 'force-stop', 'com.robotemi.face'], {
    windowsHide: true,
    timeout: 10_000
  }).catch(() => undefined);
}

async function startTemiRecording() {
  await execFileAsync(adbPath(), ['connect', TEMI_ADDRESS], { windowsHide: true, timeout: 10_000 });
  await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'pkill', 'tinycap'], {
    windowsHide: true,
    timeout: 10_000
  }).catch(() => undefined);

  temiRecorder = spawn(
    adbPath(),
    [
      '-s', TEMI_ADDRESS, 'shell', 'tinycap', TEMI_AUDIO_PATH,
      '-D', '0', '-d', '0', '-c', '2', '-r', '44100', '-b', '16', '-T', '120'
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (temiRecorder.exitCode !== null) {
    temiRecorder = null;
    throw new Error('temi microphone could not be started.');
  }
}

async function stopTemiRecordingAndTranscribe(metadata = {}) {
  await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'shell', 'pkill', 'tinycap'], {
    windowsHide: true,
    timeout: 10_000
  }).catch(() => undefined);
  temiRecorder?.kill();
  temiRecorder = null;
  await new Promise((resolve) => setTimeout(resolve, 500));

  const localAudio = join(tmpdir(), `temi-answer-${randomUUID()}.wav`);
  try {
    await execFileAsync(adbPath(), ['-s', TEMI_ADDRESS, 'pull', TEMI_AUDIO_PATH, localAudio], {
      windowsHide: true,
      timeout: 20_000
    });
    const stats = await stat(localAudio);
    if (stats.size <= 44) {
      throw new Error('temi did not capture any microphone audio.');
    }
    const archivedAudioPath = await archiveTemiAudio(localAudio, metadata);
    const transcript = await transcribeWavFile(localAudio);
    return { transcript, audio_path: archivedAudioPath };
  } finally {
    await unlink(localAudio).catch(() => undefined);
  }
}

async function archiveTemiAudio(localAudio, metadata = {}) {
  const session = normaliseSessionId(metadata.session_id || 'unknown-session');
  const audioDir = join(AUDIO_CHUNK_TEMP_DIR, session);
  await mkdir(audioDir, { recursive: true });
  const photo = String(metadata.photo_id || 'unknown-photo').replace(/[^a-zA-Z0-9_-]/g, '_');
  const turn = String(metadata.turn || 0).replace(/[^a-zA-Z0-9_-]/g, '_');
  const reason = String(metadata.reason || 'recording').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${session}_${photo}_turn${turn}_${reason}_${Date.now()}.wav`;
  const outputPath = join(audioDir, fileName);
  await copyFile(localAudio, outputPath);
  return outputPath;
}

async function transcribeWavFile(inputPath) {
  try {
    return await transcribeOpenAIAudioFile(inputPath);
  } catch (error) {
    console.warn(`OpenAI transcription failed, falling back to local Vosk: ${error instanceof Error ? error.message : error}`);
  }

  const python = join(process.cwd(), 'speech-local', 'Scripts', 'python.exe');
  const transcriber = join(process.cwd(), 'scripts', 'transcribe_vosk.py');
  const model = join(tmpdir(), 'temi-vosk-model', 'vosk-model-small-en-us-0.15');
  const { stdout } = await execFileAsync(python, [transcriber, inputPath, model], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function transcribeOpenAIAudioFile(inputPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const audio = await readFile(inputPath);
  const form = new FormData();
  form.append('model', OPENAI_TRANSCRIPTION_MODEL);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'walker-answer.wav');
  form.append('language', 'en');
  form.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.error?.message ?? `OpenAI transcription returned HTTP ${response.status}.`);
  }
  return String(result.text ?? '').trim();
}

async function synthesizeRobotSpeech(text) {
  try {
    return await synthesizeOpenAISpeech(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown OpenAI TTS error.';
    console.warn(`OpenAI TTS failed, falling back to Windows speech: ${detail}`);
    return await synthesizeWindowsSpeech(text);
  }
}

async function synthesizeOpenAISpeech(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      instructions: 'Speak with a clearly feminine adult voice in a clear British accent. Use a gentle, friendly pace suitable for an older adult reminiscence conversation.',
      response_format: 'wav',
      speed: 1.0
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    let message = `OpenAI TTS returned HTTP ${response.status}.`;
    try {
      const result = await response.json();
      message = result?.error?.message ?? message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeWindowsSpeech(text) {
  const outputPath = join(tmpdir(), `memory-question-${randomUUID()}.wav`);
  const textBase64 = Buffer.from(text, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    `$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textBase64}'))`,
    `$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `$femaleVoice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female } | Select-Object -First 1`,
    `if ($femaleVoice) { $speaker.SelectVoice($femaleVoice.VoiceInfo.Name) }`,
    `$speaker.Rate = -1`,
    `$speaker.SetOutputToWaveFile('${outputPath.replaceAll("'", "''")}')`,
    '$speaker.Speak($text)',
    '$speaker.Dispose()'
  ].join('; ');
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
      windowsHide: true,
      timeout: 15_000
    });
    return await readFile(outputPath);
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket.io backend listening on all network interfaces at port ${PORT}`);
  QRCode.toDataURL(`http://127.0.0.1:${PORT}/upload-health`, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 64
  }).catch((error) => {
    console.warn(`Could not warm up QR generation: ${error instanceof Error ? error.message : error}`);
  });
});
