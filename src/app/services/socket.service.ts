import { Injectable, NgZone, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import {
  BackendMessage,
  FrontendRobotMessage,
  ImageUploadMessage,
  MemoryConversationStartMessage,
  MemoryAnswerMessage,
  QuestionPlaybackEventMessage,
  SocketConnectionStatus
} from '../models/socket-message.model';
import { backendOrigin } from '../shared/backend-url.util';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly socket: Socket;
  private readonly messagesSubject = new Subject<BackendMessage>();

  readonly connectionStatus = signal<SocketConnectionStatus>('connecting');
  readonly messages$: Observable<BackendMessage> = this.messagesSubject.asObservable();

  constructor(private readonly zone: NgZone) {
    this.socket = io(backendOrigin(), {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      transports: ['websocket']
    });

    this.registerSocketListeners();
  }

  sendImageUpload(message: ImageUploadMessage): void {
    this.emitRobotMessage(message);
  }

  sendMemoryConversationStart(message: MemoryConversationStartMessage): void {
    this.emitRobotMessage(message);
  }

  sendMemoryAnswer(message: MemoryAnswerMessage): void {
    this.emitRobotMessage(message);
  }

  sendQuestionPlaybackEvent(message: QuestionPlaybackEventMessage): void {
    this.emitRobotMessage(message);
  }

  private emitRobotMessage(message: FrontendRobotMessage): void {
    if (!this.socket.connected) {
      this.socket.connect();
    }

    this.socket.emit('robot_message', message);
  }

  reconnect(): void {
    this.connectionStatus.set('connecting');
    this.socket.disconnect();
    this.socket.connect();
  }

  private registerSocketListeners(): void {
    this.socket.on('connect', () => {
      this.zone.run(() => this.connectionStatus.set('connected'));
    });

    this.socket.on('disconnect', () => {
      this.zone.run(() => this.connectionStatus.set('disconnected'));
    });

    this.socket.io.on('reconnect_attempt', () => {
      this.zone.run(() => this.connectionStatus.set('connecting'));
    });

    this.socket.on('server_message', (message: BackendMessage) => {
      this.zone.run(() => this.messagesSubject.next(this.normalizeBackendMessage(message)));
    });

    this.socket.on('audio_stream', (message: BackendMessage | string) => {
      this.zone.run(() => this.messagesSubject.next(this.normalizeBackendMessage(message)));
    });

    this.socket.on('memory_question', (message: BackendMessage) => {
      this.zone.run(() => this.messagesSubject.next(message));
    });

    this.socket.on('memory_feedback', (message: BackendMessage) => {
      this.zone.run(() => this.messagesSubject.next(message));
    });

    this.socket.on('memory_error', (message: BackendMessage) => {
      this.zone.run(() => this.messagesSubject.next(message));
    });

    this.socket.on('connect_error', () => {
      this.zone.run(() => this.connectionStatus.set('disconnected'));
    });
  }

  private normalizeBackendMessage(message: BackendMessage | string): BackendMessage {
    if (typeof message === 'string') {
      return {
        type: 'audio_stream',
        payload: message
      };
    }

    return message;
  }
}
