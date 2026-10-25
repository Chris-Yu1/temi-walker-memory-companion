import { IRobotOutput } from './robot-output.interface';
import { backendOrigin } from '../shared/backend-url.util';

export class WalkerDriver implements IRobotOutput {
  async playAudio(base64Audio: string): Promise<void> {
    const response = await fetch(`${backendOrigin()}/walker/play-audio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: base64Audio })
    });
    const result = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) {
      throw new Error(result.error ?? `Walker audio playback returned HTTP ${response.status}.`);
    }
  }
}
