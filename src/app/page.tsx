'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useChatStore, type ChatMessage, type ModelConfig, type LocalModels } from '@/lib/chat-store';
import { wsClient } from '@/lib/ws-client';
import { AudioChunkPlayer } from '@/lib/audio-player';
import { fetchHealth, fetchVoices, fetchLocalModels, fetchConfigDefaults } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Send,
  Mic,
  MicOff,
  Settings,
  Trash2,
  Image as ImageIcon,
  StopCircle,
  Wifi,
  WifiOff,
  Sparkles,
  Brain,
  Volume2,
  Eye,
  MicVocal,
  Cloud,
  Server,
  RotateCcw,
  Upload,
  Download,
  Plus,
  X,
  User,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

// ─── Action tag helpers ─────────────────────────────────────────────────────────
// Use non-global regex to avoid stateful lastIndex issues across calls

function stripActions(text: string): string {
  return text.replace(/<action>(.*?)<\/action>/gs, '').trim();
}

function extractActions(text: string): string[] {
  const actions: string[] = [];
  const re = /<action>(.*?)<\/action>/gs;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]?.trim()) actions.push(m[1].trim());
  }
  return actions;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_ICONS = {
  llm: Brain,
  asr: MicVocal,
  tts: Volume2,
  image: Eye,
} as const;

const SERVICE_LABELS = {
  llm: 'LLM 语言模型',
  asr: 'ASR 语音识别',
  tts: 'TTS 语音合成',
  image: 'Image 图像生成',
} as const;

// ZAI SDK voice presets
const ZAI_VOICE_PRESETS = [
  { value: 'tongtong', label: '童童 - 温暖亲切' },
  { value: 'chuichui', label: '吹吹 - 活泼可爱' },
  { value: 'xiaochen', label: '小晨 - 沉稳专业' },
  { value: 'jam', label: 'Jam - 英音绅士' },
  { value: 'kazi', label: 'Kazi - 清晰标准' },
  { value: 'douji', label: '豆吉 - 自然流畅' },
  { value: 'luodo', label: '罗多 - 富有感染力' },
];

// Edge TTS voice presets
const EDGE_VOICE_PRESETS = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 - 温暖女声（默认）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓依 - 活泼女声' },
  { value: 'zh-CN-YunjianNeural', label: '云健 - 沉稳男声' },
  { value: 'zh-CN-YunxiNeural', label: '云希 - 阳光男声' },
  { value: 'zh-CN-YunxiaNeural', label: '云夏 - 少年男声' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 - 新闻男声' },
  { value: 'zh-CN-XiaochenNeural', label: '小辰 - 柔和女声' },
  { value: 'zh-CN-XiaohanNeural', label: '晓涵 - 甜美女声' },
  { value: 'zh-CN-XiaomengNeural', label: '晓梦 - 童声女声' },
  { value: 'zh-CN-XiaomoNeural', label: '晓墨 - 知性女声' },
  { value: 'zh-CN-XiaoruiNeural', label: '晓睿 - 长者女声' },
  { value: 'zh-CN-XiaoshuangNeural', label: '晓双 - 童声女声' },
  { value: 'zh-CN-XiaoxuanNeural', label: '晓萱 - 温柔女声' },
  { value: 'zh-CN-XiaoyanNeural', label: '晓颜 - 亲切女声' },
  { value: 'zh-CN-XiaozhenNeural', label: '晓甄 - 优雅女声' },
  { value: 'en-US-JennyNeural', label: 'Jenny - 英语女声' },
  { value: 'en-US-GuyNeural', label: 'Guy - 英语男声' },
  { value: 'ja-JP-NanamiNeural', label: 'Nanami - 日语女声' },
  { value: 'ko-KR-SunHiNeural', label: 'SunHi - 韩语女声' },
];

const TTS_API_PROVIDERS = [
  { value: 'edge', label: 'Edge TTS（免费，推荐）' },
  { value: 'zai', label: 'ZAI 云端 TTS' },
  { value: 'custom', label: '自定义 API' },
] as const;

// ─── File upload helper ──────────────────────────────────────────────────────

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return readFileAsDataURL(file).then((dataUrl) => dataUrl.split(',')[1]);
}

// 选择浏览器支持的录音 MIME 类型，避免 Safari 等浏览器不支持 webm 导致录音失败
function getSupportedRecordingMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {}
  }
  return '';
}

/**
 * 将录音 Blob（webm/mp4/ogg 等）转换为 16kHz 单声道 16-bit PCM WAV。
 * ASR 服务对 WAV 兼容性最好；浏览器 MediaRecorder 默认输出的 webm 在部分
 * ASR 后端不被支持，这里统一转码以保证语音识别可用。
 */
