import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ConversationStatus, ConversationTurn, UploadedPhoto } from '../models/conversation.model';
import {
  SpeechRecognition,
  SpeechRecognitionConstructor,
  SpeechRecognitionEvent
} from '../models/speech-recognition.model';
import { ConversationContext, MemoryErrorMessage, MemoryFeedbackMessage, MemoryQuestionMessage, UserProfile } from '../models/socket-message.model';
import { backendOrigin } from '../shared/backend-url.util';
import { createLocalId } from '../shared/local-id.util';
import { RobotService } from './robot.service';
import { SocketService } from './socket.service';
import { SpeakerService } from './speaker.service';

const QUESTION_TIMEOUT_MS = 50_000;
const TURN_TAKING_CHECK_DELAY_MS = 900;
const TURN_TAKING_UNCERTAIN_RECHECK_MS = 850;
const TURN_TAKING_MIN_ENDPOINT_PAUSE_SECONDS = 1.8;
const TEMI_TURN_TAKING_CHUNK_MS = 4200;
const AUTO_LISTEN_AFTER_SPEECH_MS = 0;
const TEMI_ENDPOINT_PAUSE_SECONDS = 3.2;
const TEMI_MAX_UNCHANGED_CHUNKS = 3;
const NO_SPEECH_AUTO_ADVANCE_MS = 7_000;
const NO_RESPONSE_ANSWER = 'No response detected.';
const REQUIRED_THEMES: Array<NonNullable<ConversationTurn['theme']>> = ['where', 'when', 'who', 'others'];

@Injectable({ providedIn: 'root' })
export class ConversationService implements OnDestroy {
  private recognition: SpeechRecognition | null = null;
  private temiAudioContext: AudioContext | null = null;
  private temiMediaStream: MediaStream | null = null;
  private temiProcessor: ScriptProcessorNode | null = null;
  private temiAudioChunks: Float32Array[] = [];
  private messageSubscription?: Subscription;
  private fallbackTimer?: number;
  private sessionId = '';
  private conversationDeadline = 0;
  private remainingTimer?: number;
  private photoSequence: UploadedPhoto[] = [];
  private currentPhotoIndex = 0;
  private speechEndpointTimer?: number;
  private finalSpeechAnswer = '';
  private interimSpeechAnswer = '';
  private lastFinalSpeechAt = 0;
  private turnTakingRequestId = 0;
  private turnTakingCheckSequence = 0;
  private endpointCandidateCount = 0;
  private temiTurnTakingTimer?: number;
  private temiChunkInProgress = false;
  private lastTemiTranscriptChunk = '';
  private temiUnchangedChunks = 0;
  private noSpeechAutoAdvanceTimer?: number;
  private playbackRequestId = 0;
  private pendingFeedback: MemoryFeedbackMessage | null = null;
  private answerStartedAt = '';
  private temiAudioPaths: string[] = [];
  private attentionTimer?: number;
  private attentionStream?: MediaStream;
  private attentionVideo?: HTMLVideoElement;
  private attentionCanvas?: HTMLCanvasElement;
  private attentionSamples: Array<{
    captured_at: string;
    head_direction: 'up' | 'down' | 'left' | 'right' | 'center';
    eye_gaze_direction: 'left' | 'right' | 'central';
    head_pose: { yaw: number; pitch: number; roll: number };
    eye_gaze: { x: number; y: number };
  }> = [];

  readonly currentPhoto = signal<UploadedPhoto | null>(null);
  readonly status = signal<ConversationStatus>('idle');
  readonly flowCompleted = signal(false);
  readonly completedPhotoIds = signal<string[]>([]);
  readonly photoCompleted = signal<UploadedPhoto | null>(null);
  readonly turns = signal<ConversationTurn[]>([]);
  readonly activeQuestion = signal<string>('');
  readonly draftAnswer = signal<string>('');
  readonly isListening = signal(false);
  readonly error = signal<string>('');
  readonly remainingTimeLabel = signal('0 / 4 themes');

  constructor(
    private readonly robotService: RobotService,
    private readonly socketService: SocketService,
    private readonly speakerService: SpeakerService
  ) {
    this.messageSubscription = this.socketService.messages$.subscribe((message) => {
      if (message.type === 'memory_question') {
        this.applyModelQuestion(message);
      } else if (message.type === 'memory_feedback') {
        this.applyModelFeedback(message);
      } else if (message.type === 'memory_error') {
        this.applyModelError(message);
      }
    });
  }

  ngOnDestroy(): void {
    this.messageSubscription?.unsubscribe();
    this.stopListening();
    this.clearFallbackTimer();
    this.clearRemainingTimer();
    this.clearSpeechEndpointTimer();
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
    this.stopAttentionSampling();
  }

  setPhoto(photo: UploadedPhoto): void {
    this.photoSequence = [photo];
    this.currentPhotoIndex = 0;
    this.currentPhoto.set(photo);
    this.status.set('idle');
    this.flowCompleted.set(false);
    this.photoCompleted.set(null);
    this.turns.set([]);
    this.pendingFeedback = null;
    this.activeQuestion.set('');
    this.draftAnswer.set('');
    this.error.set('');
    this.clearFallbackTimer();
    this.clearRemainingTimer();
    this.clearSpeechEndpointTimer();
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
  }

  setPhotoSequence(photos: UploadedPhoto[], firstPhotoId: string): void {
    const firstIndex = Math.max(0, photos.findIndex((photo) => photo.id === firstPhotoId));
    const orderedPhotos = [
      photos[firstIndex],
      ...photos.filter((_, index) => index !== firstIndex)
    ].filter(Boolean);

    this.photoSequence = orderedPhotos;
    this.currentPhotoIndex = 0;
    this.currentPhoto.set(orderedPhotos[0] ?? null);
    this.status.set('idle');
    this.flowCompleted.set(false);
    this.photoCompleted.set(null);
    this.turns.set([]);
    this.pendingFeedback = null;
    this.activeQuestion.set('');
    this.draftAnswer.set('');
    this.error.set('');
    this.clearFallbackTimer();
    this.clearRemainingTimer();
    this.clearSpeechEndpointTimer();
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
  }

