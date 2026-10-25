import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subscription, filter } from 'rxjs';
import { AudioStreamMessage } from '../models/socket-message.model';
import { RobotDriverFactory } from '../robot-drivers/robot-driver.factory';
import { backendOrigin } from '../shared/backend-url.util';
import { stopBrowserAudio, unlockBrowserAudio } from '../shared/audio-playback.util';
import { RobotService } from './robot.service';
import { SocketService } from './socket.service';
import { WalkerRosBridgeService } from './walker-ros-bridge.service';

type TemiAudioWindow = Window & {
  TemiAudio?: {
    speak?: (text: string) => string;
    speakText?: (text: string, locale?: string) => string;
    isSpeaking?: () => boolean;
  };
};

@Injectable({ providedIn: 'root' })
export class SpeakerService implements OnDestroy {
  private subscription?: Subscription;
  private speechUtterance: SpeechSynthesisUtterance | null = null;
  private resolveSpeech: (() => void) | null = null;
  private playbackChain: Promise<void> = Promise.resolve();
  private playbackToken = 0;
  private readonly textAudioCache = new Map<string, Promise<string>>();

  readonly lastAudioEvent = signal<string>('');
  readonly isSpeakerReady = signal(false);
  readonly isSpeaking = signal(false);

  constructor(
    private readonly robotService: RobotService,
    private readonly socketService: SocketService,
    private readonly walkerRosBridge: WalkerRosBridgeService
  ) {}

  start(): void {
    if (this.subscription) {
      return;
    }

    this.subscription = this.socketService.messages$
      .pipe(filter((message): message is AudioStreamMessage => message.type === 'audio_stream'))
      .subscribe({
        next: (message) => void this.playForCurrentRobot(message.payload),
        error: () => this.lastAudioEvent.set('Audio stream listener failed.')
      });
  }

  async enableSpeaker(): Promise<void> {
    if (this.isWalkerRobot()) {
      try {
        this.walkerRosBridge.connect();
        await unlockBrowserAudio();
        this.isSpeakerReady.set(true);
        this.lastAudioEvent.set('Walker browser speaker enabled.');
        return;
      } catch {
        this.isSpeakerReady.set(false);
        this.lastAudioEvent.set('Walker speaker permission failed. Click Start again.');
        return;
      }
    }

    try {
      await unlockBrowserAudio();
      this.isSpeakerReady.set(true);
      this.lastAudioEvent.set('Speaker enabled. Audio can now play after backend responses.');
    } catch {
      this.isSpeakerReady.set(false);
      this.lastAudioEvent.set('Speaker permission failed. Click Enable Speaker again.');
    }
  }

  speakText(text: string, locale = 'en-US'): Promise<void> {
    if (!('speechSynthesis' in window) || !text.trim()) {
      return Promise.reject(new Error('Text-to-speech is not available in this browser.'));
    }

    this.cancelCurrentSpeech();
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = locale;
      utterance.rate = this.robotService.memoryDeclineLevel() === 'severe' ? 0.78 : 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;

      const voices = window.speechSynthesis.getVoices();
      utterance.voice =
        voices.find((voice) => voice.lang.toLowerCase() === locale.toLowerCase()) ??
        voices.find((voice) => voice.lang.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase())) ??
        voices.find((voice) => voice.default) ??
        null;