async function audioBlobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  // 解码浏览器原生格式（webm/opus、mp4/aac 等）
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const tmpCtx = new AudioCtx();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
  } finally {
    tmpCtx.close();
  }

  // 重采样到 16kHz 单声道（ASR 推荐采样率）
  const TARGET_SR = 16000;
  const channels = 1;
  const offlineCtx = new OfflineAudioContext(channels, Math.ceil(audioBuffer.duration * TARGET_SR), TARGET_SR);
  const src = offlineCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();

  // Float32 → Int16 PCM
  const floatData = rendered.getChannelData(0);
  const numSamples = floatData.length;
  const dataLen = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  // WAV header
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, TARGET_SR, true);
  view.setUint32(28, TARGET_SR * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  // ArrayBuffer → base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const store = useChatStore();
  const playerRef = useRef<AudioChunkPlayer | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [inputText, setInputText] = useState('');
  // 用 ref 跟踪音频初始化状态，避免 useEffect([]) 闭包中 state 过期导致每次 chunk 都重新 init
  const audioInitSampleRateRef = useRef(0);
  const mp3AudioRef = useRef<HTMLAudioElement | null>(null);
  const mp3QueueRef = useRef<string[]>([]);
  const mp3PlayingRef = useRef(false);
  const mp3StreamEndedRef = useRef(false);
  const isStoppingRecRef = useRef(false);
  // 跟踪当前流式 assistant 消息 id，用于将音频分块关联到消息（支持重播）
  const currentAssistantIdRef = useRef<string | null>(null);
  // Token to prevent stale replay callbacks from overwriting playerRef
  const replayTokenRef = useRef(0);
  // Dedicated ref for replay player (avoids overwriting main playerRef)
  const replayPlayerRef = useRef<AudioChunkPlayer | null>(null);
  // 跟踪正在重新生成图片的消息 id（用 state 以触发 UI 更新）
  const [regeneratingImageId, setRegeneratingImageId] = useState<string | null>(null);

  // Initialize audio player
  useEffect(() => {
    playerRef.current = new AudioChunkPlayer();
    return () => {
      playerRef.current?.close();
    };
  }, []);

  // ─── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (text: string) => {
      const currentState = useChatStore.getState();
      if (!text.trim() || currentState.isGenerating) return;

      // 停止当前所有音频播放（PCM + MP3），避免新旧音频叠加
      playerRef.current?.interrupt();
      if (mp3AudioRef.current) {
        mp3AudioRef.current.pause();
        mp3AudioRef.current = null;
      }
      mp3QueueRef.current = [];
      mp3PlayingRef.current = false;
      mp3StreamEndedRef.current = false;
      audioInitSampleRateRef.current = 0;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      };
      // Build context messages BEFORE adding current user message to history
      // (backend receives `text` separately from `messages` history)
      const contextMessages = useChatStore.getState().messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => m.content && m.content.trim() !== '')  // exclude empty messages
        .slice(-20)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      // Add user message to history AFTER building context
      currentState.addMessage(userMsg);

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      };
      useChatStore.getState().addMessage(assistantMsg);
      currentAssistantIdRef.current = assistantMsg.id;

      useChatStore.getState().setIsGenerating(true);
      useChatStore.getState().clearCurrentText();

      // Send via WebSocket with full settings
      const st = useChatStore.getState().settings;
      const ok = wsClient.send('chat', {
        text: text.trim(),
        messages: contextMessages,
        settings: {
          llm: st.llm,
          asr: st.asr,
          tts: st.tts,
          image: st.image,
          ttsApiProvider: st.ttsApiProvider,
          ttsVoice: st.ttsVoice,
          ttsSpeed: st.ttsSpeed,
          ttsVolume: st.ttsVolume,
          voiceMode: st.voiceMode,
          cloneRefAudio: st.cloneRefAudio,
          voiceDesignPrompt: st.voiceDesignPrompt,
          imageSize: st.imageSize,
          imageUseReference: st.imageUseReference,
          imageReferenceImage: st.imageReferenceImage,
        },
      });

      if (!ok) {
        toast.error('未连接到服务，请刷新页面重试');
        useChatStore.getState().setIsGenerating(false);
        return;
      }

      setInputText('');
    },
    []
  );

  const sendMessageRef = useRef(sendMessage);
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  // MP3 句子队列顺序播放（Edge TTS 每句一个完整 MP3）
  const playMp3Queue = useCallback(() => {
    if (mp3PlayingRef.current) return;
    const next = mp3QueueRef.current.shift();
    if (!next) {
      // 队列已空，若流已结束则关闭播放状态
      if (mp3StreamEndedRef.current) {
        mp3StreamEndedRef.current = false;
        useChatStore.getState().setIsPlaying(false);
      }
      return;
    }
    mp3PlayingRef.current = true;
    const audio = new Audio(`data:audio/mp3;base64,${next}`);
    mp3AudioRef.current = audio;
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      mp3PlayingRef.current = false;
      mp3AudioRef.current = null;
      playMp3Queue();
    };
    audio.onended = advance;
    audio.onerror = advance;
    audio.play().catch(advance);
  }, []);

  // Connect to WebSocket
  useEffect(() => {
    wsClient.connect();

    const unsubStatus = wsClient.onStatus((connected) => {
      useChatStore.getState().setWsConnected(connected);
    });

    const unsubs = [
      wsClient.on('llm_chunk', (msg) => {
        const token = msg.data as string;
        useChatStore.getState().appendCurrentText(token);
        const currentText = useChatStore.getState().currentText;
        useChatStore.getState().updateLastAssistant({
          content: currentText,
          isStreaming: true,
        });
      }),

      wsClient.on('llm_end', (msg) => {
        const data = msg.data as { text: string; actions: string[] };
        const currentState = useChatStore.getState();
        const displayText = stripActions(data?.text || currentState.currentText);
        const actions = data?.actions || extractActions(currentState.currentText);
        useChatStore.getState().updateLastAssistant({
          content: displayText,
          isStreaming: false,
          actionText: actions.length > 0 ? actions[0] : undefined,
        });
        useChatStore.getState().clearCurrentText();
        useChatStore.getState().setIsGenerating(false);
        // Reset assistant ID ref to prevent stale audio chunks from attaching to wrong message
        currentAssistantIdRef.current = null;
      }),

      wsClient.on('audio_chunk', (msg) => {
        // 后端发送的 payload 形如 { data: base64, seq, sample_rate }
        const payload = msg.data as { data: string; seq: number; sample_rate: number } | undefined;
        const base64 = payload?.data ?? '';
        const seq = payload?.seq ?? msg.seq ?? 0;
        const sr = payload?.sample_rate ?? msg.sample_rate ?? 0;

        // 存储音频分块到对应消息（用于重播）
        const aid = currentAssistantIdRef.current;
        if (aid && base64) {
          useChatStore.getState().appendAudioChunk(aid, { data: base64, seq, sample_rate: sr });
        }

        if (sr === -1) {
          // MP3 格式（Edge TTS）：整句完整 MP3，入队顺序播放
          mp3QueueRef.current.push(base64);
          if (!useChatStore.getState().isPlaying) {
            useChatStore.getState().setIsPlaying(true);
          }
          playMp3Queue();
        } else {
          // PCM 格式（ZAI TTS）：使用 AudioChunkPlayer
          if (sr > 0 && audioInitSampleRateRef.current === 0) {
            playerRef.current?.init(sr);
            // 注册播放结束回调：所有 PCM 缓冲播完后关闭"播报中"状态
            if (playerRef.current) {
              playerRef.current.onPlaybackEnd = () => {
                useChatStore.getState().setIsPlaying(false);
                audioInitSampleRateRef.current = 0;
              };
            }
            audioInitSampleRateRef.current = sr;
            useChatStore.getState().setIsPlaying(true);
          }
          if (base64) {
            playerRef.current?.addChunk(base64, seq, sr);
          }
        }
      }),

      wsClient.on('audio_end', () => {
        // 标记音频流已结束
        mp3StreamEndedRef.current = true;
        if (audioInitSampleRateRef.current > 0) {
          // PCM 模式：刷出剩余聚合缓冲（按句子），不提前关 isPlaying
          // 等 AudioChunkPlayer.onPlaybackEnd 回调触发
          playerRef.current?.flush();
        } else {
          // MP3 模式：若队列空且无正在播放，立即关闭；否则等队列播完
          if (!mp3PlayingRef.current && mp3QueueRef.current.length === 0) {
            useChatStore.getState().setIsPlaying(false);
            mp3StreamEndedRef.current = false;
          }
        }
      }),

      wsClient.on('image_start', (msg) => {
        // 重新生成图片时 payload 携带 { messageId }；普通流式为空字符串
        const payload = msg.data;
        const messageId = (payload && typeof payload === 'object') ? (payload as any).messageId : null;
        if (messageId) {
          setRegeneratingImageId(messageId);
          // 清除旧图片，显示加载动画
          useChatStore.getState().updateMessage(messageId, { imageUrl: undefined });
        }
        useChatStore.getState().setIsGeneratingImage(true);
      }),

      wsClient.on('image_done', (msg) => {
        const st = useChatStore.getState();
        // 兼容两种格式：字符串 url（流式生成）或 { url, messageId }（重新生成）
        const data = msg.data;
        if (data && typeof data === 'object' && typeof (data as any).url === 'string') {
          const { url, messageId } = data as { url: string; messageId?: string };
          if (messageId) {
            st.updateMessage(messageId, { imageUrl: url });
            setRegeneratingImageId(null);
          } else {
            st.setCharacterImage(url);
            st.updateLastAssistant({ imageUrl: url });
          }
        } else {
          const url = data as string;
          st.setCharacterImage(url);
          st.updateLastAssistant({ imageUrl: url });
        }
        st.setIsGeneratingImage(false);
      }),

      wsClient.on('asr_result', (msg) => {
        const text = (msg.data as string) ?? '';
        useChatStore.getState().setIsRecording(false);
        if (text.trim()) {
          toast.success('语音识别完成');
          sendMessageRef.current(text.trim());
        } else {
          toast.error('未识别到语音内容，请重试');
        }
      }),

      wsClient.on('model_status', (msg) => {
        const { service, status } = msg.data || {};
        if (service && status) {
          console.log(`[Model] ${service}: ${status}`);
        }
      }),

      wsClient.on('error', (msg) => {
        // Backend may send error as a plain string (handler.py) — coerce safely
        const errMsg = typeof msg.data === 'string'
          ? msg.data
          : (msg.data?.message || (msg.data ? JSON.stringify(msg.data) : '发生错误'));
        toast.error(errMsg);
        const st = useChatStore.getState();
        st.setIsGenerating(false);
        st.setIsGeneratingImage(false);
        st.setIsRecording(false);
        // Also clear isPlaying — a TTS/ASR error mid-playback would otherwise
        // leave the UI stuck in "语音播报中".
        st.setIsPlaying(false);
        playerRef.current?.interrupt();
        audioInitSampleRateRef.current = 0;
        if (mp3AudioRef.current) {
          mp3AudioRef.current.pause();
          mp3AudioRef.current = null;
        }
        mp3QueueRef.current = [];
        mp3PlayingRef.current = false;
        mp3StreamEndedRef.current = false;
      }),

      wsClient.on('warmup_done', () => {
        toast.success('AI 服务已就绪');
      }),

      wsClient.on('model_downloaded', (msg) => {
        const data = msg.data as { service: string; modelName: string };
        if (data?.service && data?.modelName) {
          useChatStore.getState().addLocalModel(data.service as keyof LocalModels, data.modelName);
          const key = `${data.service}:${data.modelName}`;
          useChatStore.getState().clearDownloadProgress(key);
          toast.success(`模型 ${data.modelName} 已下载`);
        }
      }),

      wsClient.on('download_progress', (msg) => {
        const data = msg.data as { service: string; modelName: string; elapsed?: number };
        if (data?.service && data?.modelName) {
          const key = `${data.service}:${data.modelName}`;
          useChatStore.getState().setDownloadProgress(key, {
            service: data.service,
            modelName: data.modelName,
            elapsed: data.elapsed,
            status: 'downloading',
          });
        }
      }),
    ];

    return () => {
      unsubStatus();
      unsubs.forEach((u) => u());
      wsClient.disconnect();
    };
  }, []);

  // ─── Load backend metadata on mount ───────────────────────────────────────
  // Fetches health, local model list, TTS voice lists, and config defaults
  // from the Python backend. Falls back gracefully to local defaults if the
  // backend is unreachable.
  useEffect(() => {
    let cancelled = false;

    async function loadBackendMetadata() {
      // Health
      const health = await fetchHealth();
      if (cancelled || !health) return;
      useChatStore.getState().setZaiConfigured(health.zai_configured);
      useChatStore.getState().setLocalRuntimes(health.local_runtimes);

      // Local models + suggested
      const models = await fetchLocalModels();
      if (cancelled || !models) return;
      useChatStore.getState().setLocalModels({
        llm: [...new Set([...useChatStore.getState().localModels.llm, ...models.llm])],
        asr: [...new Set([...useChatStore.getState().localModels.asr, ...models.asr])],
        tts: [...new Set([...useChatStore.getState().localModels.tts, ...models.tts])],
        image: [...new Set([...useChatStore.getState().localModels.image, ...models.image])],
      });
      useChatStore.getState().setSuggestedModels(models.suggested);

      // Config defaults (verifies text-box defaults match the backend)
      const defaults = await fetchConfigDefaults();
      if (cancelled || !defaults) return;
      // Only apply if user hasn't customized (no persisted settings yet)
      // — we leave existing user settings untouched.
    }

    async function loadVoicesForProvider(provider: string, mode: string = 'api') {
      const data = await fetchVoices(provider, mode);
      if (cancelled || !data) return;
      // For API mode, key by provider name; for local mode, key by 'local'
      const key = mode === 'local' ? 'local' : provider;
      useChatStore.getState().setVoiceList(key, {
        defaultVoice: data.defaultVoice,
        voices: data.voices,
        modes: data.modes,
      });
    }

    loadBackendMetadata();
    // Pre-load voice lists for all providers (API mode) + local mode
    loadVoicesForProvider('zai', 'api');
    loadVoicesForProvider('edge', 'api');
    loadVoicesForProvider('custom', 'api');
    loadVoicesForProvider('local', 'local');  // local mode uses 'local' as provider key

    return () => { cancelled = true; };
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [store.messages]);

  // ─── Voice recording ──────────────────────────────────────────────────────
  const toggleRecording = useCallback(async () => {
    if (useChatStore.getState().isRecording) {
      if (isStoppingRecRef.current) return;
      isStoppingRecRef.current = true;
      try { mediaRecorderRef.current?.stop(); } catch { isStoppingRecRef.current = false; }
      useChatStore.getState().setIsRecording(false);
      // 安全兜底：3 秒后强制释放停止状态，避免 onstop 未触发导致无法再次录音
      setTimeout(() => { isStoppingRecRef.current = false; }, 3000);
      return;
    }
    // 正在停止中时禁止立即开始新录音，避免 onstop 异步竞态
    if (isStoppingRecRef.current) return;

    // 检查浏览器能力
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error('当前浏览器不支持语音录制，请使用文本输入');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toast.error('当前浏览器不支持录音功能');
      return;
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedRecordingMimeType();
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        // MediaRecorder 创建失败，释放 stream 避免麦克风指示灯常亮
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream?.getTracks().forEach((t) => t.stop());
        isStoppingRecRef.current = false;
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        if (chunks.length === 0) {
          toast.error('未录制到音频内容');
          return;
        }
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        // 录音过短可能是误触
        if (blob.size < 1000) {
          toast.error('录音时间过短，请长按说话');
          return;
        }
        // 标记 ASR 处理中
        useChatStore.getState().setIsRecording(true);
        toast.info('正在识别语音...');
        try {
          // 统一转码为 16kHz 单声道 WAV，保证 ASR 后端兼容
          const wavBase64 = await audioBlobToWavBase64(blob);
          const ok = wsClient.send('asr', {
            audio: wavBase64,
            format: 'wav',
            settings: {
              asr: useChatStore.getState().settings.asr,
            },
          });
          if (!ok) {
            toast.error('未连接到服务，无法识别语音');
            useChatStore.getState().setIsRecording(false);
          }
        } catch (err) {
          console.error('[ASR] WAV 转码失败:', err);
          toast.error('音频处理失败，请重试');
          useChatStore.getState().setIsRecording(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      useChatStore.getState().setIsRecording(true);
    } catch (err: any) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      isStoppingRecRef.current = false;
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        toast.error('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        toast.error('未检测到麦克风设备');
      } else if (name === 'NotReadableError') {
        toast.error('麦克风被其他程序占用，请关闭后重试');
      } else {
        toast.error('无法访问麦克风：' + (err?.message || '未知错误'));
      }
    }
  }, []);

  // ─── Replay audio (重播指定消息的语音) ──────────────────────────────────────
  const handleReplayAudio = useCallback((messageId: string) => {
    const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
    if (!msg || !msg.audioChunks || msg.audioChunks.length === 0) {
      toast.error('该消息没有可重播的语音');
      return;
    }
    // 停止当前所有播放
    playerRef.current?.interrupt();
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current = null;
    }
    mp3QueueRef.current = [];
    mp3PlayingRef.current = false;
    mp3StreamEndedRef.current = false;
    audioInitSampleRateRef.current = 0;

    useChatStore.getState().setIsPlaying(true);
    const chunks = msg.audioChunks;
    // 判断是否为 MP3 格式（第一个 chunk sample_rate === -1）
    const isMp3 = chunks.some((c) => c.sample_rate === -1);

    if (isMp3) {
      // MP3 模式：按顺序入队播放
      mp3PlayingRef.current = false; // reset any stale playback state
      for (const c of chunks) {
        if (c.sample_rate === -1) mp3QueueRef.current.push(c.data);
      }
      mp3StreamEndedRef.current = true;
      playMp3Queue();
    } else {
      // PCM 模式：用独立播放器重播（不覆盖 playerRef，避免破坏主流播放器）
      const sr = msg.audioSampleRate || chunks.find((c) => c.sample_rate > 0)?.sample_rate || 24000;
      const replayPlayer = new AudioChunkPlayer();
      const replayToken = ++replayTokenRef.current;
      replayPlayer.init(sr);
      // Only restore playerRef if no new playback has started since
      const mainPlayer = playerRef.current;
      replayPlayer.onPlaybackEnd = () => {
        useChatStore.getState().setIsPlaying(false);
        // Only restore if replay token matches (no newer replay started)
        if (replayTokenRef.current === replayToken) {
          playerRef.current = mainPlayer;
        }
        setTimeout(() => replayPlayer.close(), 500);
      };
      for (const c of chunks) {
        if (c.data) replayPlayer.addChunk(c.data, c.seq, c.sample_rate || sr);
      }
      replayPlayer.flush();
      // Store replay player separately so interrupt can stop it
      replayPlayerRef.current = replayPlayer;
      audioInitSampleRateRef.current = sr;
    }
  }, [playMp3Queue]);

  // ─── Regenerate image (重新生成指定消息的立绘) ─────────────────────────────
  const handleRegenerateImage = useCallback((messageId: string, actionText: string) => {
    if (!actionText?.trim()) {
      toast.error('该消息没有动作描述，无法重新生成立绘');
      return;
    }
    const st = useChatStore.getState();
    if (st.isGeneratingImage) {
      toast.error('正在生成图片，请稍候');
      return;
    }
    const settings = st.settings;
    wsClient.send('regenerate_image', {
      messageId,
      actionText,
      settings: {
        image: settings.image,
        imageSize: settings.imageSize,
        imageUseReference: settings.imageUseReference,
        imageReferenceImage: settings.imageReferenceImage,
      },
    });
    toast.info('正在重新生成立绘...');
  }, []);

  // ─── Interrupt ─────────────────────────────────────────────────────────────
  const handleInterrupt = useCallback(() => {
    wsClient.send('interrupt');
    playerRef.current?.interrupt();
    replayPlayerRef.current?.interrupt();
    replayPlayerRef.current = null;
    audioInitSampleRateRef.current = 0;
    // 停止 MP3 播放并清空队列
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current = null;
    }
    mp3QueueRef.current = [];
    mp3PlayingRef.current = false;
    mp3StreamEndedRef.current = false;
    const st = useChatStore.getState();
    st.setIsGenerating(false);
    st.setIsPlaying(false);
    st.setIsRecording(false);
    st.updateLastAssistant({ isStreaming: false });
  }, []);

  // ─── Clear chat (同时停止音频) ──────────────────────────────────────────────
  const handleClearChat = useCallback(() => {
    playerRef.current?.interrupt();
    replayPlayerRef.current?.interrupt();
    replayPlayerRef.current = null;
    audioInitSampleRateRef.current = 0;
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current = null;
    }
    mp3QueueRef.current = [];
    mp3PlayingRef.current = false;
    mp3StreamEndedRef.current = false;
    wsClient.send('interrupt');
    useChatStore.getState().clearChat();
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0b]">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#0a0a0b]/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-zinc-100">AI智聊</h1>
            <p className="text-xs text-zinc-500">多模态实时对话系统</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Active services */}
          <div className="hidden sm:flex items-center gap-1">
            {(['llm', 'tts', 'asr', 'image'] as const).map((svc) => {
              const Icon = SERVICE_ICONS[svc];
              const enabled = store.settings[svc].enabled;
              return (
                <TooltipProvider key={svc}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className={cn(
                        'w-6 h-6 rounded-md flex items-center justify-center transition-colors',
                        enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-800 text-zinc-600'
                      )}>
                        <Icon className="w-3 h-3" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{SERVICE_LABELS[svc]} {enabled ? '已启用' : '已禁用'}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className={cn(
                  'text-xs gap-1.5 px-2 py-0.5 cursor-default',
                  store.wsConnected
                    ? 'border-emerald-500/30 text-emerald-400'
                    : 'border-red-500/30 text-red-400'
                )}>
                  {store.wsConnected ? (
                    <><Wifi className="w-3 h-3" /> 已连接</>
                  ) : (
                    <><WifiOff className="w-3 h-3" /> 未连接</>
                  )}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p>{store.wsConnected ? '已连接到 AI Pipeline 服务' : '未连接到服务，请检查后端'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Button
            variant="ghost"
            size="icon"
            className="text-zinc-400 hover:text-zinc-100"
            onClick={handleClearChat}
            title="清空对话"
          >
            <Trash2 className="w-4 h-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="text-zinc-400 hover:text-zinc-100"
            onClick={() => store.setShowSettings(true)}
            title="设置"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto chat-scrollbar px-4 py-4 space-y-4">
            {store.messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-4 opacity-60">
                <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-emerald-500/40" />
                </div>
                <div>
                  <h2 className="text-lg font-medium text-zinc-300">AI智聊</h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    支持文字聊天、语音对话和立绘生成
                  </p>
                  <p className="text-xs text-zinc-600 mt-2">
                    输入文字或点击麦克风开始语音对话
                  </p>
                </div>
              </div>
            )}

            {store.messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                onReplayAudio={handleReplayAudio}
                onRegenerateImage={handleRegenerateImage}
                isRegenerating={regeneratingImageId === msg.id && store.isGeneratingImage}
              />
            ))}

            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-white/10 bg-[#0a0a0b]/90 backdrop-blur-sm px-4 py-3">
            <div className="flex items-end gap-2 max-w-3xl mx-auto">
              {/* Voice button */}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'shrink-0 relative rounded-full transition-all',
                  store.isRecording
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300 recording-pulse'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                )}
                onClick={toggleRecording}
                title={store.isRecording ? '停止录音' : '语音输入'}
              >
                {store.isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </Button>

              {/* Text input */}
              <div className="flex-1 relative">
                <Textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage(inputText);
                    }
                  }}
                  placeholder={
                    store.isRecording
                      ? '正在录音...点击麦克风停止'
                      : '输入消息，Enter 发送，Shift+Enter 换行'
                  }
                  className="min-h-[40px] max-h-[120px] resize-none rounded-xl bg-white/[0.04] border-white/10 text-zinc-200 placeholder:text-zinc-500 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20 pr-12"
                  rows={1}
                  disabled={store.isRecording}
                />
              </div>

              {/* Send / Interrupt button */}
              {store.isGenerating || store.isPlaying ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 rounded-full text-red-400 hover:bg-red-500/20 hover:text-red-300"
                  onClick={handleInterrupt}
                  title="停止生成"
                >
                  <StopCircle className="w-5 h-5" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'shrink-0 rounded-full transition-all',
                    inputText.trim()
                      ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 hover:text-emerald-300'
                      : 'text-zinc-500 hover:text-zinc-400'
                  )}
                  onClick={() => sendMessage(inputText)}
                  disabled={!inputText.trim()}
                  title="发送"
                >
                  <Send className="w-5 h-5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings dialog */}
      <SettingsDialog />
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────────────────────

