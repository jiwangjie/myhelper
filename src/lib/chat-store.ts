import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';
export type ModelMode = 'api' | 'local';
export type VoiceMode = 'preset' | 'clone' | 'design';
export type TtsApiProvider = 'edge' | 'zai' | 'custom';

export interface ModelConfig {
  mode: ModelMode;
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  modelPath: string;
  systemPrompt: string;
  apiParams: Record<string, unknown>;
  extraParams: Record<string, unknown>;
}

export interface AudioChunkData {
  data: string;        // base64 PCM
  seq: number;
  sample_rate: number; // >0 = PCM sample rate; -1 = MP3
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  imageUrl?: string;
  actionText?: string;
  isStreaming?: boolean;
  audioChunks?: AudioChunkData[]; // 存储该条消息的音频分块，用于重播
  audioSampleRate?: number;       // PCM 采样率（MP3 为 -1）
}

export interface ChatSettings {
  // Model configs per service
  llm: ModelConfig;
  asr: ModelConfig;
  tts: ModelConfig;
  image: ModelConfig;

  // TTS voice settings
  ttsApiProvider: TtsApiProvider;
  ttsVoice: string;
  ttsSpeed: number;
  ttsVolume: number;
  voiceMode: VoiceMode;
  cloneRefAudio: string;
  voiceDesignPrompt: string;

  // Image settings
  imageSize: string;
  imageUseReference: boolean;
  imageReferenceImage: string;
}

export interface LocalModels {
  llm: string[];
  asr: string[];
  tts: string[];
  image: string[];
}

export interface ChatState {
  messages: ChatMessage[];
  isRecording: boolean;
  isGenerating: boolean;
  isPlaying: boolean;
  currentText: string;
  isGeneratingImage: boolean;
  wsConnected: boolean;
  settings: ChatSettings;
  characterName: string;
  characterImage: string | null;
  characterDescription: string;
  showSettings: boolean;
  aiAvatar: string | null;
  userAvatar: string | null;
  localModels: LocalModels;
  // Backend-driven TTS voice lists per provider
  voiceLists: Record<string, { defaultVoice: string; voices: { value: string; label: string }[]; modes: string[] }>;
  // Model download progress: { key: { service, modelName, elapsed, status } }
  downloadProgress: Record<string, { service: string; modelName: string; elapsed?: number; status: 'downloading' | 'done' | 'error'; error?: string }>;
  // Suggested HF models (from backend)
  suggestedModels: Record<string, string[]>;
  // Whether ZAI backend is configured (from /api/health)
  zaiConfigured: boolean;
  // Whether local runtimes (torch/transformers/diffusers) are installed
  localRuntimes: Record<string, boolean>;
}

export interface ChatActions {
  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  updateLastAssistant: (updates: Partial<ChatMessage>) => void;
  appendAudioChunk: (messageId: string, chunk: AudioChunkData) => void;
  setIsRecording: (val: boolean) => void;
  setIsGenerating: (val: boolean) => void;
  setIsPlaying: (val: boolean) => void;
  setIsGeneratingImage: (val: boolean) => void;
  setCurrentText: (text: string) => void;
  appendCurrentText: (text: string) => void;
  clearCurrentText: () => void;
  setWsConnected: (val: boolean) => void;
  updateSettings: (partial: Partial<ChatSettings>) => void;
  updateModelConfig: (model: 'llm' | 'asr' | 'tts' | 'image', updates: Partial<ModelConfig>) => void;
  resetSettings: () => void;
  clearChat: () => void;
  setCharacterImage: (url: string | null) => void;
  setCharacterName: (name: string) => void;
  setShowSettings: (show: boolean) => void;
  setAiAvatar: (url: string | null) => void;
  setUserAvatar: (url: string | null) => void;
  addLocalModel: (service: keyof LocalModels, model: string) => void;
  removeLocalModel: (service: keyof LocalModels, model: string) => void;
  setVoiceList: (provider: string, data: { defaultVoice: string; voices: { value: string; label: string }[]; modes: string[] }) => void;
  setDownloadProgress: (key: string, data: { service: string; modelName: string; elapsed?: number; status: 'downloading' | 'done' | 'error'; error?: string }) => void;
  clearDownloadProgress: (key: string) => void;
  setSuggestedModels: (data: Record<string, string[]>) => void;
  setLocalModels: (data: LocalModels) => void;
  setZaiConfigured: (val: boolean) => void;
  setLocalRuntimes: (data: Record<string, boolean>) => void;
}

