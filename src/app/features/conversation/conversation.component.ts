import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { ConversationService } from '../../services/conversation.service';

@Component({
  selector: 'app-conversation',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.scss'
})
export class ConversationComponent {
  private readonly conversationService = inject(ConversationService);

  readonly photo = this.conversationService.currentPhoto;
  readonly status = this.conversationService.status;
  readonly turns = this.conversationService.turns;
  readonly activeQuestion = this.conversationService.activeQuestion;
  readonly draftAnswer = this.conversationService.draftAnswer;
  readonly isListening = this.conversationService.isListening;
  readonly error = this.conversationService.error;
  readonly remainingTimeLabel = this.conversationService.remainingTimeLabel;
  readonly progressLabel = computed(() => {
    const turns = this.turns();
    const activeTurn = turns.length ? turns[turns.length - 1].turn : 0;
    return `${activeTurn}`;
  });

  submitAnswer(): void {
    this.conversationService.submitAnswer();
  }

  toggleListening(): void {
    this.conversationService.toggleListening();
  }

  replayQuestion(): void {
    this.conversationService.replayQuestion();
  }

  exitConversation(): void {
    this.conversationService.exitConversation();
  }
}