      utterance.onend = () => {
        if (this.speechUtterance !== utterance) {
          resolve();
          return;
        }
        this.speechUtterance = null;
        this.resolveSpeech = null;
        this.isSpeaking.set(false);
        this.isSpeakerReady.set(true);
        this.lastAudioEvent.set('Question spoken through the local speaker.');
        resolve();
      };
      utterance.onerror = (event) => {
        if (this.speechUtterance !== utterance || event.error === 'canceled' || event.error === 'interrupted') {
          resolve();
          return;
        }
        this.speechUtterance = null;
        this.resolveSpeech = null;
        this.isSpeaking.set(false);
        reject(new Error(`The browser could not speak the question (${event.error}).`));
      };
      this.speechUtterance = utterance;
      this.resolveSpeech = resolve;
      this.isSpeaking.set(true);
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    });
  }

  async speakTextWithFallback(text: string, locale = 'en-US'): Promise<void> {
    return this.enqueuePlayback(async () => {
      await this.speakTextWithFallbackNow(text, locale);
    });
  }

  async speakTextImmediately(text: string, locale = 'en-US'): Promise<void> {
    this.stopSpeaking();
    await this.speakTextWithFallbackNow(text, locale);
  }

  prefetchText(text: string, locale = 'en-US'): void {
    if (!text.trim()) return;
    if (this.isWalkerRobot()) return;
    this.getLocalSpeechPayload(text, locale).catch(() => undefined);
  }

  private async speakTextWithFallbackNow(text: string, locale = 'en-US'): Promise<void> {
    if (this.isWalkerRobot()) {
      this.isSpeaking.set(true);
      try {
        await this.speakWithWalkerBackend(text);
        this.isSpeakerReady.set(true);
        this.lastAudioEvent.set('Question spoken through the Walker speaker.');
      } finally {
        this.isSpeaking.set(false);
      }
      return;
    }

    if (this.isTemiRobot()) {
      try {
        await this.speakWithTemiNativeText(text, locale);
        return;
      } catch {
        // Older temi browser builds do not expose the native bridge, so keep the previous fallback paths.
      }
    }

    try {
      await this.speakText(text, locale);
    } catch (browserError) {
      try {
        await this.speakWithLocalService(text, locale);
      } catch (fallbackError) {
        const browserMessage = browserError instanceof Error ? browserError.message : 'Browser TTS failed.';
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'Windows TTS failed.';
        throw new Error(`${browserMessage} ${fallbackMessage}`);
      }
    }
  }

  private async speakWithWalkerBackend(text: string): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const response = await fetch(`${backendOrigin()}/walker/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ros_ip: params.get('ros_ip') ?? '',
        ros_port: params.get('ros_port') ?? ''
      })
    });
    const result = (await response.json()) as { ok?: boolean; error?: string; ros_bridge_url?: string };
    if (!response.ok || !result.ok) {
      throw new Error(result.error ?? `Walker backend bridge returned HTTP ${response.status}.`);
    }
  }

  private async speakWithTemiNativeText(text: string, locale: string): Promise<void> {
    const nativeAudio = (window as TemiAudioWindow).TemiAudio;
    const bridge = nativeAudio?.speak ?? nativeAudio?.speakText;
    if (!bridge) {
      throw new Error('temi native TTS bridge is not available.');
    }

    this.cancelCurrentSpeech();
    this.isSpeaking.set(true);
    try {
      const resultText = nativeAudio?.speak ? nativeAudio.speak(text) : nativeAudio?.speakText?.(text, locale);
      if (!resultText) {
        throw new Error('temi native TTS bridge returned no result.');
      }
      const result = JSON.parse(resultText) as { ok?: boolean; error?: string };
      if (!result.ok) {
        throw new Error(result.error ?? 'temi native TTS failed.');
      }
      await this.waitForTemiNativeSpeech(text);
      this.isSpeakerReady.set(true);
      this.lastAudioEvent.set('Question spoken through the temi speaker.');
    } finally {
      this.isSpeaking.set(false);
    }
  }

  private async speakWithLocalService(text: string, locale: string): Promise<void> {
    const payload = await this.getLocalSpeechPayload(text, locale);
    const driver = RobotDriverFactory.create(this.robotService.robotId());
    this.isSpeaking.set(true);
    try {
      await driver.playAudio(payload);
      this.isSpeakerReady.set(true);
      this.lastAudioEvent.set('Question played through the robot speaker.');
    } finally {
      this.isSpeaking.set(false);
    }
  }

  private getLocalSpeechPayload(text: string, locale: string): Promise<string> {
    const cacheKey = `${locale}\n${text.trim()}`;
    const cached = this.textAudioCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const request = this.fetchLocalSpeechPayload(text, locale).catch((error) => {
      this.textAudioCache.delete(cacheKey);
      throw error;
    });
    this.textAudioCache.set(cacheKey, request);
    return request;
  }

  private async fetchLocalSpeechPayload(text: string, locale: string): Promise<string> {
    const response = await fetch(`${backendOrigin()}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, locale })
    });
    const result = (await response.json()) as { payload?: string; error?: string };
    if (!response.ok || !result.payload) {
      throw new Error(result.error ?? `Local TTS returned HTTP ${response.status}.`);
    }
    return result.payload;
  }

  stopSpeaking(): void {
    this.playbackToken += 1;
    this.playbackChain = Promise.resolve();
    stopBrowserAudio();
    this.cancelCurrentSpeech();
    this.isSpeaking.set(false);
  }

  async playBase64Audio(base64Audio: string, eventMessage = 'Question played through the robot speaker.'): Promise<void> {
    return this.enqueuePlayback(async () => {
      await this.playBase64AudioNow(base64Audio, eventMessage);
    });
  }

  private async playBase64AudioNow(base64Audio: string, eventMessage = 'Question played through the robot speaker.'): Promise<void> {
    const driver = RobotDriverFactory.create(this.robotService.robotId());
    this.isSpeaking.set(true);
    try {
      await driver.playAudio(base64Audio);
      this.isSpeakerReady.set(true);
      this.lastAudioEvent.set(eventMessage);
    } finally {
      this.isSpeaking.set(false);
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.stopSpeaking();
  }

  private async playForCurrentRobot(base64Audio: string): Promise<void> {
    try {
      await this.playBase64Audio(base64Audio, `Audio played through ${this.robotService.robotId()}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown robot output error.';
      const isAutoplayBlock = message.toLowerCase().includes('play') || message.toLowerCase().includes('user');
      this.isSpeakerReady.set(false);
      this.lastAudioEvent.set(
        isAutoplayBlock
          ? 'Playback was blocked by the browser. Click Enable Speaker, then send the image again.'
          : message
      );
    }
  }

  private enqueuePlayback(task: () => Promise<void>): Promise<void> {
    const token = this.playbackToken;
    const run = this.playbackChain
      .catch(() => undefined)
      .then(async () => {
        if (token !== this.playbackToken) return;
        await task();
      });
    this.playbackChain = run;
    return run;
  }

  private cancelCurrentSpeech(): void {
    const pendingUtterance = this.speechUtterance;
    const pendingResolve = this.resolveSpeech;
    this.speechUtterance = null;
    this.resolveSpeech = null;

    if (pendingUtterance) {
      pendingUtterance.onend = null;
      pendingUtterance.onerror = null;
    }
    window.speechSynthesis?.cancel();
    this.isSpeaking.set(false);
    pendingResolve?.();
  }

  private isWalkerRobot(): boolean {
    return this.robotService.robotId().toLowerCase().includes('walker');
  }

  private isTemiRobot(): boolean {
    return this.robotService.robotId().toLowerCase().includes('temi-v3');
  }

  private waitForSpeechEstimate(text: string): Promise<void> {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const estimatedMs = Math.max(900, Math.min(12_000, 450 + words * 360));
    return new Promise((resolve) => window.setTimeout(resolve, estimatedMs));
  }

  private async waitForTemiNativeSpeech(text: string): Promise<void> {
    const nativeAudio = (window as TemiAudioWindow).TemiAudio;
    if (!nativeAudio?.isSpeaking) {
      await this.waitForSpeechEstimate(text);
      return;
    }

    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const fallbackMs = Math.max(2500, Math.min(18_000, 1200 + words * 430));
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      let observedSpeechStart = false;
      const timer = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const speaking = nativeAudio.isSpeaking?.() === true;
        observedSpeechStart = observedSpeechStart || speaking;

        if (!observedSpeechStart && elapsed < 1800) {
          return;
        }

        if ((observedSpeechStart && !speaking) || elapsed > fallbackMs) {
          window.clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  }
}
