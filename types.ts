
export enum CallStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  DISCONNECTING = 'DISCONNECTING',
  ERROR = 'ERROR'
}

export interface TranscriptionEntry {
  role: 'user' | 'ai';
  text: string;
  timestamp: number;
}

export type VoiceName = 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';

export interface CallState {
  status: CallStatus;
  isMuted: boolean;
  isSpeakerOn: boolean;
  selectedVoice: VoiceName;
  selectedModel: string;
  targetLanguage: string;
  transcriptions: TranscriptionEntry[];
  isUserSpeaking: boolean;
  error?: string;
}
