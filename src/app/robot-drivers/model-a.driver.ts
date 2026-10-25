import { IRobotOutput } from './robot-output.interface';
import { playBrowserAudio } from '../shared/audio-playback.util';

export class ModelADriver implements IRobotOutput {
  playAudio(base64Audio: string): Promise<void> {
    const command = {
      codec: 'pcm',
      channel: 'speaker.main',
      audio: base64Audio
    };

    return playBrowserAudio(command.audio);
  }
}
