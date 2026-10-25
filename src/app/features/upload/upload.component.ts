import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ConversationService } from '../../services/conversation.service';
import { RobotService } from '../../services/robot.service';
import { SocketService } from '../../services/socket.service';
import { fileToBase64 } from '../../shared/image-base64.util';
import { createLocalId } from '../../shared/local-id.util';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './upload.component.html',
  styleUrl: './upload.component.scss'
})
export class UploadComponent {
  private readonly conversationService = inject(ConversationService);
  private readonly robotService = inject(RobotService);
  private readonly socketService = inject(SocketService);

  readonly conversationStatus = this.conversationService.status;
  readonly previewUrl = signal<string | null>(null);
  readonly fileName = signal<string>('');
  readonly fileSize = signal<number>(0);
  readonly error = signal<string>('');
  readonly isSending = signal(false);
  readonly selectedInfo = computed(() => {
    const size = this.fileSize();
    return size > 0 ? `${this.fileName()} - ${(size / 1024).toFixed(1)} KB` : 'No image selected';
  });

  async handleFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    this.error.set('');
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      this.error.set('Please choose an image file.');
      input.value = '';
      return;
    }

    this.isSending.set(true);
    let base64: string;
    try {
      base64 = await fileToBase64(file);
    } catch {
      this.error.set('Image read failed. Please choose another file.');
      this.isSending.set(false);
      return;
    }

    this.previewUrl.set(base64);
    this.fileName.set(file.name);
    this.fileSize.set(file.size);

    try {
      this.conversationService.setPhoto({
        id: createLocalId(),
        name: file.name,
        size: file.size,
        dataUrl: base64,
        uploadedAt: Date.now()
      });
      this.socketService.sendImageUpload({
        type: 'image_upload',
        robot_id: this.robotService.robotId(),
        data: base64
      });
    } catch {
      this.error.set('The image loaded, but it could not be sent to the conversation service. Please retry.');
    } finally {
      this.isSending.set(false);
    }
  }

  startConversation(): void {
    this.conversationService.startConversation();
  }
}
