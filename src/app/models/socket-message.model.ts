export type SocketConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface UserProfile {
  name: string;
  age: number | null;
  memory_decline_level: string;
  gender: string;
  conversation_duration_minutes: number;
  calibration?: {
    head_pose: {
      yaw: number;
      pitch: number;
      roll: number;
    };
    eye_gaze: {
      x: number;
      y: number;
    };
    samples: number;
  } | null;
}

export interface ConversationContext {
  user_profile: UserProfile;
  locale: string;
  generation_guidance: string;
  conversation_history: Array<{
    turn: number;
    theme?: 'where' | 'when' | 'who' | 'others';
    question: string;
    answer?: string;
    feedback?: string;
  }>;
}

export interface ImageUploadMessage {
  type: 'image_upload';
  robot_id: string;
  data: string;
}

export interface MemoryConversationStartMessage {
  type: 'memory_conversation_start';
  robot_id: string;
  session_id: string;
  photo_id: string;
  image_data: string;
  user_profile: UserProfile;
  context: ConversationContext;
}

export interface MemoryAnswerMessage {
  type: 'memory_answer';
  robot_id: string;
  session_id: string;
  photo_id: string;
  turn: number;
  answer: string;
  answer_started_at?: string;
  answer_ended_at?: string;
  audio_paths?: string[];
  attention_samples?: Array<{
    captured_at: string;
    head_direction: 'up' | 'down' | 'left' | 'right' | 'center';
    eye_gaze_direction: 'left' | 'right' | 'central';
    head_pose: { yaw: number; pitch: number; roll: number };
    eye_gaze: { x: number; y: number };
  }>;
  end_after_answer: boolean;
  image_data: string;
  user_profile: UserProfile;
  context: ConversationContext;
}

export interface QuestionPlaybackEventMessage {
  type: 'question_playback_event';
  robot_id: string;
  session_id: string;
  photo_id: string;
  turn: number;
  event: 'start' | 'end';
  timestamp: string;
}

export interface AudioStreamMessage {
  type: 'audio_stream';
  payload: string;
}

export interface MemoryQuestionMessage {
  type: 'memory_question';
  photo_id: string;
  turn: number;
  question: string;
  theme?: 'where' | 'when' | 'who' | 'others';
  image_description?: string;
  audio_payload?: string;
  is_final?: boolean;
}

export interface MemoryFeedbackMessage {
  type: 'memory_feedback';
  photo_id: string;
  turn: number;
  feedback: string;
  feedback_audio_payload?: string;
}

export interface MemoryErrorMessage {
  type: 'memory_error';
  photo_id: string;
  message: string;
}

export type BackendMessage = AudioStreamMessage | MemoryQuestionMessage | MemoryFeedbackMessage | MemoryErrorMessage;

export type FrontendRobotMessage =
  | ImageUploadMessage
  | MemoryConversationStartMessage
  | MemoryAnswerMessage
  | QuestionPlaybackEventMessage;
