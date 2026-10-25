import { Injectable, signal } from '@angular/core';

export type Gender = 'female' | 'male' | 'non_binary' | 'prefer_not_to_say';
export type MemoryDeclineLevel = 'none' | 'mild' | 'moderate' | 'severe';
export type ConversationDurationMinutes = 2 | 5 | 10;

export interface CalibrationValues {
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
}

@Injectable({ providedIn: 'root' })
export class RobotService {
  readonly robotId = signal(this.getInitialRobotId());
  readonly userName = signal('');
  readonly age = signal<number | null>(null);
  readonly memoryDeclineLevel = signal<MemoryDeclineLevel>('mild');
  readonly gender = signal<Gender>('prefer_not_to_say');
  readonly conversationDurationMinutes = signal<ConversationDurationMinutes>(5);
  readonly calibrationValues = signal<CalibrationValues | null>(null);

  setRobotId(robotId: string): void {
    const normalized = robotId.trim() || 'temi-v3-192.168.1.109';
    this.robotId.set(normalized);
    window.localStorage.setItem('memory-companion-robot-id', normalized);
  }

  setUserName(name: string): void {
    this.userName.set(name.trim());
  }

  setAge(age: number | null): void {
    this.age.set(age);
  }

  setMemoryDeclineLevel(level: MemoryDeclineLevel): void {
    this.memoryDeclineLevel.set(level);
  }

  setGender(gender: Gender): void {
    this.gender.set(gender);
  }

  setConversationDurationMinutes(duration: ConversationDurationMinutes): void {
    this.conversationDurationMinutes.set(duration);
  }

  setCalibrationValues(values: CalibrationValues | null): void {
    this.calibrationValues.set(values);
  }

  private getInitialRobotId(): string {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('robot_id') || params.get('robot');
    const fromStorage = window.localStorage.getItem('memory-companion-robot-id');
    return (fromUrl || fromStorage || 'temi-v3-192.168.1.109').trim();
  }
}