  startConversation(): void {
    const photo = this.currentPhoto();
    if (!photo) {
      this.error.set('Upload a photo before starting the conversation.');
      return;
    }

    this.status.set('active');
    this.sessionId = createLocalId();
    this.photoCompleted.set(null);
    this.conversationDeadline = 0;
    this.updateRemainingTime();
    this.clearRemainingTimer();
    this.turns.set([]);
    this.pendingFeedback = null;
    this.activeQuestion.set('Preparing the first question...');
    this.draftAnswer.set('');
    this.error.set('');

    this.socketService.sendMemoryConversationStart({
      type: 'memory_conversation_start',
      robot_id: this.robotService.robotId(),
      session_id: this.sessionId,
      photo_id: photo.id,
      image_data: photo.dataUrl,
      user_profile: this.getUserProfile(),
      context: this.getConversationContext()
    });
    this.startQuestionTimeout('The first question took too long to generate. Check the model connection and try again.');
  }

  setDraftAnswer(answer: string): void {
    this.draftAnswer.set(answer);
  }

  submitAnswer(): void {
    const answer = this.draftAnswer().trim();
    const photo = this.currentPhoto();
    const turns = this.turns();
    const currentTurn = this.lastItem(turns);

    if (!photo || !currentTurn || this.status() !== 'active') {
      return;
    }

    if (!answer) {
      this.error.set('Please answer the question before continuing.');
      return;
    }

    this.error.set('');
    this.stopListening();
    this.turns.set(turns.map((turn) => (turn.turn === currentTurn.turn ? { ...turn, answer } : turn)));
    this.draftAnswer.set('');
    const shouldEndAfterAnswer = this.hasCompletedAllThemesAfterAnswer(currentTurn);
    const answerEndedAt = new Date().toISOString();
    const audioPaths = [...this.temiAudioPaths];
    const attentionSamples = [...this.attentionSamples];
    this.stopAttentionSampling();

    this.socketService.sendMemoryAnswer({
      type: 'memory_answer',
      robot_id: this.robotService.robotId(),
      session_id: this.sessionId,
      photo_id: photo.id,
      turn: currentTurn.turn,
      answer,
      answer_started_at: this.answerStartedAt || answerEndedAt,
      answer_ended_at: answerEndedAt,
      audio_paths: audioPaths,
      attention_samples: attentionSamples,
      end_after_answer: shouldEndAfterAnswer,
      image_data: photo.dataUrl,
      user_profile: this.getUserProfile(),
      context: this.getConversationContext()
    });

    if (shouldEndAfterAnswer) {
      this.activeQuestion.set('Responding before finishing this photo...');
      return;
    }

    this.activeQuestion.set('Responding to your answer...');
    this.startQuestionTimeout('The next question took too long to generate. Check the model connection and try again.');
  }

  toggleListening(): void {
    if (this.isListening()) {
      if (this.isTemiRobot()) {
        void this.stopTemiListeningAndTranscribe();
      } else if (this.isWalkerRobot()) {
        void this.processWalkerSpeechChunk('manual-stop', true);
      } else {
        this.stopListening();
      }
      return;
    }

    this.error.set('');
    this.draftAnswer.set('');
    if (this.isTemiRobot()) {
      void this.startTemiListening();
    } else if (this.isWalkerRobot()) {
      void this.startWalkerListening();
    } else {
      this.startListening();
    }
  }

  replayQuestion(): void {
    const question = this.activeQuestion();
    if (question) {
      this.stopListening();
      void this.speakQuestionAndListen(question);
    }
  }

  exitConversation(): void {
    this.status.set('idle');
    this.activeQuestion.set('');
    this.pendingFeedback = null;
    this.draftAnswer.set('');
    this.error.set('');
    this.stopListening();
    this.stopAttentionSampling();
    this.speakerService.stopSpeaking();
    this.clearFallbackTimer();
    this.clearRemainingTimer();
  }

  resetFlowCompleted(): void {
    this.flowCompleted.set(false);
  }

  resetPhotoCompleted(): void {
    this.photoCompleted.set(null);
  }

  resetPhotoProgress(): void {
    this.completedPhotoIds.set([]);
    this.photoCompleted.set(null);
    this.flowCompleted.set(false);
  }

