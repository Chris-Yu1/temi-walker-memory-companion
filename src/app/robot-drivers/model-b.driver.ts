import { IRobotOutput } from './robot-output.interface';
import { playBrowserAudio } from '../shared/audio-playback.util';

export class ModelBDriver implements IRobotOutput {
  playAudio(base64Audio: string): Promise<void> {
    const command = {
      action: 'OUTPUT_AUDIO',
      targetDevice: 'speaker',
      payload: {
        encoding: 'base64-data-url',
        value: base64Audio
      }
    };

    return playBrowserAudio(command.payload.value);
  }
}