function MessageBubble({
  message,
  onReplayAudio,
  onRegenerateImage,
  isRegenerating,
}: {
  message: ChatMessage;
  onReplayAudio?: (messageId: string) => void;
  onRegenerateImage?: (messageId: string, actionText: string) => void;
  isRegenerating?: boolean;
}) {
  const store = useChatStore();
  const isUser = message.role === 'user';
  const displayText = isUser ? message.content : stripActions(message.content);
  // 判断是否为最后一条 assistant 消息（用于显示内联加载动画）
  const isLastAssistant = !isUser && store.messages[store.messages.length - 1]?.id === message.id;
  const hasAudio = !isUser && !!message.audioChunks && message.audioChunks.length > 0;
  const canRegenerateImage = !isUser && !!message.actionText && !message.isStreaming;

  const avatarSrc = isUser ? store.userAvatar : store.aiAvatar;
  const avatarFallback = isUser ? '你' : '智';

  return (
    <div
      className={cn(
        'flex gap-3',
        isUser ? 'flex-row-reverse' : 'flex-row'
      )}
    >
      {/* Avatar */}
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt={isUser ? '用户头像' : 'AI头像'}
          className="w-8 h-8 rounded-full object-cover shrink-0"
        />
      ) : (
        <div
          className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-medium',
            isUser
              ? 'bg-zinc-700 text-zinc-300'
              : 'bg-emerald-500/20 text-emerald-400'
          )}
        >
          {avatarFallback}
        </div>
      )}

      {/* Content */}
      <div
        className={cn(
          'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-emerald-500/15 text-zinc-100 rounded-tr-sm'
            : 'bg-white/[0.04] text-zinc-200 rounded-tl-sm border border-white/5'
        )}
      >
        {displayText || (
          <span className="inline-flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:300ms]" />
          </span>
        )}
        {message.isStreaming && displayText && (
          <span className="typing-cursor" />
        )}
        {message.actionText && (
          <div className="mt-2 text-xs text-emerald-400/70 italic">
            🎬 {message.actionText}
          </div>
        )}
        {/* 内联立绘生成加载动画（流式生成 或 重新生成）*/}
        {((isLastAssistant && store.isGeneratingImage && !message.imageUrl) || (isRegenerating)) && (
          <div className="mt-2 flex items-center gap-2 text-xs text-purple-400/80">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:300ms]" />
            </div>
            {isRegenerating ? '正在重新生成立绘...' : '正在生成角色立绘...'}
          </div>
        )}
        {/* 内联图片展示 */}
        {message.imageUrl && (
          <div className="mt-2 relative group">
            <img
              src={message.imageUrl}
              alt="character illustration"
              className="max-w-full rounded-lg border border-white/10"
              style={{ maxHeight: '320px' }}
            />
          </div>
        )}
        {/* 内联语音播放波形 */}
        {isLastAssistant && store.isPlaying && displayText && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex items-end gap-0.5 h-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 bg-emerald-400/70 rounded-full waveform-bar"
                  style={{ animationDelay: `${i * 0.1}s`, height: '4px' }}
                />
              ))}
            </div>
            <span className="text-[10px] text-emerald-400/60">语音播报中</span>
          </div>
        )}
        {/* 操作按钮：重播语音 / 重新生成立绘 */}
        {!isUser && !message.isStreaming && (hasAudio || canRegenerateImage) && (
          <div className="mt-2 flex items-center gap-1 -mb-1">
            {hasAudio && onReplayAudio && (
              <button
                onClick={() => onReplayAudio(message.id)}
                disabled={store.isPlaying}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/[0.04] hover:bg-emerald-500/10 text-zinc-400 hover:text-emerald-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="重播语音"
              >
                <Volume2 className="w-3 h-3" />
                重播
              </button>
            )}
            {canRegenerateImage && onRegenerateImage && (
              <button
                onClick={() => onRegenerateImage(message.id, message.actionText!)}
                disabled={store.isGeneratingImage}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-white/[0.04] hover:bg-purple-500/10 text-zinc-400 hover:text-purple-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="重新生成立绘"
              >
                <RefreshCw className={cn('w-3 h-3', isRegenerating && 'animate-spin')} />
                {message.imageUrl ? '重新生成' : '生成立绘'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Character Panel (removed in v3 — images now show inline in chat) ────────
// CharacterPanel component removed; status indicators moved into MessageBubble.

// ─── Model Config Section ─────────────────────────────────────────────────────

function ModelConfigSection({
  service,
  config,
  onUpdate,
  ttsApiProvider,
  onTtsApiProviderChange,
}: {
  service: 'llm' | 'asr' | 'tts' | 'image';
  config: ModelConfig;
  onUpdate: (updates: Partial<ModelConfig>) => void;
  // TTS-only: current online provider (edge | zai | custom)
  ttsApiProvider?: 'edge' | 'zai' | 'custom';
  onTtsApiProviderChange?: (provider: 'edge' | 'zai' | 'custom') => void;
}) {
  const store = useChatStore();
  const Icon = SERVICE_ICONS[service];
  const label = SERVICE_LABELS[service];
  const localModels = store.localModels[service];
  const suggested = store.suggestedModels[service] || [];
  const [showDownloadUrl, setShowDownloadUrl] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState('');

  // Active downloads for this service
  const activeDownloads = Object.entries(store.downloadProgress).filter(
    ([, info]) => info.service === service
  );

  const handleDownload = (modelNameOverride?: string) => {
    const raw = (modelNameOverride ?? downloadUrl).trim();
    if (!raw) return;
    // Normalize: accept full URL or org/name
    let modelName = raw;
    if (modelName.startsWith('https://huggingface.co/')) {
      modelName = modelName.slice('https://huggingface.co/'.length).replace(/\/tree\/.*$/, '').replace(/\/blob\/.*$/, '').replace(/\/$/, '');
    }
    wsClient.send('download_model', { url: raw.startsWith('http') ? raw : '', service, modelName });
    store.setDownloadProgress(`${service}:${modelName}`, {
      service, modelName, status: 'downloading',
    });
    onUpdate({ modelPath: modelName });
    setDownloadUrl('');
    setShowDownloadUrl(false);
    toast.info(`开始从 HuggingFace 下载 ${modelName}...`);
  };

  // For TTS service in API mode: only show API URL/Key/ModelName when provider === 'custom'.
  // ZAI and Edge providers use backend-managed credentials, so those fields are hidden.
  const isTts = service === 'tts';
  const showApiFields = !isTts || ttsApiProvider === 'custom';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-medium text-zinc-200">{label}</span>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs">服务模式</Label>
        <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-0.5">
          <button
            className={cn(
              'px-3 py-1 text-xs rounded-md transition-all',
              config.mode === 'api'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'text-zinc-500 hover:text-zinc-300'
            )}
            onClick={() => onUpdate({ mode: 'api' })}
          >
            <Cloud className="w-3 h-3 inline mr-1" />
            在线 API
          </button>
          <button
            className={cn(
              'px-3 py-1 text-xs rounded-md transition-all',
              config.mode === 'local'
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'text-zinc-500 hover:text-zinc-300'
            )}
            onClick={() => onUpdate({ mode: 'local' })}
          >
            <Server className="w-3 h-3 inline mr-1" />
            本地模型
          </button>
        </div>
      </div>

      {/* Enabled toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs">启用服务</Label>
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => onUpdate({ enabled: v })}
        />
      </div>

      {config.mode === 'api' ? (
        <>
          {/* TTS: online provider selector (only in API mode) */}
          {isTts && ttsApiProvider && onTtsApiProviderChange && (
            <div className="space-y-1.5">
              <Label className="text-xs">TTS 在线服务</Label>
              <Select
                value={ttsApiProvider}
                onValueChange={(v) => onTtsApiProviderChange(v as 'edge' | 'zai' | 'custom')}
              >
                <SelectTrigger className="text-xs h-8 bg-white/[0.04] border-white/10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTS_API_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {ttsApiProvider !== 'custom' && (
                <p className="text-[10px] text-zinc-600">
                  {ttsApiProvider === 'zai'
                    ? '使用 ZAI 云端 TTS，凭据由后端管理（无需填写 API 地址 / Key / 模型名）'
                    : '使用微软免费 Edge TTS，无需 API Key'}
                </p>
              )}
            </div>
          )}

          {/* API URL — only show for non-TTS services OR TTS with custom provider */}
          {showApiFields && (
            <div className="space-y-1.5">
              <Label className="text-xs">API 地址</Label>
              <Input
                value={config.apiUrl}
                onChange={(e) => onUpdate({ apiUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className="text-xs h-8 bg-white/[0.04] border-white/10"
              />
            </div>
          )}

          {/* API Key — only show for non-TTS services OR TTS with custom provider */}
          {showApiFields && (
            <div className="space-y-1.5">
              <Label className="text-xs">API Key</Label>
              <Input
                value={config.apiKey}
                onChange={(e) => onUpdate({ apiKey: e.target.value })}
                placeholder="sk-..."
                type="password"
                className="text-xs h-8 bg-white/[0.04] border-white/10"
              />
            </div>
          )}

          {/* Model Name — only show for non-TTS services OR TTS with custom provider */}
          {showApiFields && (
            <div className="space-y-1.5">
              <Label className="text-xs">模型名称</Label>
              <Input
                value={config.modelName}
                onChange={(e) => onUpdate({ modelName: e.target.value })}
                placeholder={
                  service === 'llm' ? 'gpt-4o-mini' :
                  service === 'asr' ? 'whisper-1' :
                  service === 'tts' ? 'tts-1' : 'dall-e-3'
                }
                className="text-xs h-8 bg-white/[0.04] border-white/10"
              />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Local model selection */}
          <div className="space-y-1.5">
            <Label className="text-xs">选择本地模型</Label>
            <Select
              value={localModels.includes(config.modelPath) ? config.modelPath : '__custom__'}
              onValueChange={(v) => {
                if (v === '__custom__') {
                  onUpdate({ modelPath: '' });
                } else if (v === '__download__') {
                  setShowDownloadUrl(true);
                } else {
                  onUpdate({ modelPath: v });
                }
              }}
            >
              <SelectTrigger className="text-xs h-8 bg-white/[0.04] border-white/10">
                <SelectValue placeholder="选择已下载的模型" />
              </SelectTrigger>
              <SelectContent>
                {localModels.map((model) => (
                  <SelectItem key={model} value={model}>{model}</SelectItem>
                ))}
                <SelectItem value="__custom__">
                  <span className="flex items-center gap-1"><Plus className="w-3 h-3" /> 自定义路径...</span>
                </SelectItem>
                <SelectItem value="__download__">
                  <span className="flex items-center gap-1"><Download className="w-3 h-3" /> 从 HuggingFace 下载...</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Custom model path input */}
          {!localModels.includes(config.modelPath) && (
            <div className="space-y-1.5">
              <Label className="text-xs">模型路径</Label>
              <Input
                value={config.modelPath}
                onChange={(e) => onUpdate({ modelPath: e.target.value })}
                placeholder="./models/Qwen2.5-7B-Instruct"
                className="text-xs h-8 bg-white/[0.04] border-white/10"
              />
            </div>
          )}

          {/* Download from HuggingFace */}
          {showDownloadUrl && (
            <div className="space-y-2 p-3 rounded-lg bg-white/[0.02] border border-white/5">
              <Label className="text-xs">从 HuggingFace 下载模型</Label>
              <div className="flex gap-2">
                <Input
                  value={downloadUrl}
                  onChange={(e) => setDownloadUrl(e.target.value)}
                  placeholder="org/name（例如 Qwen/Qwen2.5-7B-Instruct）或 https://huggingface.co/..."
                  className="text-xs h-8 bg-white/[0.04] border-white/10 flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                  onClick={() => handleDownload()}
                  disabled={!downloadUrl.trim()}
                >
                  <Download className="w-3 h-3 mr-1" /> 下载
                </Button>
              </div>
              {suggested.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] text-zinc-500">推荐模型（点击下载）：</p>
                  <div className="flex flex-wrap gap-1">
                    {suggested.map((m) => (
                      <button
                        key={m}
                        onClick={() => handleDownload(m)}
                        className="text-[10px] px-2 py-0.5 rounded-md bg-white/[0.04] hover:bg-emerald-500/10 text-zinc-400 hover:text-emerald-400 border border-white/5 transition-colors"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-zinc-500"
                onClick={() => { setShowDownloadUrl(false); setDownloadUrl(''); }}
              >
                <X className="w-3 h-3 mr-1" /> 取消
              </Button>
            </div>
          )}

          {/* Active downloads */}
          {activeDownloads.length > 0 && (
            <div className="space-y-1.5 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
              {activeDownloads.map(([key, info]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-bounce [animation-delay:300ms]" />
                  </div>
                  <span className="text-emerald-400 truncate flex-1">
                    正在下载 {info.modelName}
                  </span>
                  {info.elapsed != null && (
                    <span className="text-[10px] text-zinc-500">{info.elapsed}s</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* LLM-specific: system prompt */}
      {service === 'llm' && (
        <div className="space-y-1.5">
          <Label className="text-xs">系统提示词</Label>
          <Textarea
            value={config.systemPrompt}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value })}
            rows={4}
            className="text-xs bg-white/[0.04] border-white/10 resize-none"
          />
        </div>
      )}

      {/* Image-specific: system prompt */}
      {service === 'image' && (
        <div className="space-y-1.5">
          <Label className="text-xs">图像生成提示词前缀</Label>
          <Textarea
            value={config.systemPrompt}
            onChange={(e) => onUpdate({ systemPrompt: e.target.value })}
            rows={2}
            placeholder="例如：anime style, high quality, detailed"
            className="text-xs bg-white/[0.04] border-white/10 resize-none"
          />
          <p className="text-[10px] text-zinc-600">此提示词会添加到每次图像生成请求前</p>
        </div>
      )}
    </div>
  );
}

// ─── Settings Dialog ──────────────────────────────────────────────────────────

function SettingsDialog() {
  const store = useChatStore();
  const [cloneAudioName, setCloneAudioName] = useState('');
  const [refImageName, setRefImageName] = useState('');

  const handleCloneAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await readFileAsBase64(file);
      store.updateSettings({ cloneRefAudio: base64 });
      setCloneAudioName(file.name);
      toast.success('参考音频已上传');
    } catch {
      toast.error('音频文件读取失败');
    }
  };

  const handleRefImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const base64 = await readFileAsBase64(file);
      store.updateSettings({ imageReferenceImage: base64, imageUseReference: true });
      setRefImageName(file.name);
      toast.success('参考图片已上传');
    } catch {
      toast.error('图片文件读取失败');
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'ai' | 'user') => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      if (type === 'ai') {
        store.setAiAvatar(dataUrl);
      } else {
        store.setUserAvatar(dataUrl);
      }
      toast.success('头像已更新');
    } catch {
      toast.error('头像上传失败');
    }
  };

  return (
    <Dialog open={store.showSettings} onOpenChange={(open) => store.setShowSettings(open)}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-emerald-400" />
            设置
          </DialogTitle>
          <DialogDescription>配置 AI 服务、语音、图像和系统参数</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="llm" className="mt-2 flex-1 flex flex-col min-h-0">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="llm" className="flex-1 gap-1 text-xs">
              <Brain className="w-3 h-3" /> LLM
            </TabsTrigger>
            <TabsTrigger value="asr" className="flex-1 gap-1 text-xs">
              <MicVocal className="w-3 h-3" /> ASR
            </TabsTrigger>
            <TabsTrigger value="tts" className="flex-1 gap-1 text-xs">
              <Volume2 className="w-3 h-3" /> TTS
            </TabsTrigger>
            <TabsTrigger value="image" className="flex-1 gap-1 text-xs">
              <Eye className="w-3 h-3" /> Image
            </TabsTrigger>
            <TabsTrigger value="general" className="flex-1 text-xs">通用</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto chat-scrollbar mt-2">
            {/* LLM Config */}
            <TabsContent value="llm" className="mt-0 p-1">
              <ModelConfigSection
                service="llm"
                config={store.settings.llm}
                onUpdate={(updates) => store.updateModelConfig('llm', updates)}
              />
            </TabsContent>

            {/* ASR Config */}
            <TabsContent value="asr" className="mt-0 p-1">
              <ModelConfigSection
                service="asr"
                config={store.settings.asr}
                onUpdate={(updates) => store.updateModelConfig('asr', updates)}
              />
            </TabsContent>

            {/* TTS Config */}
            <TabsContent value="tts" className="mt-0 p-1">
              <ModelConfigSection
                service="tts"
                config={store.settings.tts}
                onUpdate={(updates) => store.updateModelConfig('tts', updates)}
                ttsApiProvider={store.settings.ttsApiProvider}
                onTtsApiProviderChange={(provider) => {
                  // Use backend-provided default voice for the new provider (API mode only)
                  const vl = useChatStore.getState().voiceLists[provider];
                  const defaultVoice = vl?.defaultVoice ?? (provider === 'edge' ? 'zh-CN-XiaoxiaoNeural' : provider === 'zai' ? 'tongtong' : '');
                  // Reset voice mode if not supported by the new provider
                  const supportedModes = vl?.modes ?? ['preset'];
                  const currentMode = useChatStore.getState().settings.voiceMode;
                  const newMode = supportedModes.includes(currentMode) ? currentMode : 'preset';
                  store.updateSettings({
                    ttsApiProvider: provider,
                    ttsVoice: defaultVoice,
                    voiceMode: newMode as 'preset' | 'clone' | 'design',
                  });
                }}
              />

              <Separator className="bg-white/10 my-4" />

              {/* Voice settings — available in BOTH api and local modes.
                  The voice-mode dropdown (preset/clone/design) is driven by
                  backend-provided modes for the current (provider, mode) pair,
                  fetched via /api/tts/voices?provider=...&mode=api|local. */}
              <div className="space-y-4">
                {(() => {
                  const ttsMode = store.settings.tts.mode; // 'api' | 'local'
                  const provider = store.settings.ttsApiProvider;
                  // voiceLists is keyed by provider for API mode; for local mode
                  // we use the 'local' key (fetched separately).
                  const voiceListKey = ttsMode === 'local' ? 'local' : provider;
                  const vl = store.voiceLists[voiceListKey];
                  const supportedModes = vl?.modes ?? ['preset'];
                  const currentMode = store.settings.voiceMode;
                  // If current mode not supported, fall back to preset
                  const effectiveMode = supportedModes.includes(currentMode) ? currentMode : 'preset';

                  return (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          声音模式
                          <span className="text-[10px] text-zinc-600 ml-2">
                            ({ttsMode === 'local' ? '本地模型' : '在线 API'})
                          </span>
                        </Label>
                        <Select
                          value={effectiveMode}
                          onValueChange={(v) => store.updateSettings({ voiceMode: v as 'preset' | 'clone' | 'design' })}
                        >
                          <SelectTrigger className="text-xs h-8 bg-white/[0.04] border-white/10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {supportedModes.map((m) => (
                              <SelectItem key={m} value={m}>
                                {m === 'preset' ? '预设音色' : m === 'clone' ? '声音克隆' : '声音设计'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {ttsMode === 'local' && (
                          <p className="text-[10px] text-zinc-600">
                            本地模型模式下，声音克隆/设计依赖所选模型的能力（如 CosyVoice 支持参考音频克隆）
                          </p>
                        )}
                      </div>

                      {/* Preset voice selection — only in API mode with a voice list */}
                      {effectiveMode === 'preset' && ttsMode === 'api' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">音色选择（默认角色由后端配置加载）</Label>
                          <Select
                            value={store.settings.ttsVoice}
                            onValueChange={(v) => store.updateSettings({ ttsVoice: v })}
                          >
                            <SelectTrigger className="text-xs h-8 bg-white/[0.04] border-white/10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(store.voiceLists[provider]?.voices ??
                                (provider === 'edge' ? EDGE_VOICE_PRESETS : ZAI_VOICE_PRESETS)
                              ).map((p) => (
                                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Preset voice in local mode — show a text input for voice/speaker id */}
                      {effectiveMode === 'preset' && ttsMode === 'local' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">音色 / Speaker ID（可选）</Label>
                          <Input
                            value={store.settings.ttsVoice}
                            onChange={(e) => store.updateSettings({ ttsVoice: e.target.value })}
                            placeholder="留空使用模型默认音色，或输入 speaker id"
                            className="text-xs h-8 bg-white/[0.04] border-white/10"
                          />
                          <p className="text-[10px] text-zinc-600">
                            本地模型的音色由模型自身决定，部分模型（如 VITS）支持多个 speaker
                          </p>
                        </div>
                      )}

                      {/* Clone: audio file upload — available in both modes */}
                      {effectiveMode === 'clone' && (
                        <div className="space-y-2">
                          <Label className="text-xs">上传参考音频</Label>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 text-xs border-white/10 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30"
                              onClick={() => document.getElementById('clone-audio-input')?.click()}
                            >
                              <Upload className="w-3 h-3 mr-1" /> 选择音频文件
                            </Button>
                            <input
                              id="clone-audio-input"
                              type="file"
                              accept="audio/*"
                              className="hidden"
                              onChange={handleCloneAudioUpload}
                            />
                            {cloneAudioName && (
                              <span className="text-xs text-emerald-400 truncate max-w-[150px]">{cloneAudioName}</span>
                            )}
                            {store.settings.cloneRefAudio && !cloneAudioName && (
                              <span className="text-xs text-zinc-500">已上传</span>
                            )}
                          </div>
                          <p className="text-[10px] text-zinc-600">
                            上传一段音频作为声音克隆的参考（支持 wav/mp3/webm）。
                            {ttsMode === 'local'
                              ? ' 本地模型需自身支持声音克隆（如 CosyVoice）。'
                              : ' ZAI TTS 通过 reference_audio 参数克隆；Edge TTS 不支持克隆，将自动回退到 ZAI。'}
                          </p>
                        </div>
                      )}

                      {/* Design: voice description — available in both modes */}
                      {effectiveMode === 'design' && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">声音描述</Label>
                          <Input
                            value={store.settings.voiceDesignPrompt}
                            onChange={(e) => store.updateSettings({ voiceDesignPrompt: e.target.value })}
                            placeholder="例如：温柔的女声，带有轻微的南方口音"
                            className="text-xs h-8 bg-white/[0.04] border-white/10"
                          />
                          <p className="text-[10px] text-zinc-600">
                            {ttsMode === 'local'
                              ? ' 本地模型需自身支持声音设计（如 CosyVoice instruct 模式）。'
                              : ' ZAI TTS 通过 instruct_text 参数设计声音；Edge TTS 不支持，将自动回退到 ZAI。'}
                          </p>
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">语速</Label>
                    <span className="text-xs text-zinc-500">{store.settings.ttsSpeed.toFixed(1)}x</span>
                  </div>
                  <Slider
                    value={[store.settings.ttsSpeed]}
                    onValueChange={([v]) => store.updateSettings({ ttsSpeed: v })}
                    min={0.5}
                    max={2.0}
                    step={0.1}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">音量</Label>
                    <span className="text-xs text-zinc-500">{store.settings.ttsVolume.toFixed(1)}</span>
                  </div>
                  <Slider
                    value={[store.settings.ttsVolume]}
                    onValueChange={([v]) => store.updateSettings({ ttsVolume: v })}
                    min={0.1}
                    max={10}
                    step={0.5}
                  />
                </div>
              </div>
            </TabsContent>

            {/* Image Config */}
            <TabsContent value="image" className="mt-0 p-1">
              <ModelConfigSection
                service="image"
                config={store.settings.image}
                onUpdate={(updates) => store.updateModelConfig('image', updates)}
              />

              <Separator className="bg-white/10 my-4" />

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">图片尺寸</Label>
                  <Select
                    value={store.settings.imageSize}
                    onValueChange={(v) => store.updateSettings({ imageSize: v })}
                  >
                    <SelectTrigger className="text-xs h-8 bg-white/[0.04] border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1024x1024">1024×1024 正方形</SelectItem>
                      <SelectItem value="768x1344">768×1344 竖屏</SelectItem>
                      <SelectItem value="864x1152">864×1152 竖屏</SelectItem>
                      <SelectItem value="1344x768">1344×768 横屏</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Reference image */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">使用参考图片</Label>
                    <Switch
                      checked={store.settings.imageUseReference}
                      onCheckedChange={(v) => store.updateSettings({ imageUseReference: v })}
                    />
                  </div>
                  {store.settings.imageUseReference && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs border-white/10 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30"
                          onClick={() => document.getElementById('ref-image-input')?.click()}
                        >
                          <Upload className="w-3 h-3 mr-1" /> 选择参考图片
                        </Button>
                        <input
                          id="ref-image-input"
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleRefImageUpload}
                        />
                        {refImageName && (
                          <span className="text-xs text-emerald-400 truncate max-w-[150px]">{refImageName}</span>
                        )}
                        {store.settings.imageReferenceImage && !refImageName && (
                          <span className="text-xs text-zinc-500">已上传</span>
                        )}
                      </div>
                      {store.settings.imageReferenceImage && (
                        <div className="relative inline-block">
                          <img
                            src={`data:image/png;base64,${store.settings.imageReferenceImage}`}
                            alt="参考图片"
                            className="max-w-[200px] max-h-[120px] rounded-lg border border-white/10 object-contain"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30"
                            onClick={() => {
                              store.updateSettings({ imageReferenceImage: '', imageUseReference: false });
                              setRefImageName('');
                            }}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                      <p className="text-[10px] text-zinc-600">上传参考图片以控制生成图像的风格和构图</p>
                    </div>
                  )}
                </div>

                <p className="text-xs text-zinc-500">
                  当 AI 在回复中使用 &lt;action&gt; 标签时，系统会自动根据动作描述生成角色立绘。
                </p>
              </div>
            </TabsContent>

            {/* General Settings */}
            <TabsContent value="general" className="mt-0 p-1 space-y-4">
              {/* Service status grid */}
              <div className="space-y-3">
                <h4 className="text-xs font-medium text-zinc-300">服务组合（回复模式）</h4>
                <p className="text-[10px] text-zinc-600">启用/禁用各服务决定回复模式，如：LLM+TTS=文字+语音，LLM+TTS+Image=文字+语音+立绘</p>
                <div className="grid grid-cols-2 gap-2">
                  {(['llm', 'asr', 'tts', 'image'] as const).map((svc) => {
                    const Icon = SERVICE_ICONS[svc];
                    const cfg = store.settings[svc];
                    return (
                      <div
                        key={svc}
                        className={cn(
                          'flex items-center gap-2 p-2.5 rounded-lg border transition-colors cursor-pointer',
                          cfg.enabled
                            ? 'bg-emerald-500/5 border-emerald-500/20'
                            : 'bg-white/[0.02] border-white/5'
                        )}
                        onClick={() => store.updateModelConfig(svc, { enabled: !cfg.enabled })}
                      >
                        <Icon className={cn('w-3.5 h-3.5', cfg.enabled ? 'text-emerald-400' : 'text-zinc-600')} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-zinc-300 truncate">{SERVICE_LABELS[svc]}</p>
                          <p className="text-[10px] text-zinc-500">
                            {cfg.mode === 'api' ? '在线 API' : '本地模型'}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] px-1 py-0',
                            cfg.enabled
                              ? 'border-emerald-500/30 text-emerald-400'
                              : 'border-zinc-600 text-zinc-500'
                          )}
                        >
                          {cfg.enabled ? 'ON' : 'OFF'}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Separator className="bg-white/10" />

              {/* Avatar uploads */}
              <div className="space-y-3">
                <h4 className="text-xs font-medium text-zinc-300">头像设置</h4>
                <div className="grid grid-cols-2 gap-3">
                  {/* AI Avatar */}
                  <div className="space-y-2">
                    <Label className="text-xs">AI 头像</Label>
                    <div className="flex items-center gap-2">
                      {store.aiAvatar ? (
                        <div className="relative">
                          <img src={store.aiAvatar} alt="AI" className="w-10 h-10 rounded-full object-cover border border-emerald-500/20" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 p-0"
                            onClick={() => store.setAiAvatar(null)}
                          >
                            <X className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 text-xs font-medium">
                          智
                        </div>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px] border-white/10 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30"
                        onClick={() => document.getElementById('ai-avatar-input')?.click()}
                      >
                        <Upload className="w-2.5 h-2.5 mr-1" /> 上传
                      </Button>
                      <input
                        id="ai-avatar-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleAvatarUpload(e, 'ai')}
                      />
                    </div>
                  </div>

                  {/* User Avatar */}
                  <div className="space-y-2">
                    <Label className="text-xs">用户头像</Label>
                    <div className="flex items-center gap-2">
                      {store.userAvatar ? (
                        <div className="relative">
                          <img src={store.userAvatar} alt="User" className="w-10 h-10 rounded-full object-cover border border-zinc-600" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 p-0"
                            onClick={() => store.setUserAvatar(null)}
                          >
                            <X className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-xs font-medium">
                          <User className="w-4 h-4" />
                        </div>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px] border-white/10 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30"
                        onClick={() => document.getElementById('user-avatar-input')?.click()}
                      >
                        <Upload className="w-2.5 h-2.5 mr-1" /> 上传
                      </Button>
                      <input
                        id="user-avatar-input"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleAvatarUpload(e, 'user')}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <Separator className="bg-white/10" />

              {/* Character name */}
              <div className="space-y-1.5">
                <Label className="text-xs">角色名称</Label>
                <Input
                  value={store.characterName}
                  onChange={(e) => store.setCharacterName(e.target.value)}
                  className="text-xs h-8 bg-white/[0.04] border-white/10"
                />
              </div>

              <Separator className="bg-white/10" />

              <Button
                variant="outline"
                className="w-full border-white/10 text-zinc-400 hover:text-red-400 hover:border-red-500/30"
                onClick={() => {
                  store.resetSettings();
                  store.setCharacterName('小智');
                  toast.success('设置已重置');
                }}
              >
                <RotateCcw className="w-3 h-3 mr-2" />
                重置为默认设置
              </Button>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
