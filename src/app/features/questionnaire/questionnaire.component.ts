import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { backendOrigin } from '../../shared/backend-url.util';

type LikertItem = {
  id: string;
  text: string;
};

type SassiCategory = {
  id: string;
  label: string;
  items: LikertItem[];
};

type QuestionnairePayload = {
  participant: {
    name: string;
    age: number | null;
    gender: string;
    session_order: string;
    session_date: string;
  };
  consent: {
    agreed_to_participate: boolean;
    agreed_to_audio_recording: boolean;
    agreed_to_camera_attention_metrics: boolean;
  };
  sus: Record<string, number | null>;
  nasa_tlx: Record<string, number | null>;
  sassi: Record<string, number | null>;
  comparison: {
    preferred_robot: string;
    preference_reason: string;
    influential_aspects: string;
    disliked_aspects: string;
    improvement_suggestions: string;
  };
};

@Component({
  selector: 'app-questionnaire',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './questionnaire.component.html',
  styleUrl: './questionnaire.component.scss'
})
export class QuestionnaireComponent {
  readonly participantName = signal('');
  readonly age = signal<number | null>(null);
  readonly gender = signal('prefer_not_to_say');
  readonly sessionOrder = signal('single');
  readonly sessionDate = signal(new Date().toISOString().slice(0, 10));
  readonly agreedToParticipate = signal(false);
  readonly agreedToAudio = signal(false);
  readonly agreedToCameraMetrics = signal(false);
  readonly preferredRobot = signal('');
  readonly preferenceReason = signal('');
  readonly influentialAspects = signal('');
  readonly dislikedAspects = signal('');
  readonly improvementSuggestions = signal('');
  readonly isSubmitting = signal(false);
  readonly submitMessage = signal('');
  readonly submitError = signal('');
  readonly savedFolder = signal('');

  readonly susItems: LikertItem[] = [
    { id: 'sus_q1', text: 'I think that I would like to use this robot memory companion frequently.' },
    { id: 'sus_q2', text: 'I found the robot memory companion unnecessarily complex.' },
    { id: 'sus_q3', text: 'I thought the robot memory companion was easy to use.' },
    { id: 'sus_q4', text: 'I think that I would need the support of a technical person to be able to use this robot memory companion.' },
    { id: 'sus_q5', text: 'I found the various functions in this robot memory companion were well integrated.' },
    { id: 'sus_q6', text: 'I thought there was too much inconsistency in this robot memory companion.' },
    { id: 'sus_q7', text: 'I would imagine that most people would learn to use this robot memory companion very quickly.' },
    { id: 'sus_q8', text: 'I found the robot memory companion very cumbersome to use.' },
    { id: 'sus_q9', text: 'I felt very confident using the robot memory companion.' },
    { id: 'sus_q10', text: 'I needed to learn a lot of things before I could get going with this robot memory companion.' }
  ];

  readonly tlxItems: LikertItem[] = [
    { id: 'mental_demand', text: 'How mentally demanding was the task?' },
    { id: 'physical_demand', text: 'How physically demanding was the task?' },
    { id: 'temporal_demand', text: 'How hurried or rushed was the pace of the task?' },
    { id: 'performance', text: 'How successful were you in accomplishing what you were asked to do?' },
    { id: 'effort', text: 'How hard did you have to work to accomplish your level of performance?' },
    { id: 'frustration', text: 'How insecure, discouraged, irritated, stressed, and annoyed were you?' }
  ];

