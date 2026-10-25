export interface UploadedPhoto {
  id: string;
  name: string;
  size: number;
  dataUrl: string;
  uploadedAt: number;
}

export interface ConversationTurn {
  turn: number;
  theme?: 'where' | 'when' | 'who' | 'others';
  question: string;
  answer?: string;
  feedback?: string;
}

export type ConversationStatus = 'idle' | 'active' | 'completed';