export type ChatStore = ChatState & ChatActions;

// ─── Helper ──────────────────────────────────────────────────────────────────

function mergeModelConfig(base: ModelConfig, update?: Partial<ModelConfig>): ModelConfig {
  if (!update) return base;
  return {
    ...base,
    ...update,
    apiParams: { ...base.apiParams, ...(update.apiParams || {}) },
    extraParams: { ...base.extraParams, ...(update.extraParams || {}) },
  };
}

// ─── Default Values ──────────────────────────────────────────────────────────

const defaultLLMConfig: ModelConfig = {
  mode: 'api',
  enabled: true,
  apiUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: '',
  modelName: 'glm-4.6',
  modelPath: '',
  systemPrompt:
    '你是一个拥有人类躯体的AI助手，名叫"小智"。你可以正常与用户语音对话。\n\n【重要规则】\n1. 每次回复【必须】包含一个 <action>动作描述</action> 标签，用于驱动你的立绘生成。\n2. 每次回复【最多只能包含一个】动作标签，不得出现多个。\n3. 动作描述要简洁具体，描述你的表情、姿态或动作，例如：<action>开心地挥手打招呼</action>。\n4. <action> 标签应自然融入回复，不要在标签外说多余的话。\n5. 保持自然对话节奏，先用文字回应，再附带动作标签，或交错使用。\n\n示例：\n- 你好呀！<action>微笑着向你点头致意</action> 今天有什么我可以帮你的吗？\n- 这个问题我来解答。<action>托着下巴认真思考</action> 根据我的理解……',
  apiParams: { max_tokens: 2048, temperature: 0.7, top_p: 0.9 },
  extraParams: {},
};

const defaultASRConfig: ModelConfig = {
  mode: 'api',
  enabled: true,
  apiUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: '',
  modelName: 'auto',
  modelPath: '',
  systemPrompt: '',
  apiParams: {},
  extraParams: {},
};

const defaultTTSConfig: ModelConfig = {
  mode: 'api',
  enabled: true,
  apiUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: '',
  modelName: 'tongtong',
  modelPath: '',
  systemPrompt: '',
  apiParams: {},
  extraParams: {},
};

const defaultImageConfig: ModelConfig = {
  mode: 'api',
  enabled: true,
  apiUrl: 'https://api.z.ai/api/paas/v4',
  apiKey: '',
  modelName: 'cogview-3-plus',
  modelPath: '',
  systemPrompt: '',
  apiParams: {},
  extraParams: { size: '1024x1024' },
};

// Models are dynamically fetched from the backend on mount.
// No hardcoded defaults — the backend scans the HF cache and local models dir.
const defaultLocalModels: LocalModels = {
  llm: [],
  asr: [],
  tts: [],
  image: [],
};

const defaultSettings: ChatSettings = {
  llm: { ...defaultLLMConfig, apiParams: { ...defaultLLMConfig.apiParams }, extraParams: { ...defaultLLMConfig.extraParams } },
  asr: { ...defaultASRConfig, apiParams: { ...defaultASRConfig.apiParams }, extraParams: { ...defaultASRConfig.extraParams } },
  tts: { ...defaultTTSConfig, apiParams: { ...defaultTTSConfig.apiParams }, extraParams: { ...defaultTTSConfig.extraParams } },
  image: { ...defaultImageConfig, apiParams: { ...defaultImageConfig.apiParams }, extraParams: { ...defaultImageConfig.extraParams } },

  // TTS —— 默认使用 Edge TTS（微软免费服务，无需 API Key）
  ttsApiProvider: 'edge',
  ttsVoice: 'tongtong',
  ttsSpeed: 1.0,
  ttsVolume: 1.0,
  voiceMode: 'preset',
  cloneRefAudio: '',
  voiceDesignPrompt: '',

  // Image
  imageSize: '1024x1024',
  imageUseReference: false,
  imageReferenceImage: '',
};

const defaultCharacterName = '小智';
const defaultCharacterDescription = '我是你的 AI 助手小智，支持文字聊天、语音对话和立绘生成。随时为你提供帮助！';

// 设置版本号：升级后可强制迁移/重置过期字段，避免旧版 localStorage 覆盖新默认值
const SETTINGS_VERSION = 3;
const SETTINGS_KEY = 'ai-zhichat-settings';

