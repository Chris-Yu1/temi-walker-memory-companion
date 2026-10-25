export interface IRobotOutput {
  playAudio(base64Audio: string): Promise<void> | void;
}