  readonly sassiCategories: SassiCategory[] = [
    {
      id: 'accuracy',
      label: 'Accuracy',
      items: [
        { id: 'accuracy_1', text: 'The robot memory companion is accurate.' },
        { id: 'accuracy_2', text: 'The robot memory companion is unreliable.' },
        { id: 'accuracy_3', text: 'The interaction with the robot memory companion is unpredictable.' },
        { id: 'accuracy_4', text: 'The robot memory companion did not always do what I expected.' },
        { id: 'accuracy_5', text: 'The robot memory companion is dependable.' },
        { id: 'accuracy_6', text: 'The robot memory companion makes few errors.' },
        { id: 'accuracy_7', text: 'The interaction with the robot memory companion is consistent.' },
        { id: 'accuracy_8', text: 'The interaction with the robot memory companion is efficient.' }
      ]
    },
    {
      id: 'likeability',
      label: 'Likeability',
      items: [
        { id: 'likeability_1', text: 'The robot memory companion is useful.' },
        { id: 'likeability_2', text: 'The robot memory companion is pleasant.' },
        { id: 'likeability_3', text: 'The robot memory companion is friendly.' },
        { id: 'likeability_4', text: 'I enjoyed using the robot memory companion.' },
        { id: 'likeability_5', text: 'It is clear how to speak to the robot memory companion.' },
        { id: 'likeability_6', text: 'It is easy to learn to use the robot memory companion.' },
        { id: 'likeability_7', text: 'I would use this robot memory companion again.' },
        { id: 'likeability_8', text: 'I felt in control of the interaction with the robot memory companion.' }
      ]
    },
    {
      id: 'cognitive_demand',
      label: 'Cognitive Demand',
      items: [
        { id: 'cognitive_demand_1', text: 'I felt confident using the robot memory companion.' },
        { id: 'cognitive_demand_2', text: 'I felt tense using the robot memory companion.' },
        { id: 'cognitive_demand_3', text: 'I felt calm using the robot memory companion.' },
        { id: 'cognitive_demand_4', text: 'A high level of concentration is required when using the robot memory companion.' },
        { id: 'cognitive_demand_5', text: 'The robot memory companion is easy to use.' }
      ]
    },
    {
      id: 'annoyance',
      label: 'Annoyance',
      items: [
        { id: 'annoyance_1', text: 'The interaction with the robot memory companion is repetitive.' },
        { id: 'annoyance_2', text: 'The interaction with the robot memory companion is boring.' },
        { id: 'annoyance_3', text: 'The interaction with the robot memory companion is irritating.' },
        { id: 'annoyance_4', text: 'The interaction with the robot memory companion is frustrating.' },
        { id: 'annoyance_5', text: 'The robot memory companion is too inflexible.' }
      ]
    },
    {
      id: 'habitability',
      label: 'Habitability',
      items: [
        { id: 'habitability_1', text: 'I sometimes wondered if I was following the conversation produced by the robot memory companion.' },
        { id: 'habitability_2', text: 'I always knew what to say to the robot memory companion.' },
        { id: 'habitability_3', text: 'I was not always sure what the robot memory companion was doing.' },
        { id: 'habitability_4', text: 'It is easy to lose track of where you are in an interaction with the robot memory companion.' }
      ]
    },
    {
      id: 'speed',
      label: 'Speed',
      items: [
        { id: 'speed_1', text: 'The interaction with the robot memory companion is fast.' },
        { id: 'speed_2', text: 'The robot memory companion answers too slowly.' }
      ]
    }
  ];

  readonly allSassiItems = computed(() => this.sassiCategories.flatMap((category) => category.items));
  readonly susResponses = signal(this.createEmptyResponses(this.susItems));
  readonly tlxResponses = signal(this.createEmptyResponses(this.tlxItems));
  readonly sassiResponses = signal(this.createEmptyResponses(this.allSassiItems()));

  setAge(value: string): void {
    const parsed = Number(value);
    this.age.set(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
  }

  setResponse(group: 'sus' | 'tlx' | 'sassi', id: string, value: number): void {
    const target = group === 'sus' ? this.susResponses : group === 'tlx' ? this.tlxResponses : this.sassiResponses;
    target.update((responses) => ({ ...responses, [id]: value }));
  }

  async submit(): Promise<void> {
    this.submitError.set('');
    this.submitMessage.set('');
    this.savedFolder.set('');
    const validation = this.validate();
    if (validation) {
      this.submitError.set(validation);
      return;
    }

    this.isSubmitting.set(true);
    try {
      const response = await fetch(`${backendOrigin()}/questionnaire-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.buildPayload())
      });
      const result = (await response.json()) as { ok?: boolean; folder_name?: string; output_dir?: string; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error ?? 'The questionnaire could not be saved.');
      }
      this.savedFolder.set(result.folder_name ?? '');
      this.submitMessage.set('Questionnaire saved successfully. Thank you.');
    } catch (error) {
      this.submitError.set(error instanceof Error ? error.message : 'The questionnaire could not be saved.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private buildPayload(): QuestionnairePayload {
    return {
      participant: {
        name: this.participantName().trim(),
        age: this.age(),
        gender: this.gender(),
        session_order: this.sessionOrder(),
        session_date: this.sessionDate()
      },
      consent: {
        agreed_to_participate: this.agreedToParticipate(),
        agreed_to_audio_recording: this.agreedToAudio(),
        agreed_to_camera_attention_metrics: this.agreedToCameraMetrics()
      },
      sus: this.susResponses(),
      nasa_tlx: this.tlxResponses(),
      sassi: this.sassiResponses(),
      comparison: {
        preferred_robot: this.preferredRobot(),
        preference_reason: this.preferenceReason().trim(),
        influential_aspects: this.influentialAspects().trim(),
        disliked_aspects: this.dislikedAspects().trim(),
        improvement_suggestions: this.improvementSuggestions().trim()
      }
    };
  }

  private validate(): string {
    if (!this.participantName().trim()) return 'Please enter the participant name.';
    if (!this.age()) return 'Please enter the participant age.';
    if (!this.agreedToParticipate()) return 'Please confirm consent before submitting.';
    if (this.hasMissing(this.susResponses())) return 'Please complete all SUS questions.';
    if (this.hasMissing(this.tlxResponses())) return 'Please complete all NASA-TLX questions.';
    if (this.hasMissing(this.sassiResponses())) return 'Please complete all SASSI questions.';
    return '';
  }

  private hasMissing(responses: Record<string, number | null>): boolean {
    return Object.values(responses).some((value) => value === null);
  }

  private createEmptyResponses(items: LikertItem[]): Record<string, number | null> {
    return Object.fromEntries(items.map((item) => [item.id, null]));
  }
}