  private startListening(): void {
    if (this.isWalkerRobot()) {
      void this.startWalkerListening();
      return;
    }

    const Recognition = this.getSpeechRecognitionConstructor();
    if (!Recognition) {
      this.error.set('Speech recognition is not available in this browser. You can type your answer instead.');
      return;
    }

    this.stopListening();
    const recognition = new Recognition();
    this.recognition = recognition;
    this.finalSpeechAnswer = '';
    this.interimSpeechAnswer = '';
    this.lastFinalSpeechAt = 0;
    this.turnTakingRequestId += 1;
    this.endpointCandidateCount = 0;
    recognition.lang = 'en-GB';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (this.recognition === recognition) {
        this.handleSpeechResult(event);
      }
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition || event.error === 'aborted') {
        return;
      }
      this.recognition = null;
      this.isListening.set(false);
      this.clearNoSpeechAutoAdvanceTimer();
      this.error.set(
        event.error === 'not-allowed'
          ? 'Microphone access was denied. Allow microphone permission and try again.'
          : 'Speech recognition failed. Please try again or type your answer.'
      );
    };
    recognition.onend = () => {
      if (this.recognition === recognition) {
        this.recognition = null;
        this.isListening.set(false);
        if (this.draftAnswer().trim()) {
          this.scheduleTurnTakingCheck(TURN_TAKING_CHECK_DELAY_MS);
        }
      }
    };
    recognition.start();
    this.isListening.set(true);
    this.markAnswerStarted();
    this.scheduleNoSpeechAutoAdvance();
  }

  private stopListening(): void {
    this.turnTakingRequestId += 1;
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
    this.stopAttentionSampling();
    this.temiChunkInProgress = false;
    this.lastTemiTranscriptChunk = '';
    this.temiUnchangedChunks = 0;
    this.endpointCandidateCount = 0;
    if (this.temiMediaStream || this.temiAudioContext) {
      this.cleanupTemiRecording();
      this.temiAudioChunks = [];
      this.isListening.set(false);
    }

    this.clearSpeechEndpointTimer();

    if (!this.recognition) {
      return;
    }

    const recognition = this.recognition;
    this.recognition = null;
    this.isListening.set(false);
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.stop();
  }

  private handleSpeechResult(event: SpeechRecognitionEvent): void {
    let interim = '';

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const segment = event.results[index][0]?.transcript ?? '';
      if (event.results[index].isFinal) {
        this.finalSpeechAnswer = `${this.finalSpeechAnswer} ${segment}`.trim();
        this.lastFinalSpeechAt = Date.now();
      } else {
        interim += segment;
      }
    }

    this.interimSpeechAnswer = interim.trim();
    this.draftAnswer.set(`${this.finalSpeechAnswer} ${this.interimSpeechAnswer}`.trim());

    if (this.draftAnswer().trim()) {
      this.scheduleNoSpeechAutoAdvance();
    }

    if (this.finalSpeechAnswer) {
      this.scheduleTurnTakingCheck(TURN_TAKING_CHECK_DELAY_MS);
    }
  }

  private applyModelQuestion(message: MemoryQuestionMessage): void {
    const photo = this.currentPhoto();
    if (!photo || message.photo_id !== photo.id || this.status() !== 'active') {
      return;
    }

    this.clearFallbackTimer();
    if (message.is_final) {
      void this.speakPendingFeedbackThenComplete();
      return;
    }

    this.addQuestion(message);
  }

  private applyModelError(message: MemoryErrorMessage): void {
    const photo = this.currentPhoto();
    if (photo && message.photo_id === photo.id && this.status() === 'active') {
      this.clearFallbackTimer();
      this.activeQuestion.set('Question generation failed.');
      this.error.set(message.message);
    }
  }

  private applyModelFeedback(message: MemoryFeedbackMessage): void {
    const photo = this.currentPhoto();
    if (!photo || message.photo_id !== photo.id || this.status() !== 'active') {
      return;
    }

    this.turns.update((turns) => turns.map((turn) => (
      turn.turn === message.turn ? { ...turn, feedback: message.feedback } : turn
    )));

    this.pendingFeedback = message;
  }

  private startQuestionTimeout(message: string): void {
    this.clearFallbackTimer();
    this.fallbackTimer = window.setTimeout(() => {
      if (this.status() === 'active' && this.activeQuestion().startsWith('Preparing')) {
        this.activeQuestion.set('Question generation timed out.');
        this.error.set(message);
      }
      this.fallbackTimer = undefined;
    }, QUESTION_TIMEOUT_MS);
  }

  private addQuestion(message: MemoryQuestionMessage): void {
    const { turn, question, theme, audio_payload: audioPayload } = message;
    const pendingFeedback = this.takePendingFeedbackForTurn(turn - 1);
    const existingTurn = this.turns().find((item) => item.turn === turn);
    if (existingTurn) {
      this.turns.update((turns) => turns.map((item) => (item.turn === turn ? { ...item, question, theme } : item)));
      this.activeQuestion.set(question);
      this.updateRemainingTime();
      void this.speakFeedbackQuestionAndListen({
        question,
        audioPayload,
        feedback: pendingFeedback?.feedback,
        feedbackAudioPayload: pendingFeedback?.feedback_audio_payload
      });
      return;
    }

    this.turns.update((turns) => [...turns, { turn, question, theme }]);
    this.activeQuestion.set(question);
    this.updateRemainingTime();
    void this.speakFeedbackQuestionAndListen({
      question,
      audioPayload,
      feedback: pendingFeedback?.feedback,
      feedbackAudioPayload: pendingFeedback?.feedback_audio_payload
    });
  }

  private takePendingFeedbackForTurn(turn: number): MemoryFeedbackMessage | null {
    const feedback = this.pendingFeedback;
    if (!feedback || Number(feedback.turn) !== Number(turn)) {
      return null;
    }
    this.pendingFeedback = null;
    return feedback;
  }

  private async speakPendingFeedbackThenComplete(): Promise<void> {
    const feedback = this.pendingFeedback;
    this.pendingFeedback = null;
    if (feedback?.feedback?.trim()) {
      try {
        if (feedback.feedback_audio_payload && !this.isTemiRobot()) {
          await this.speakerService.playBase64Audio(feedback.feedback_audio_payload, 'Feedback played through the robot speaker.');
        } else {
          await this.speakerService.speakTextWithFallback(feedback.feedback, 'en-GB');
        }
      } catch {
        // The session should still finish even if the closing feedback cannot be spoken.
      }
    }
    this.completeConversation();
  }

  private completeConversation(): void {
    const completedPhoto = this.currentPhoto();
    this.status.set('completed');
    if (completedPhoto) {
      this.completedPhotoIds.update((ids) => ids.includes(completedPhoto.id) ? ids : [...ids, completedPhoto.id]);
    }
    this.flowCompleted.set(true);
    this.photoCompleted.set(completedPhoto);
    this.activeQuestion.set('');
    this.draftAnswer.set('');
    this.stopListening();
    this.clearFallbackTimer();
    this.clearRemainingTimer();
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }
  }

  private getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
    return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
  }

  private async speakQuestionAndListen(question: string, audioPayload?: string): Promise<void> {
    await this.speakFeedbackQuestionAndListen({ question, audioPayload });
  }

  private async speakFeedbackQuestionAndListen({
    question,
    audioPayload,
    feedback,
    feedbackAudioPayload
  }: {
    question: string;
    audioPayload?: string;
    feedback?: string;
    feedbackAudioPayload?: string;
  }): Promise<void> {
    const playbackId = ++this.playbackRequestId;
    this.stopListening();
    try {
      if (feedback?.trim() && this.status() === 'active' && this.activeQuestion() === question) {
        if (feedbackAudioPayload && !this.isTemiRobot()) {
          await this.speakerService.playBase64Audio(feedbackAudioPayload, 'Feedback played through the robot speaker.');
        } else {
          await this.speakerService.speakTextWithFallback(feedback, 'en-GB');
        }
      }

      this.sendQuestionPlaybackEvent('start');
      if (audioPayload && !this.isWalkerRobot() && !this.isTemiRobot()) {
        await this.speakerService.playBase64Audio(audioPayload);
      } else {
        await this.speakerService.speakTextWithFallback(question, 'en-GB');
      }
      this.sendQuestionPlaybackEvent('end');
      if (this.status() === 'active' && this.activeQuestion() === question && this.playbackRequestId === playbackId) {
        this.error.set('');
        this.scheduleAutomaticListening(question);
      }
    } catch (error) {
      if (this.activeQuestion() === question) {
        const detail = error instanceof Error ? ` ${error.message}` : '';
        this.error.set(`The question could not be spoken.${detail} Select Replay Question to try again.`);
      }
    }
  }

  private scheduleAutomaticListening(question: string): void {
    this.resetAnswerCapture();
    const startListening = (): void => {
      if (this.status() !== 'active' || this.activeQuestion() !== question || this.isListening()) {
        return;
      }

      if (this.isTemiRobot()) {
        void this.startTemiListening();
        return;
      }

      if (this.isWalkerRobot()) {
        void this.startWalkerListening();
        return;
      }

      this.startListening();
    };

    if (AUTO_LISTEN_AFTER_SPEECH_MS <= 0) {
      startListening();
      return;
    }

    window.setTimeout(startListening, AUTO_LISTEN_AFTER_SPEECH_MS);
  }

  private resetAnswerCapture(): void {
    this.clearSpeechEndpointTimer();
    this.clearTemiTurnTakingTimer();
    this.temiChunkInProgress = false;
    this.turnTakingRequestId += 1;
    this.finalSpeechAnswer = '';
    this.interimSpeechAnswer = '';
    this.lastFinalSpeechAt = 0;
    this.lastTemiTranscriptChunk = '';
    this.temiUnchangedChunks = 0;
    this.draftAnswer.set('');
    this.answerStartedAt = '';
    this.temiAudioPaths = [];
    this.attentionSamples = [];
    this.stopAttentionSampling();
  }

  private getUserProfile(): UserProfile {
    return {
      name: this.robotService.userName(),
      age: this.robotService.age(),
      memory_decline_level: this.robotService.memoryDeclineLevel(),
      gender: this.robotService.gender(),
      conversation_duration_minutes: 0,
      calibration: this.robotService.calibrationValues()
    };
  }

  private getConversationContext(): ConversationContext {
    return {
      user_profile: this.getUserProfile(),
      locale: 'en-GB',
      generation_guidance: this.buildGenerationGuidance(),
      conversation_history: this.turns().map((turn) => ({ ...turn }))
    };
  }

  private buildGenerationGuidance(): string {
    const profile = this.getUserProfile();
    const age = profile.age === null ? 'unknown age' : `age ${profile.age}`;
    return [
      `Generate one gentle, concise memory-recall question for a user named ${profile.name || 'the user'} of ${age}.`,
      `Gender: ${profile.gender}.`,
      'Adapt vocabulary, pacing, specificity, and cognitive load to the profile.',
      'Use the image and prior answers, avoid diagnosis, avoid leading assumptions, and ask only one question.'
    ].join(' ');
  }

  private startRemainingTimer(): void {
    this.clearRemainingTimer();
    this.remainingTimer = window.setInterval(() => {
      this.updateRemainingTime();
      if (this.status() !== 'active' || !this.isTimeExpired()) {
        return;
      }

      if (this.activeQuestion().startsWith('Preparing')) {
        this.completeConversation();
      } else {
        this.error.set('Time is up. Please finish answering the current question.');
      }
    }, 1000);
  }

  private updateRemainingTime(): void {
    const completedThemes = new Set(this.turns().map((turn) => turn.theme).filter(Boolean));
    this.remainingTimeLabel.set(`${Math.min(completedThemes.size, REQUIRED_THEMES.length)} / ${REQUIRED_THEMES.length} themes`);
  }

  private isTimeExpired(): boolean {
    return false;
  }

  private hasCompletedAllThemesAfterAnswer(currentTurn: ConversationTurn): boolean {
    const completedThemes = new Set(
      this.turns()
        .map((turn) => (turn.turn === currentTurn.turn ? currentTurn.theme : turn.theme))
        .filter((theme): theme is NonNullable<ConversationTurn['theme']> => Boolean(theme))
    );
    return REQUIRED_THEMES.every((theme) => completedThemes.has(theme));
  }

  private clearRemainingTimer(): void {
    if (this.remainingTimer) {
      window.clearInterval(this.remainingTimer);
      this.remainingTimer = undefined;
    }
  }

  private scheduleTurnTakingCheck(delayMs: number): void {
    this.clearSpeechEndpointTimer();
    const requestId = ++this.turnTakingRequestId;
    this.speechEndpointTimer = window.setTimeout(() => {
      void this.checkTurnTakingEndpoint(requestId);
    }, delayMs);
  }

  private clearSpeechEndpointTimer(): void {
    if (this.speechEndpointTimer) {
      window.clearTimeout(this.speechEndpointTimer);
      this.speechEndpointTimer = undefined;
    }
  }

  private async checkTurnTakingEndpoint(requestId: number): Promise<void> {
    const sentence = this.draftAnswer().trim();
    if (!sentence || requestId !== this.turnTakingRequestId || this.status() !== 'active') {
      return;
    }

    const pauseTimeSeconds = this.lastFinalSpeechAt > 0
      ? (Date.now() - this.lastFinalSpeechAt) / 1000
      : 0;

    try {
      const hasInterimSpeech = Boolean(this.interimSpeechAnswer.trim());
      const decision = await this.requestTurnTakingDecision(sentence, pauseTimeSeconds, {
        trigger: 'browser-speech-check',
        has_new_transcript: false,
        has_interim_speech: hasInterimSpeech,
        unchanged_chunks: 0,
        endpoint_candidate_count: this.endpointCandidateCount
      });
      if (requestId !== this.turnTakingRequestId || this.draftAnswer().trim() !== sentence || this.status() !== 'active') {
        return;
      }

      const canEndpoint = decision === 1 && !hasInterimSpeech && pauseTimeSeconds >= TURN_TAKING_MIN_ENDPOINT_PAUSE_SECONDS;
      this.endpointCandidateCount = canEndpoint ? this.endpointCandidateCount + 1 : 0;

      if (canEndpoint && this.endpointCandidateCount >= 1) {
        this.stopListening();
        this.submitAnswer();
        return;
      }

      this.scheduleTurnTakingCheck(TURN_TAKING_UNCERTAIN_RECHECK_MS);
    } catch (error) {
      console.warn(error);
      if (this.isListening() && this.draftAnswer().trim() === sentence) {
        this.scheduleTurnTakingCheck(TURN_TAKING_UNCERTAIN_RECHECK_MS);
      }
    }
  }

  private async requestTurnTakingDecision(
    sentence: string,
    pauseTimeSeconds: number,
    metadata: Record<string, unknown> = {}
  ): Promise<0 | 1 | 2> {
    const requestedAt = new Date().toISOString();
    const response = await fetch(`${backendOrigin()}/turn-taking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: this.inferTurnTakingTopic(this.activeQuestion()),
        question: this.activeQuestion(),
        ongoing_dialog: this.buildTurnTakingContext(),
        sentence,
        pause_time_seconds: pauseTimeSeconds,
        session_id: this.sessionId,
        photo_id: this.currentPhoto()?.id ?? '',
        turn: this.lastItem(this.turns())?.turn ?? 0,
        client_requested_at: requestedAt,
        sequence: ++this.turnTakingCheckSequence,
        metadata
      })
    });
    const result = (await response.json()) as { decision?: 0 | 1 | 2; error?: string };
    if (!response.ok || result.decision === undefined) {
      throw new Error(result.error ?? 'Turn-taking detection failed.');
    }
    return result.decision;
  }

  private buildTurnTakingContext(): string {
    return this.turns()
      .map((turn) => `Robot: ${turn.question}\nUser: ${turn.answer ?? (turn.turn === this.lastItem(this.turns())?.turn ? this.draftAnswer() : '')}`)
      .join('\n\n');
  }

  private inferTurnTakingTopic(question: string): 'when' | 'where' | 'who' | 'others' | 'end' {
    const lower = question.toLowerCase();
    if (/\bwhen\b|what time|what year|which year|what month|season/.test(lower)) return 'when';
    if (/\bwhere\b|which place|what place|location/.test(lower)) return 'where';
    if (/\bwho\b|whose|person|people|friend|family|mother|father|sister|brother/.test(lower)) return 'who';
    if (/last|finish|end|anything else/.test(lower)) return 'end';
    return 'others';
  }

  private startNextPhotoIfAvailable(): boolean {
    const nextPhoto = this.photoSequence[this.currentPhotoIndex + 1];
    if (!nextPhoto) {
      return false;
    }

    this.currentPhotoIndex += 1;
    this.currentPhoto.set(nextPhoto);
    this.status.set('idle');
    this.turns.set([]);
    this.pendingFeedback = null;
    this.activeQuestion.set('Starting the next photo...');
    this.draftAnswer.set('');
    this.error.set('');
    this.stopListening();
    this.speakerService.stopSpeaking();
    this.clearFallbackTimer();
    this.clearRemainingTimer();
    window.setTimeout(() => this.startConversation(), 700);
    return true;
  }

  private isTemiRobot(): boolean {
    return this.robotService.robotId().toLowerCase().includes('temi-v3');
  }

  private isWalkerRobot(): boolean {
    return this.robotService.robotId().toLowerCase().includes('walker');
  }

  private async startWalkerListening(): Promise<void> {
    try {
      const response = await fetch(`${backendOrigin()}/walker/record/start`, { method: 'POST' });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? 'Could not start Walker microphone.');
      }

      this.isListening.set(true);
      this.error.set('');
      this.markAnswerStarted();
      this.finalSpeechAnswer = this.draftAnswer().trim();
      this.interimSpeechAnswer = '';
      this.lastTemiTranscriptChunk = '';
      this.temiUnchangedChunks = 0;
      this.scheduleNoSpeechAutoAdvance();
      this.scheduleWalkerTurnTakingChunk();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Walker microphone could not start.';
      this.error.set(`Walker microphone failed. ${detail}`);
      this.isListening.set(false);
    }
  }

  private scheduleWalkerTurnTakingChunk(): void {
    this.clearTemiTurnTakingTimer();
    this.temiTurnTakingTimer = window.setTimeout(() => {
      void this.processWalkerSpeechChunk('turn-taking-chunk', false).catch((error) => {
        if (this.status() !== 'active' || !this.isListening()) return;
        console.warn('Walker recording chunk failed:', error);
        void this.restartWalkerRecording()
          .then(() => this.scheduleWalkerTurnTakingChunk())
          .catch((restartError) => {
            const detail = restartError instanceof Error ? restartError.message : 'Walker microphone restart failed.';
            this.error.set(`Walker microphone failed. ${detail}`);
            this.isListening.set(false);
          });
      });
    }, TEMI_TURN_TAKING_CHUNK_MS);
  }

  private async processWalkerSpeechChunk(reason: string, submitAfterChunk: boolean): Promise<string> {
    const response = await fetch(`${backendOrigin()}/walker/record/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        photo_id: this.currentPhoto()?.id ?? '',
        turn: this.lastItem(this.turns())?.turn ?? 0,
        reason
      })
    });
    const result = (await response.json()) as { transcript?: string; audio_path?: string; error?: string };
    if (!response.ok) {
      throw new Error(result.error ?? 'Walker speech recognition failed.');
    }
    this.rememberTemiAudioPath(result.audio_path);

    const transcript = result.transcript?.trim() ?? '';
    if (transcript && !this.normalizeSpeechText(this.finalSpeechAnswer).endsWith(this.normalizeSpeechText(transcript))) {
      this.finalSpeechAnswer = `${this.finalSpeechAnswer} ${transcript}`.replace(/\s+/g, ' ').trim();
      this.lastFinalSpeechAt = Date.now();
      this.draftAnswer.set(this.finalSpeechAnswer);
      this.error.set('');
      this.scheduleNoSpeechAutoAdvance();
    }

    const sentence = this.draftAnswer().trim();
    if (submitAfterChunk) {
      this.isListening.set(false);
      if (sentence) this.submitAnswer();
      return transcript;
    }

    if (sentence) {
      const pauseTimeSeconds = this.lastFinalSpeechAt > 0 ? (Date.now() - this.lastFinalSpeechAt) / 1000 : 0;
      const decision = await this.requestTurnTakingDecision(sentence, pauseTimeSeconds, {
        trigger: transcript ? 'walker-new-transcript' : 'walker-periodic-chunk',
        chunk_ms: TEMI_TURN_TAKING_CHUNK_MS
      });
      if (decision === 1 && pauseTimeSeconds >= TURN_TAKING_MIN_ENDPOINT_PAUSE_SECONDS) {
        this.finishAutomaticAnswer();
        return transcript;
      }
    }

    if (this.isListening() && this.status() === 'active') {
      await this.restartWalkerRecording();
      this.scheduleWalkerTurnTakingChunk();
    }
    return transcript;
  }

  private async restartWalkerRecording(): Promise<void> {
    const response = await fetch(`${backendOrigin()}/walker/record/start`, { method: 'POST' });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(result.error ?? 'Could not restart Walker microphone.');
    }
  }

  private async startTemiListening(): Promise<void> {
    try {
      const response = await fetch(`${backendOrigin()}/temi/record/start`, { method: 'POST' });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? 'Could not start temi microphone.');
      }
      this.isListening.set(true);
      this.error.set('');
      this.markAnswerStarted();
      this.finalSpeechAnswer = this.draftAnswer().trim();
      this.interimSpeechAnswer = '';
      this.lastTemiTranscriptChunk = '';
      this.temiUnchangedChunks = 0;
      this.scheduleNoSpeechAutoAdvance();
      this.scheduleTemiTurnTakingChunk();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start temi microphone.');
    }
  }

  private async stopTemiListeningAndTranscribe(): Promise<void> {
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
    this.temiChunkInProgress = false;
    this.isListening.set(false);

    try {
      const response = await fetch(`${backendOrigin()}/temi/record/stop`, this.buildTemiRecordStopRequest('manual-stop'));
      const result = (await response.json()) as { transcript?: string; audio_path?: string; error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? 'Speech recognition failed.');
      }
      this.rememberTemiAudioPath(result.audio_path);
      if (!result.transcript?.trim()) {
        this.error.set('No speech was recognized. Speak clearly and try again.');
        return;
      }
      const transcript = result.transcript.trim();
      this.finalSpeechAnswer = `${this.finalSpeechAnswer} ${transcript}`.trim();
      this.interimSpeechAnswer = '';
      this.lastFinalSpeechAt = Date.now();
      this.draftAnswer.set(this.finalSpeechAnswer);
      this.error.set('');
      this.scheduleNoSpeechAutoAdvance();
      this.scheduleTurnTakingCheck(TURN_TAKING_CHECK_DELAY_MS);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Speech recognition failed.');
    }
  }

  private scheduleTemiTurnTakingChunk(): void {
    this.clearTemiTurnTakingTimer();
    this.temiTurnTakingTimer = window.setTimeout(() => {
      void this.processTemiTurnTakingChunk();
    }, TEMI_TURN_TAKING_CHUNK_MS);
  }

  private clearTemiTurnTakingTimer(): void {
    if (this.temiTurnTakingTimer) {
      window.clearTimeout(this.temiTurnTakingTimer);
      this.temiTurnTakingTimer = undefined;
    }
  }

  private async processTemiTurnTakingChunk(): Promise<void> {
    if (!this.isListening() || this.temiChunkInProgress || this.status() !== 'active') {
      return;
    }

    this.temiChunkInProgress = true;
    try {
      const response = await fetch(`${backendOrigin()}/temi/record/stop`, this.buildTemiRecordStopRequest('turn-taking-chunk'));
      const result = (await response.json()) as { transcript?: string; audio_path?: string; error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? 'Speech recognition failed.');
      }
      this.rememberTemiAudioPath(result.audio_path);

      const transcript = result.transcript?.trim() ?? '';
      const normalizedTranscript = this.normalizeSpeechText(transcript);
      const normalizedPreviousChunk = this.normalizeSpeechText(this.lastTemiTranscriptChunk);
      const normalizedAnswer = this.normalizeSpeechText(this.finalSpeechAnswer);
      const hasNewTranscript =
        Boolean(normalizedTranscript) &&
        normalizedTranscript !== normalizedPreviousChunk &&
        !normalizedAnswer.endsWith(normalizedTranscript);

      if (hasNewTranscript) {
        this.finalSpeechAnswer = `${this.finalSpeechAnswer} ${transcript}`.replace(/\s+/g, ' ').trim();
        this.lastFinalSpeechAt = Date.now();
        this.draftAnswer.set(this.finalSpeechAnswer);
        this.lastTemiTranscriptChunk = transcript;
        this.temiUnchangedChunks = 0;
        this.endpointCandidateCount = 0;
        this.scheduleNoSpeechAutoAdvance();
      } else if (this.draftAnswer().trim()) {
        this.temiUnchangedChunks += 1;
      }

      const sentence = this.draftAnswer().trim();
      if (sentence) {
        const pauseTimeSeconds = this.lastFinalSpeechAt > 0 ? (Date.now() - this.lastFinalSpeechAt) / 1000 : 0;
        const hasEnoughPause = pauseTimeSeconds >= TEMI_ENDPOINT_PAUSE_SECONDS;
        const hasRepeatedSilence = this.temiUnchangedChunks >= TEMI_MAX_UNCHANGED_CHUNKS;
        const shouldAskTurnTaking = hasNewTranscript || hasEnoughPause || hasRepeatedSilence;
        const decision = shouldAskTurnTaking
          ? await this.requestTurnTakingDecision(sentence, pauseTimeSeconds, {
            trigger: hasNewTranscript ? 'temi-new-transcript' : hasEnoughPause ? 'temi-pause-threshold' : 'temi-repeated-silence',
            has_new_transcript: hasNewTranscript,
            unchanged_chunks: this.temiUnchangedChunks,
            has_repeated_silence: hasRepeatedSilence,
            endpoint_candidate_count: this.endpointCandidateCount,
            chunk_ms: TEMI_TURN_TAKING_CHUNK_MS
          })
          : 0;

        const canEndpoint = decision === 1 && hasEnoughPause;
        this.endpointCandidateCount = canEndpoint ? this.endpointCandidateCount + 1 : 0;

        if (this.status() === 'active' && canEndpoint) {
          this.finishAutomaticAnswer();
          return;
        }
      }

      if (this.isListening() && this.status() === 'active') {
        await this.restartTemiRecording();
        this.scheduleTemiTurnTakingChunk();
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Speech recognition failed.');
      if (this.isListening() && this.status() === 'active') {
        await this.restartTemiRecording().catch(() => undefined);
        this.scheduleTemiTurnTakingChunk();
      }
    } finally {
      this.temiChunkInProgress = false;
    }
  }

  private async restartTemiRecording(): Promise<void> {
    const response = await fetch(`${backendOrigin()}/temi/record/start`, { method: 'POST' });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(result.error ?? 'Could not restart temi microphone.');
    }
  }

  private finishAutomaticAnswer(): void {
    this.isListening.set(false);
    this.temiChunkInProgress = false;
    this.clearTemiTurnTakingTimer();
    this.clearNoSpeechAutoAdvanceTimer();
    this.submitAnswer();
  }

  private scheduleNoSpeechAutoAdvance(): void {
    this.clearNoSpeechAutoAdvanceTimer();
    if (this.draftAnswer().trim()) {
      return;
    }
    this.noSpeechAutoAdvanceTimer = window.setTimeout(() => {
      this.autoAdvanceAfterNoSpeech();
    }, NO_SPEECH_AUTO_ADVANCE_MS);
  }

  private clearNoSpeechAutoAdvanceTimer(): void {
    if (this.noSpeechAutoAdvanceTimer) {
      window.clearTimeout(this.noSpeechAutoAdvanceTimer);
      this.noSpeechAutoAdvanceTimer = undefined;
    }
  }

  private autoAdvanceAfterNoSpeech(): void {
    this.noSpeechAutoAdvanceTimer = undefined;
    if (this.status() !== 'active') {
      return;
    }

    void this.finishNoSpeechAutoAdvance();
  }

  private async finishNoSpeechAutoAdvance(): Promise<void> {
    if (this.status() !== 'active') {
      return;
    }

    let answer = this.draftAnswer().trim();
    if (this.isWalkerRobot() && this.isListening()) {
      this.clearTemiTurnTakingTimer();
      this.isListening.set(false);
      try {
        const transcript = await this.processWalkerSpeechChunk('no-speech-auto-advance', false);
        if (transcript && !this.normalizeSpeechText(answer).endsWith(this.normalizeSpeechText(transcript))) {
          answer = `${answer} ${transcript}`.replace(/\s+/g, ' ').trim();
        }
      } catch {
        // Even if the final audio chunk fails, advance so the conversation does not get stuck.
      }
    } else if (this.isTemiRobot() && this.isListening()) {
      this.clearTemiTurnTakingTimer();
      this.temiChunkInProgress = false;
      this.isListening.set(false);
      try {
        const response = await fetch(`${backendOrigin()}/temi/record/stop`, this.buildTemiRecordStopRequest('no-speech-auto-advance'));
        const result = (await response.json()) as { transcript?: string; audio_path?: string };
        this.rememberTemiAudioPath(result.audio_path);
        const transcript = result.transcript?.trim() ?? '';
        if (response.ok && transcript && !this.normalizeSpeechText(answer).endsWith(this.normalizeSpeechText(transcript))) {
          answer = `${answer} ${transcript}`.replace(/\s+/g, ' ').trim();
        }
      } catch {
        // Even if the final audio chunk fails, advance so the conversation does not get stuck.
      }
    } else {
      this.stopListening();
    }

    this.draftAnswer.set(answer || NO_RESPONSE_ANSWER);
    this.error.set('');
    this.submitAnswer();
  }

  private normalizeSpeechText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private sendQuestionPlaybackEvent(event: 'start' | 'end'): void {
    const photo = this.currentPhoto();
    const turn = this.lastItem(this.turns())?.turn;
    if (!photo || !turn) return;
    this.socketService.sendQuestionPlaybackEvent({
      type: 'question_playback_event',
      robot_id: this.robotService.robotId(),
      session_id: this.sessionId,
      photo_id: photo.id,
      turn,
      event,
      timestamp: new Date().toISOString()
    });
  }

  private markAnswerStarted(): void {
    if (!this.answerStartedAt) {
      this.answerStartedAt = new Date().toISOString();
    }
    this.startAttentionSampling();
  }

  private startAttentionSampling(): void {
    this.stopAttentionSampling();
    void this.ensureAttentionCamera();
    void this.captureAttentionSample();
    this.attentionTimer = window.setInterval(() => void this.captureAttentionSample(), 1500);
  }

  private stopAttentionSampling(): void {
    if (this.attentionTimer) {
      window.clearInterval(this.attentionTimer);
      this.attentionTimer = undefined;
    }
    this.attentionStream?.getTracks().forEach((track) => track.stop());
    this.attentionStream = undefined;
    this.attentionVideo = undefined;
  }

  private async ensureAttentionCamera(): Promise<void> {
    if (this.attentionVideo || !navigator.mediaDevices?.getUserMedia) return;
    try {
      this.attentionStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 360 } }
      });
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.attentionStream;
      await video.play();
      this.attentionVideo = video;
    } catch {
      this.attentionVideo = undefined;
    }
  }

  private async captureAttentionSample(): Promise<void> {
    const calibration = this.robotService.calibrationValues();
    if (!calibration) return;
    await this.ensureAttentionCamera();
    const measured = await this.measureAttentionFromCamera();
    if (!measured) return;
    const { headPose, eyeGaze } = measured;
    this.attentionSamples.push({
      captured_at: new Date().toISOString(),
      head_direction: this.classifyHeadDirection(headPose, calibration),
      eye_gaze_direction: this.classifyEyeGaze(eyeGaze, calibration),
      head_pose: headPose,
      eye_gaze: eyeGaze
    });
  }

  private async measureAttentionFromCamera(): Promise<{
    headPose: { yaw: number; pitch: number; roll: number };
    eyeGaze: { x: number; y: number };
  } | null> {
    const video = this.attentionVideo;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const canvas = this.attentionCanvas ?? document.createElement('canvas');
    this.attentionCanvas = canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const face = await this.detectAttentionFace(canvas);
    if (!face) return null;
    const centerX = face.x + face.width / 2;
    const centerY = face.y + face.height / 2;
    const normalizedX = (centerX / canvas.width - 0.5) * 2;
    const normalizedY = (centerY / canvas.height - 0.5) * 2;
    const faceWidthRatio = face.width / canvas.width;
    const faceHeightRatio = face.height / canvas.height;
    return {
      headPose: {
        yaw: Number((normalizedX * 30).toFixed(2)),
        pitch: Number((normalizedY * 20).toFixed(2)),
        roll: Number(((faceWidthRatio - faceHeightRatio * 0.78) * 25).toFixed(2))
      },
      eyeGaze: {
        x: Number((normalizedX * 12).toFixed(2)),
        y: Number((normalizedY * 12).toFixed(2))
      }
    };
  }

  private async detectAttentionFace(canvas: HTMLCanvasElement): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const FaceDetectorCtor = (window as unknown as {
      FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => {
        detect(source: CanvasImageSource): Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
      };
    }).FaceDetector;
    if (FaceDetectorCtor) {
      const faces = await new FaceDetectorCtor({ fastMode: true, maxDetectedFaces: 1 }).detect(canvas);
      const box = faces[0]?.boundingBox;
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    }
    const temiVision = (window as unknown as { TemiVision?: { detectFace(base64Image: string): string } }).TemiVision;
    if (!temiVision) return this.detectHeuristicFace(canvas);
    const result = JSON.parse(temiVision.detectFace(canvas.toDataURL('image/jpeg', 0.55))) as {
      detected?: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
    if (!result.detected || result.x === undefined || result.y === undefined || result.width === undefined || result.height === undefined) {
      return null;
    }
    return { x: result.x, y: result.y, width: result.width, height: result.height };
  }

  private detectHeuristicFace(canvas: HTMLCanvasElement): { x: number; y: number; width: number; height: number } | null {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    const step = Math.max(4, Math.round(Math.max(canvas.width, canvas.height) / 160));
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = 0;
    let maxY = 0;
    let count = 0;

    for (let y = 0; y < canvas.height; y += step) {
      for (let x = 0; x < canvas.width; x += step) {
        const index = (y * canvas.width + x) * 4;
        const r = image.data[index];
        const g = image.data[index + 1];
        const b = image.data[index + 2];
        const maxChannel = Math.max(r, g, b);
        const minChannel = Math.min(r, g, b);
        const looksLikeSkin = r > 65 && g > 38 && b > 24 && maxChannel - minChannel > 12 && r > g && r > b;
        if (!looksLikeSkin) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const minPixels = Math.max(18, (canvas.width * canvas.height) / (step * step) * 0.01);
    if (count < minPixels || width < canvas.width * 0.08 || height < canvas.height * 0.12) {
      return null;
    }

    return {
      x: Math.max(0, minX - width * 0.15),
      y: Math.max(0, minY - height * 0.2),
      width: Math.min(canvas.width - minX, width * 1.3),
      height: Math.min(canvas.height - minY, height * 1.35)
    };
  }

  private classifyHeadDirection(
    headPose: { yaw: number; pitch: number; roll: number },
    calibration: NonNullable<UserProfile['calibration']>
  ): 'up' | 'down' | 'left' | 'right' | 'center' {
    const yawDelta = headPose.yaw - calibration.head_pose.yaw;
    const pitchDelta = headPose.pitch - calibration.head_pose.pitch;
    if (yawDelta < -8) return 'left';
    if (yawDelta > 8) return 'right';
    if (pitchDelta < -6) return 'up';
    if (pitchDelta > 6) return 'down';
    return 'center';
  }

  private classifyEyeGaze(
    eyeGaze: { x: number; y: number },
    calibration: NonNullable<UserProfile['calibration']>
  ): 'left' | 'right' | 'central' {
    const xDelta = eyeGaze.x - calibration.eye_gaze.x;
    if (xDelta < -4) return 'left';
    if (xDelta > 4) return 'right';
    return 'central';
  }

  private buildTemiRecordStopRequest(reason: string): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        photo_id: this.currentPhoto()?.id ?? '',
        turn: this.lastItem(this.turns())?.turn ?? 0,
        reason
      })
    };
  }

  private rememberTemiAudioPath(path?: string): void {
    if (path && !this.temiAudioPaths.includes(path)) {
      this.temiAudioPaths.push(path);
    }
  }

  private cleanupTemiRecording(): void {
    if (this.temiProcessor) {
      this.temiProcessor.onaudioprocess = null;
      this.temiProcessor.disconnect();
    }
    this.temiMediaStream?.getTracks().forEach((track) => track.stop());
    void this.temiAudioContext?.close();
    this.temiProcessor = null;
    this.temiMediaStream = null;
    this.temiAudioContext = null;
  }

  private encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const writeText = (offset: number, value: string): void => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, length * 2, true);
    let offset = 44;
    for (const chunk of chunks) {
      for (const sample of chunk) {
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        offset += 2;
      }
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  private lastItem<T>(items: T[]): T | undefined {
    return items.length ? items[items.length - 1] : undefined;
  }
}
