import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const ROOT = resolve('.');
const OUT_DIR = join(ROOT, 'outputs', 'page-flow-screenshots', timestampName());
const USER_DATA_DIR = join(ROOT, 'tmp', 'chrome-flow-screenshot-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9224;
const APP_URL = 'http://localhost:4200/?robot=temi-v3-192.168.1.109&screenshots=1';
const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false };

await mkdir(OUT_DIR, { recursive: true });
await rm(USER_DATA_DIR, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  'about:blank'
], { stdio: 'ignore' });

try {
  const tab = await createTab(APP_URL);
  const cdp = await connect(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await waitForApp(cdp);

  const session = await createUploadSession();
  const photos = createSamplePhotos();

  await setAppState(cdp, `
    app.step.set('introduction');
  `);
  await screenshot(cdp, '01-introduction.png');

  await setAppState(cdp, `
    app.robotService.setUserName('Harry');
    app.robotService.setAge(72);
    app.robotService.setGender('male');
    app.step.set('registration');
  `);
  await screenshot(cdp, '02-user-registration.png');

  await setAppState(cdp, `
    app.step.set('calibration');
  `);
  await cdp.wait(400);
  await cdp.evaluate(`
    (() => {
      const calibration = window.ng.getComponent(document.querySelector('app-calibration'));
      calibration.cameraReady.set(true);
      calibration.faceAligned.set(true);
      calibration.sampleCount.set(50);
      calibration.message.set('Calibration complete. Select Continue to go to the next page.');
      window.ng.applyChanges(calibration);
    })()
  `);
  await screenshot(cdp, '03-calibration.png');

  await setAppState(cdp, `
    app.uploadSessionId.set(${JSON.stringify(session.session_id)});
    app.uploadUrl.set(${JSON.stringify(session.upload_url)});
    app.qrDataUrl.set(${JSON.stringify(session.qr_data_url)});
    app.isPublicUploadUrl.set(${JSON.stringify(session.is_public_upload_url === true)});
    app.uploadedPhotos.set([]);
    app.step.set('qr-upload');
  `);
  await screenshot(cdp, '04-qr-upload.png');

  await cdp.send('Page.navigate', { url: session.upload_url });
  await cdp.waitForLoad();
  await screenshot(cdp, '05-phone-upload-page.png');

  await cdp.send('Page.navigate', { url: APP_URL });
  await cdp.waitForLoad();
  await waitForApp(cdp);
  await setAppState(cdp, `
    app.uploadedPhotos.set(${JSON.stringify(photos)});
    app.completedPhotoIds.set([]);
    app.selectedPhotoId.set('');
    app.step.set('photo-selection');
  `);
  await screenshot(cdp, '06-photo-selection.png');

  await setAppState(cdp, `
    const photos = ${JSON.stringify(photos)};
    app.conversationService.currentPhoto.set(photos[0]);
    app.conversationService.status.set('active');
    app.conversationService.turns.set([
      { turn: 1, theme: 'where', question: 'Where do you think this photo was taken?', answer: 'It looks like a family garden.' }
    ]);
    app.conversationService.activeQuestion.set('Who does this place or moment remind you of?');
    app.conversationService.draftAnswer.set('');
    app.conversationService.isListening.set(true);
    app.conversationService.remainingTimeLabel.set('1 / 4 themes');
    app.step.set('conversation');
  `);
  await screenshot(cdp, '07-conversation.png');

  await setAppState(cdp, `
    app.uploadedPhotos.set(${JSON.stringify(photos)});
    app.completedPhotoIds.set([${JSON.stringify(photos[0].id)}]);
    app.selectedPhotoId.set('');
    app.step.set('photo-selection');
  `);
  await screenshot(cdp, '08-photo-selection-after-first-photo.png');

  await cdp.send('Page.navigate', { url: 'http://localhost:4200/?mode=questionnaire' });
  await cdp.waitForLoad();
  await cdp.wait(800);
  await screenshot(cdp, '09-questionnaire.png', { captureBeyondViewport: true });

  console.log(OUT_DIR);
} finally {
  chrome.kill();
}

async function createUploadSession() {
  const response = await fetch('http://localhost:3000/mobile-upload-session', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Could not create upload session: HTTP ${response.status}`);
  }
  return response.json();
}

async function createTab(url) {
  await waitForDebugPort();
  const response = await fetch(`http://localhost:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => null);
  if (response?.ok) return response.json();
  const list = await (await fetch(`http://localhost:${DEBUG_PORT}/json/list`)).json();
  return list[0];
}

async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {});
      return;
    }
    const callbacks = listeners.get(message.method);
    callbacks?.forEach((callback) => callback(message.params ?? {}));
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, callback) {
      const callbacks = listeners.get(method) ?? [];
      callbacks.push(callback);
      listeners.set(method, callbacks);
    },
    wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    evaluate(expression) {
      return this.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
    },
    waitForLoad() {
      return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        this.on('Page.loadEventFired', () => {
          clearTimeout(timeout);
          setTimeout(resolve, 300);
        });
      });
    }
  };
}

async function waitForApp(cdp) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const result = await cdp.evaluate(`
      Boolean(window.ng && document.querySelector('app-root') && window.ng.getComponent(document.querySelector('app-root')))
    `);
    if (result.result?.value) return;
    await cdp.wait(250);
  }
  throw new Error('Angular app did not become available.');
}

async function setAppState(cdp, body) {
  await cdp.evaluate(`
    (() => {
      const app = window.ng.getComponent(document.querySelector('app-root'));
      ${body}
      window.ng.applyChanges(app);
    })()
  `);
  await cdp.wait(600);
}

async function screenshot(cdp, fileName, options = {}) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: options.captureBeyondViewport === true
  });
  await writeFile(join(OUT_DIR, fileName), Buffer.from(result.data, 'base64'));
}

async function waitForDebugPort() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Chrome debugging port did not start.');
}

function createSamplePhotos() {
  return [
    {
      id: 'demo-photo-1',
      name: 'family-garden.jpg',
      size: 184000,
      uploadedAt: Date.now(),
      dataUrl: svgDataUrl('#1f7a6f', '#f3d39a', 'Family Garden')
    },
    {
      id: 'demo-photo-2',
      name: 'seaside-walk.jpg',
      size: 192000,
      uploadedAt: Date.now(),
      dataUrl: svgDataUrl('#2d6cdf', '#f7efe2', 'Seaside Walk')
    }
  ];
}

function svgDataUrl(primary, secondary, label) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
      <rect width="1200" height="800" fill="${secondary}"/>
      <circle cx="220" cy="170" r="100" fill="${primary}" opacity="0.9"/>
      <rect x="120" y="390" width="960" height="250" rx="28" fill="${primary}" opacity="0.82"/>
      <circle cx="520" cy="360" r="72" fill="#ffffff" opacity="0.92"/>
      <circle cx="680" cy="360" r="72" fill="#ffffff" opacity="0.92"/>
      <path d="M180 620 C330 490, 450 490, 600 620 S880 750, 1040 610" fill="none" stroke="#ffffff" stroke-width="34" stroke-linecap="round" opacity="0.88"/>
      <text x="600" y="735" text-anchor="middle" font-family="Arial, sans-serif" font-size="58" font-weight="700" fill="#17242e">${label}</text>
    </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function timestampName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
