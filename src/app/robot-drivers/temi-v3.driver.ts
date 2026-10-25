import { IRobotOutput } from './robot-output.interface';
import { playBrowserAudio } from '../shared/audio-playback.util';
import { backendOrigin } from '../shared/backend-url.util';

type TemiAudioWindow = Window & {
  TemiAudio?: {
    playBase64Audio?: (base64Audio: string) => string;
  };
};

export class TemiV3Driver implements IRobotOutput {
  async playAudio(base64Audio: string): Promise<void> {
    try {
      await playBrowserAudio(base64Audio);
      return;
    } catch {
      // Fall back to the native wrapper/backend bridge on temi WebView builds that cannot decode the audio.
    }

    const nativeBridge = (window as TemiAudioWindow).TemiAudio?.playBase64Audio;
    if (nativeBridge) {
      const resultText = nativeBridge(base64Audio);
      const result = JSON.parse(resultText) as { ok?: boolean; error?: string };
      if (result.ok) {
        await waitForEstimatedAudioDuration(base64Audio);
        return;
      }
    }

    const response = await fetch(`${backendOrigin()}/temi/play-audio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: base64Audio })
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) {
      throw new Error(result.error ?? `temi audio playback returned HTTP ${response.status}.`);
    }
  }
}

function waitForEstimatedAudioDuration(base64Audio: string): Promise<void> {
  const encoded = base64Audio.trim().replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '');
  const bytes = Math.max(0, Math.floor(encoded.length * 0.75));
  const estimatedMs = Math.max(900, Math.min(18_000, bytes / 96));
  return new Promise((resolve) => window.setTimeout(resolve, estimatedMs));
}