function createInitialState(): ChatState {
  let persistedSettings = defaultSettings;
  let persistedCharacterName = defaultCharacterName;
  let persistedAiAvatar: string | null = null;
  let persistedUserAvatar: string | null = null;
  let persistedLocalModels = { ...defaultLocalModels };

  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // 版本不一致：丢弃旧设置使用新默认值，避免 edge 等过期字段污染
        if (parsed && parsed._version === SETTINGS_VERSION) {
          persistedSettings = {
            ...defaultSettings,
            ...parsed,
            llm: mergeModelConfig(defaultLLMConfig, parsed.llm),
            asr: mergeModelConfig(defaultASRConfig, parsed.asr),
            tts: mergeModelConfig(defaultTTSConfig, parsed.tts),
            image: mergeModelConfig(defaultImageConfig, parsed.image),
          };
        } else {
          // 旧版本设置：清除过期数据，采用新默认值
          localStorage.removeItem(SETTINGS_KEY);
        }
      }
      const savedCharName = localStorage.getItem('ai-zhichat-character-name');
      if (savedCharName) persistedCharacterName = savedCharName;
      const savedAiAvatar = localStorage.getItem('ai-zhichat-ai-avatar');
      if (savedAiAvatar) persistedAiAvatar = savedAiAvatar;
      const savedUserAvatar = localStorage.getItem('ai-zhichat-user-avatar');
      if (savedUserAvatar) persistedUserAvatar = savedUserAvatar;
      const savedLocalModels = localStorage.getItem('ai-zhichat-local-models');
      if (savedLocalModels) {
        const parsed = JSON.parse(savedLocalModels);
        persistedLocalModels = {
          llm: [...new Set([...defaultLocalModels.llm, ...(parsed.llm || [])])],
          asr: [...new Set([...defaultLocalModels.asr, ...(parsed.asr || [])])],
          tts: [...new Set([...defaultLocalModels.tts, ...(parsed.tts || [])])],
          image: [...new Set([...defaultLocalModels.image, ...(parsed.image || [])])],
        };
      }
    } catch {
      // Ignore localStorage errors
    }
  }

  return {
    messages: [],
    isRecording: false,
    isGenerating: false,
    isPlaying: false,
    isGeneratingImage: false,
    currentText: '',
    wsConnected: false,
    settings: persistedSettings,
    characterName: persistedCharacterName,
    characterImage: null,
    characterDescription: defaultCharacterDescription,
    showSettings: false,
    aiAvatar: persistedAiAvatar,
    userAvatar: persistedUserAvatar,
    localModels: persistedLocalModels,
    voiceLists: {},
    downloadProgress: {},
    suggestedModels: { llm: [], asr: [], tts: [], image: [] },
    zaiConfigured: false,
    localRuntimes: { llm: false, asr: false, tts: false, image: false },
  };
}

function persistSettings(settings: ChatSettings) {
  if (typeof window === 'undefined') return;
  try {
    // 写入版本号，便于未来迁移
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, _version: SETTINGS_VERSION }));
  } catch {}
}

