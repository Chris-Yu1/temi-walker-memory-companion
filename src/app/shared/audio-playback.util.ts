const DATA_AUDIO_PREFIX = /^data:audio\/[a-z0-9.+-]+;base64,/i;
let sharedAudioContext: AudioContext | null = null;
const activeSources = new Map<AudioBufferSourceNode, () => void>();

export function toAudioDataUrl(base64Audio: string): string {
  const trimmedAudio = base64Audio.trim();

  if (DATA_AUDIO_PREFIX.test(trimmedAudio)) {
    return trimmedAudio;
  }

  const mimeType = detectAudioMimeType(trimmedAudio);
  return `data:${mimeType};base64,${trimmedAudio}`;
}

export async function playBrowserAudio(base64Audio: string): Promise<void> {
  const context = getAudioContext();
  await context.resume();
  const encodedAudio = base64Audio.trim().replace(DATA_AUDIO_PREFIX, '');
  const binary = atob(encodedAudio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const audioBuffer = await context.decodeAudioData(bytes.buffer);
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      activeSources.delete(source);
      resolve();
    };
    activeSources.set(source, finish);
    source.onended = () => {
      finish();
    };
    try {
      source.start();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Audio playback could not start.'));
    }
  });
}

export function stopBrowserAudio(): void {
  for (const [source, finish] of activeSources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source may already have ended.
    }
    finish();
  }
  activeSources.clear();
}

export async function unlockBrowserAudio(): Promise<void> {
  const context = getAudioContext();
  await context.resume();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.01);
}

function getAudioContext(): AudioContext {
  sharedAudioContext ??= new AudioContext();
  return sharedAudioContext;
}

function detectAudioMimeType(base64Audio: string): string {
  if (base64Audio.startsWith('UklGR')) {
    return 'audio/wav';
  }

  if (base64Audio.startsWith('T2dn')) {
    return 'audio/ogg';
  }

  if (base64Audio.startsWith('SUQz') || base64Audio.startsWith('//')) {
    return 'audio/mpeg';
  }

  return 'audio/mpeg';
}
