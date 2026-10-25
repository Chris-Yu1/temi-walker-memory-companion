import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CalibrationComponent } from './features/calibration/calibration.component';
import { ConversationComponent } from './features/conversation/conversation.component';
import { QuestionnaireComponent } from './features/questionnaire/questionnaire.component';
import { UploadedPhoto } from './models/conversation.model';
import { ConversationService } from './services/conversation.service';
import { CalibrationValues, Gender, RobotService } from './services/robot.service';
import { SocketService } from './services/socket.service';
import { SpeakerService } from './services/speaker.service';
import { backendOrigin } from './shared/backend-url.util';

type AppStep = 'introduction' | 'registration' | 'calibration' | 'qr-upload' | 'photo-selection' | 'conversation' | 'questionnaire';
type KeyboardField = 'name' | 'age' | null;
type TemiMotionBridge = {
  lock?: () => string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, CalibrationComponent, ConversationComponent, QuestionnaireComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private readonly conversationService = inject(ConversationService);
  private readonly robotService = inject(RobotService);
  private readonly socketService = inject(SocketService);
  private readonly speakerService = inject(SpeakerService);
  private uploadPollTimer?: number;
  private uploadRefreshInFlight = false;
  private announcedPhotoSelectionSessionId = '';
  private staticLockTimer?: number;
  private introAudioPayload = '';
  private readonly introAudioCacheKey = 'memory-companion:intro-audio:v2';

  readonly isQuestionnaireMode = this.getIsQuestionnaireMode();
  readonly step = signal<AppStep>(this.isQuestionnaireMode ? 'questionnaire' : 'introduction');
  readonly robotId = this.robotService.robotId;
  readonly userName = this.robotService.userName;
  readonly age = this.robotService.age;
  readonly gender = this.robotService.gender;
  readonly conversationStatus = this.conversationService.status;
  readonly flowCompleted = this.conversationService.flowCompleted;
  readonly completedPhotoIds = this.conversationService.completedPhotoIds;
  readonly connectionStatus = this.socketService.connectionStatus;
  readonly lastAudioEvent = this.speakerService.lastAudioEvent;
  readonly isSpeakerReady = this.speakerService.isSpeakerReady;
  readonly isRobotSpeaking = this.speakerService.isSpeaking;
  readonly registrationError = signal('');
  readonly uploadSessionId = signal('');
  readonly uploadUrl = signal('');
  readonly qrDataUrl = signal('');
  readonly isPublicUploadUrl = signal(false);
  readonly uploadedPhotos = signal<UploadedPhoto[]>([]);
  readonly selectedPhotoId = signal('');
  readonly uploadError = signal('');
  readonly isCreatingUploadSession = signal(false);
  readonly isIntroSpeaking = signal(false);
  readonly isIntroAudioReady = signal(false);
  readonly introAudioFailed = signal(false);
  readonly activeKeyboardField = signal<KeyboardField>(null);
  readonly keyboardRows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
  ];
  readonly numberRow = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  readonly connectionLabel = computed(() => {
    const status = this.connectionStatus();
    return status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Disconnected';
  });

  readonly genderOptions: Array<{ value: Gender; label: string }> = [
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
    { value: 'non_binary', label: 'Non-binary' },
    { value: 'prefer_not_to_say', label: 'Prefer not to say' }
  ];

  constructor() {
    if (this.isQuestionnaireMode) {
      return;
    }

    this.speakerService.start();
    this.startTemiStaticLock();
    this.preloadAppSpeechPrompts();
    void this.preloadIntroSpeech();
    effect(() => {
      const completedPhoto = this.conversationService.photoCompleted();
      if (!completedPhoto) {
        return;
      }
      window.setTimeout(() => {
        this.step.set('photo-selection');
        this.conversationService.resetPhotoCompleted();
        void this.speakerService.speakTextWithFallback('This photo conversation is complete. Please choose the other photo, or select End Session.', 'en-GB');
      }, 1000);
    });
  }

  private preloadAppSpeechPrompts(): void {
    [
      'Please place your face inside the frame. Calibration will start automatically.',
      'Calibration measurement is complete. Please select Continue to go to the next page.',
      'Please scan the QR code and upload exactly two photos.',
      'The two photos are ready. Please select one photo to start the conversation.',
      'This photo conversation is complete. Please choose the other photo, or select End Session.'
    ].forEach((text) => this.speakerService.prefetchText(text, 'en-GB'));
  }

  ngOnDestroy(): void {
    this.clearUploadPollTimer();
    this.stopTemiStaticLock();
  }

  updateAge(value: string): void {
    const age = Number(value);
    this.robotService.setAge(Number.isFinite(age) && age > 0 ? age : null);
  }

  updateUserName(value: string): void {
    this.robotService.setUserName(value);
  }

  updateGender(value: Gender): void {
    this.robotService.setGender(value);
  }

  showKeyboard(field: KeyboardField): void {
    this.activeKeyboardField.set(field);
  }

  hideKeyboard(): void {
    this.activeKeyboardField.set(null);
  }

  pressKeyboardKey(key: string): void {
    const field = this.activeKeyboardField();
    if (field === 'name') {
      this.robotService.setUserName(`${this.userName()}${key}`);
    } else if (field === 'age' && /^\d$/.test(key)) {
      const next = `${this.age() ?? ''}${key}`.slice(0, 3);
      this.updateAge(next);
    }
  }

  pressKeyboardSpace(): void {
    if (this.activeKeyboardField() === 'name' && this.userName().trim()) {
      this.robotService.setUserName(`${this.userName()} `);
    }
  }

  pressKeyboardBackspace(): void {
    const field = this.activeKeyboardField();
    if (field === 'name') {
      this.robotService.setUserName(this.userName().slice(0, -1));
    } else if (field === 'age') {
      const next = String(this.age() ?? '').slice(0, -1);
      this.updateAge(next);
    }
  }

  clearKeyboardField(): void {
    const field = this.activeKeyboardField();
    if (field === 'name') {
      this.robotService.setUserName('');
    } else if (field === 'age') {
      this.robotService.setAge(null);
    }
  }

  reconnect(): void {
    this.socketService.reconnect();
  }

  enableSpeaker(): void {
    void this.speakerService.enableSpeaker();
  }

  private async preloadIntroSpeech(): Promise<void> {
    this.isIntroAudioReady.set(false);
    this.introAudioFailed.set(false);
    this.introAudioPayload = this.readCachedIntroAudio();
    if (this.introAudioPayload) {
      this.isIntroAudioReady.set(true);
    }

    try {
      const response = await fetch(`${backendOrigin()}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: this.getIntroSpeechText(), locale: 'en-GB' })
      });
      const result = (await response.json()) as { payload?: string };
      if (response.ok && result.payload) {
        this.introAudioPayload = result.payload;
        this.writeCachedIntroAudio(result.payload);
        this.isIntroAudioReady.set(true);
        return;
      }
    } catch {
      if (!this.introAudioPayload) {
        this.introAudioFailed.set(true);
      }
    }
    if (!this.introAudioPayload) {
      this.introAudioFailed.set(true);
    }
  }

  private readCachedIntroAudio(): string {
    try {
      return window.localStorage.getItem(this.introAudioCacheKey) ?? '';
    } catch {
      return '';
    }
  }

  private writeCachedIntroAudio(payload: string): void {
    try {
      window.localStorage.setItem(this.introAudioCacheKey, payload);
    } catch {
      // Storage can be unavailable on some WebView builds; the runtime preload still works.
    }
  }

  async startRegistration(): Promise<void> {
    if (this.isIntroSpeaking()) {
      return;
    }

    this.isIntroSpeaking.set(true);
    try {
      if (this.isWalkerRobot()) {
        await this.speakerService.enableSpeaker();
        if (this.introAudioPayload) {
          await this.speakerService.playBase64Audio(this.introAudioPayload, 'Introduction played through the robot speaker.');
        } else {
          await this.speakerService.speakTextWithFallback(this.getIntroSpeechText(), 'en-GB');
        }
        this.step.set('registration');
        return;
      }

      if (this.introAudioPayload) {
        await this.speakerService.playBase64Audio(this.introAudioPayload, 'Introduction played through the robot speaker.');
      } else {
        await this.speakerService.speakTextImmediately(this.getIntroSpeechText(), 'en-GB');
      }
      this.step.set('registration');
    } catch {
      this.introAudioFailed.set(true);
      if (!this.isWalkerRobot()) {
        this.step.set('registration');
      }
    } finally {
      this.isIntroSpeaking.set(false);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Timed out.')), timeoutMs);
      promise
        .then((value) => resolve(value))
        .catch((error) => reject(error))
        .finally(() => window.clearTimeout(timer));
    });
  }

  startRegistrationFromIntroSurface(): void {
    if (this.isWalkerRobot()) {
      void this.startRegistration();
    }
  }

  async continueToCalibration(): Promise<void> {
    if (!this.userName().trim()) {
      this.registrationError.set('Please enter the user name before continuing.');
      return;
    }

    if (!this.age()) {
      this.registrationError.set('Please enter the user age before continuing.');
      return;
    }

    this.registrationError.set('');
    this.hideKeyboard();
    await this.speakerService.enableSpeaker();
    this.step.set('calibration');
    void this.speakerService.speakTextWithFallback('Please place your face inside the frame. Calibration will start automatically.', 'en-GB');
  }

  backToRegistration(): void {
    this.step.set('registration');
  }

  async completeCalibration(values: CalibrationValues): Promise<void> {
    this.robotService.setCalibrationValues(values);
    this.step.set('qr-upload');
    this.uploadError.set('');
    const created = await this.createMobileUploadSession();
    if (created) {
      void this.speakerService.speakTextWithFallback('Please scan the QR code and upload exactly two photos.', 'en-GB');
    }
  }

  async createMobileUploadSession(): Promise<boolean> {
    this.clearUploadPollTimer();
    this.uploadRefreshInFlight = false;
    this.announcedPhotoSelectionSessionId = '';
    this.uploadError.set('');
    this.uploadedPhotos.set([]);
    this.selectedPhotoId.set('');
    this.uploadSessionId.set('');
    this.uploadUrl.set('');
    this.qrDataUrl.set('');
    this.conversationService.resetPhotoProgress();
    this.isCreatingUploadSession.set(true);

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${backendOrigin()}/mobile-upload-session`, {
        method: 'POST',
        signal: controller.signal
      }).finally(() => window.clearTimeout(timeout));
      const result = (await response.json()) as {
        session_id?: string;
        upload_url?: string;
        qr_image_url?: string;
        qr_data_url?: string;
        is_public_upload_url?: boolean;
        error?: string;
      };
      if (!response.ok || !result.session_id || !result.upload_url || (!result.qr_image_url && !result.qr_data_url)) {
        throw new Error(result.error ?? 'Could not create the QR upload session.');
      }
      this.uploadSessionId.set(result.session_id);
      this.uploadUrl.set(result.upload_url);
      const qrSource = result.qr_data_url || (result.qr_image_url ? `${backendOrigin()}${result.qr_image_url}?t=${Date.now()}` : '');
      this.qrDataUrl.set(qrSource);
      this.isPublicUploadUrl.set(result.is_public_upload_url === true);
      this.step.set('qr-upload');
      this.startUploadPolling(result.session_id);
      return true;
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'Creating the QR upload session timed out. Please check the backend server and try Continue again.'
        : error instanceof Error ? error.message : 'Could not create the QR upload session.';
      this.uploadError.set(message);
      return false;
    } finally {
      this.isCreatingUploadSession.set(false);
    }
  }

  choosePhoto(photoId: string): void {
    this.selectedPhotoId.set(photoId);
    this.startSelectedPhotoFlow(photoId);
  }

  startSelectedPhotoFlow(photoId?: string): void {
    const photos = this.uploadedPhotos();
    const selected = photoId || this.selectedPhotoId() || photos[0]?.id;
    if (photos.length !== 2 || !selected) {
      this.uploadError.set('Please upload two photos before starting.');
      return;
    }

    this.clearUploadPollTimer();
    this.speakerService.stopSpeaking();
    this.conversationService.setPhotoSequence(photos, selected);
    this.conversationService.startConversation();
    this.step.set('conversation');
  }

  returnToIntroduction(): void {
    this.clearUploadPollTimer();
    this.conversationService.exitConversation();
    this.conversationService.resetFlowCompleted();
    this.conversationService.resetPhotoProgress();
    this.uploadSessionId.set('');
    this.uploadUrl.set('');
    this.qrDataUrl.set('');
    this.isPublicUploadUrl.set(false);
    this.uploadedPhotos.set([]);
    this.selectedPhotoId.set('');
    this.uploadError.set('');
    this.step.set('introduction');
  }

  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    this.clearUploadPollTimer();
    this.stopTemiStaticLock();
  }

  private startUploadPolling(sessionId: string): void {
    this.clearUploadPollTimer();
    this.uploadPollTimer = window.setInterval(() => {
      void this.refreshUploadedPhotos(sessionId);
    }, 1500);
    void this.refreshUploadedPhotos(sessionId);
  }

  private async refreshUploadedPhotos(sessionId: string): Promise<void> {
    if (this.uploadRefreshInFlight || sessionId !== this.uploadSessionId()) {
      return;
    }

    this.uploadRefreshInFlight = true;
    try {
        const response = await fetch(`${backendOrigin()}/mobile-upload-session/${encodeURIComponent(sessionId)}`);
      const result = (await response.json()) as { photos?: UploadedPhoto[]; error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? 'Could not read uploaded photos.');
      }
      const photos = result.photos ?? [];
      this.uploadedPhotos.set(photos);
      if (photos.length === 2) {
        if (this.step() === 'conversation') {
          return;
        }
        this.clearUploadPollTimer();
        this.step.set('photo-selection');
        if (this.announcedPhotoSelectionSessionId !== sessionId) {
          this.announcedPhotoSelectionSessionId = sessionId;
          void this.speakerService.speakTextWithFallback('The two photos are ready. Please select one photo to start the conversation.', 'en-GB');
        }
      }
    } catch (error) {
      this.uploadError.set(error instanceof Error ? error.message : 'Could not read uploaded photos.');
    } finally {
      this.uploadRefreshInFlight = false;
    }
  }

  private clearUploadPollTimer(): void {
    if (this.uploadPollTimer) {
      window.clearInterval(this.uploadPollTimer);
      this.uploadPollTimer = undefined;
    }
  }

  private startTemiStaticLock(): void {
    if (!this.robotId().toLowerCase().includes('temi-v3')) {
      return;
    }

    void this.sendTemiStaticLock('start');
    this.staticLockTimer = window.setInterval(() => {
      void this.sendTemiStaticLock('heartbeat');
    }, 4000);
  }

  private stopTemiStaticLock(): void {
    if (this.staticLockTimer) {
      window.clearInterval(this.staticLockTimer);
      this.staticLockTimer = undefined;
    }
    if (this.robotId().toLowerCase().includes('temi-v3')) {
      void this.sendTemiStaticLock('stop');
    }
  }

  private async sendTemiStaticLock(action: 'start' | 'heartbeat' | 'stop'): Promise<void> {
    try {
      if (action !== 'stop') {
        (window as unknown as { TemiMotion?: TemiMotionBridge }).TemiMotion?.lock?.();
      }
      await fetch(`${backendOrigin()}/temi/static-lock/${action}`, { method: 'POST' });
    } catch {
      // Robot motion locking is best-effort and should never block the app flow.
    }
  }

  private getIntroSpeechText(): string {
    if (this.isWalkerRobot()) {
      return 'Welcome to Walker. This is a photo guided memory companion. Please complete the user registration.';
    }
    return `Welcome to ${this.getRobotDisplayName()}, your photo guided memory companion; I will ask gentle questions about two photos, listen to the user's answers, and guide the conversation step by step, so please complete the user registration when this introduction finishes.`;
  }

  private getRobotDisplayName(): string {
    const robotId = this.robotId().toLowerCase();
    if (robotId.includes('walker')) return 'Walker';
    if (robotId.includes('temi')) return 'temi';
    return 'the robot';
  }

  isWalkerRobot(): boolean {
    return this.robotId().toLowerCase().includes('walker');
  }

  isTemiRobot(): boolean {
    return this.robotId().toLowerCase().includes('temi');
  }

  private getIsQuestionnaireMode(): boolean {
    const params = new URLSearchParams(window.location.search);
    return params.get('questionnaire') === '1' || params.get('mode') === 'questionnaire';
  }
}