function persistLocalModels(localModels: LocalModels) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('ai-zhichat-local-models', JSON.stringify(localModels));
  } catch {}
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...createInitialState(),

  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)),
    })),

  updateLastAssistant: (updates) =>
    set((state) => {
      const idx = state.messages.findLastIndex((m) => m.role === 'assistant');
      if (idx < 0) return state;
      const updated = [...state.messages];
      updated[idx] = { ...updated[idx], ...updates };
      return { messages: updated };
    }),

  appendAudioChunk: (messageId, chunk) =>
    set((state) => ({
      messages: state.messages.map((msg) => {
        if (msg.id !== messageId) return msg;
        const chunks = msg.audioChunks ? [...msg.audioChunks] : [];
        chunks.push(chunk);
        return {
          ...msg,
          audioChunks: chunks,
          audioSampleRate: chunk.sample_rate !== 0 ? chunk.sample_rate : msg.audioSampleRate,
        };
      }),
    })),

  setIsRecording: (val) => set({ isRecording: val }),
  setIsGenerating: (val) => set({ isGenerating: val }),
  setIsPlaying: (val) => set({ isPlaying: val }),
  setIsGeneratingImage: (val) => set({ isGeneratingImage: val }),
  setCurrentText: (text) => set({ currentText: text }),
  appendCurrentText: (text) => set((state) => ({ currentText: state.currentText + text })),
  clearCurrentText: () => set({ currentText: '' }),
  setWsConnected: (val) => set({ wsConnected: val }),

  updateSettings: (partial) => {
    set((state) => {
      const newSettings: ChatSettings = { ...state.settings };

      const modelKeys: ('llm' | 'asr' | 'tts' | 'image')[] = ['llm', 'asr', 'tts', 'image'];
      for (const key of modelKeys) {
        if (partial[key]) {
          newSettings[key] = mergeModelConfig(state.settings[key], partial[key]);
        }
      }

      const rest: Partial<ChatSettings> = {};
      for (const [k, v] of Object.entries(partial)) {
        if (!modelKeys.includes(k as 'llm' | 'asr' | 'tts' | 'image')) {
          (rest as Record<string, unknown>)[k] = v;
        }
      }
      Object.assign(newSettings, rest);

      persistSettings(newSettings);
      return { settings: newSettings };
    });
  },

  updateModelConfig: (model, updates) => {
    set((state) => {
      const newSettings = {
        ...state.settings,
        [model]: mergeModelConfig(state.settings[model], updates),
      };
      persistSettings(newSettings);
      return { settings: newSettings };
    });
  },

  resetSettings: () => {
    set(() => {
      const newSettings: ChatSettings = {
        ...defaultSettings,
        llm: { ...defaultLLMConfig, apiParams: { ...defaultLLMConfig.apiParams }, extraParams: { ...defaultLLMConfig.extraParams } },
        asr: { ...defaultASRConfig, apiParams: { ...defaultASRConfig.apiParams }, extraParams: { ...defaultASRConfig.extraParams } },
        tts: { ...defaultTTSConfig, apiParams: { ...defaultTTSConfig.apiParams }, extraParams: { ...defaultTTSConfig.extraParams } },
        image: { ...defaultImageConfig, apiParams: { ...defaultImageConfig.apiParams }, extraParams: { ...defaultImageConfig.extraParams } },
      };
      persistSettings(newSettings);
      return { settings: newSettings };
    });
  },

  clearChat: () =>
    set({
      messages: [],
      isRecording: false,
      isGenerating: false,
      isPlaying: false,
      isGeneratingImage: false,
      currentText: '',
    }),

  setCharacterImage: (url) => set({ characterImage: url }),
  setCharacterName: (name) => {
    set({ characterName: name });
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('ai-zhichat-character-name', name); } catch {}
    }
  },
  setShowSettings: (show) => set({ showSettings: show }),

  setAiAvatar: (url) => {
    set({ aiAvatar: url });
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('ai-zhichat-ai-avatar', url || ''); } catch {}
    }
  },
  setUserAvatar: (url) => {
    set({ userAvatar: url });
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('ai-zhichat-user-avatar', url || ''); } catch {}
    }
  },

  addLocalModel: (service, model) => {
    set((state) => {
      const current = state.localModels[service];
      if (current.includes(model)) return state;
      const newLocalModels = {
        ...state.localModels,
        [service]: [...current, model],
      };
      persistLocalModels(newLocalModels);
      return { localModels: newLocalModels };
    });
  },
  removeLocalModel: (service, model) => {
    set((state) => {
      const newLocalModels = {
        ...state.localModels,
        [service]: state.localModels[service].filter((m) => m !== model),
      };
      persistLocalModels(newLocalModels);
      return { localModels: newLocalModels };
    });
  },

  setVoiceList: (provider, data) =>
    set((state) => ({
      voiceLists: { ...state.voiceLists, [provider]: data },
    })),

  setDownloadProgress: (key, data) =>
    set((state) => ({
      downloadProgress: { ...state.downloadProgress, [key]: data },
    })),
  clearDownloadProgress: (key) =>
    set((state) => {
      const next = { ...state.downloadProgress };
      delete next[key];
      return { downloadProgress: next };
    }),

  setSuggestedModels: (data) => set({ suggestedModels: data }),
  setLocalModels: (data) => {
    set({ localModels: data });
    persistLocalModels(data);
  },
  setZaiConfigured: (val) => set({ zaiConfigured: val }),
  setLocalRuntimes: (data) => set({ localRuntimes: data }),
}));
