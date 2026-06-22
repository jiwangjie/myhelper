/**
 * PCM 连续无缝播放器（AudioWorklet 版）
 *
 * 根本解决"滴滴声"：使用 AudioWorkletNode 实现真正的连续 PCM 流式播放。
 *
 * 原理：
 * - 创建一个 AudioWorklet 处理器，维护一个 PCM 样本队列
 * - 所有句子的 PCM 分块按顺序 push 到队列
 * - 处理器在 process() 中从队列连续读取样本填入输出，无 source 边界、无间隙
 * - 消除了 AudioBufferSourceNode 的启停边界（滴滴声来源）
 *
 * 优势：
 * - 句子间无间隙、无 source 切换 → 彻底消除"滴滴"声
 * - 仅首尾应用极短淡入淡出（整段音频开始与结束），中间无任何振幅调制
 * - 支持动态 push，流式播放延迟低
 */

// AudioWorklet 处理器代码（作为字符串内联，运行在 AudioWorklet 线程）
const WORKLET_CODE = `
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];     // Float32Array 队列
    this.queueLen = 0;   // 队列总样本数
    this.offset = 0;     // 当前块内已读偏移
    this.blockIdx = 0;   // 当前块索引
    this.started = false;
    this.ended = false;
    this.fadeApplied = false;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'push') {
        // msg.samples 为 Float32Array
        const arr = msg.samples;
        this.queue.push(arr);
        this.queueLen += arr.length;
        if (!this.started) this.started = true;
      } else if (msg.type === 'end') {
        this.ended = true;
      } else if (msg.type === 'clear') {
        this.queue = [];
        this.queueLen = 0;
        this.offset = 0;
        this.blockIdx = 0;
        this.started = false;
        this.ended = false;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const channel = output[0];
    if (!channel) return true;

    // 若未开始且有数据，标记开始
    if (!this.started) {
      // 输出静音
      for (let i = 0; i < channel.length; i++) channel[i] = 0;
      return true;
    }

    // 从队列连续读取样本填入输出
    let written = 0;
    while (written < channel.length && this.queue.length > 0) {
      const block = this.queue[0];
      const remain = block.length - this.offset;
      const need = channel.length - written;
      const copy = Math.min(remain, need);
      for (let i = 0; i < copy; i++) {
        channel[written + i] = block[this.offset + i];
      }
      written += copy;
      this.offset += copy;
      if (this.offset >= block.length) {
        this.queue.shift();
        this.offset = 0;
        this.blockIdx++;
      }
    }
    // 不足部分补静音
    for (let i = written; i < channel.length; i++) channel[i] = 0;

    // 首次播放时对最前面 64 样本做淡入（消除启动爆音）
    if (!this.fadeApplied && this.blockIdx === 0 && this.offset >= 64) {
      // 重新对已输出的前 64 样本无法修改，这里改为在 push 时处理
      this.fadeApplied = true;
    }

    // 队列空且已结束 → 通知主线程播放完成
    if (this.ended && this.queue.length === 0) {
      this.port.postMessage({ type: 'done' });
      this.ended = false; // 避免重复发送
    }
    return true;
  }
}
registerProcessor('pcm-player-processor', PcmPlayerProcessor);
`;

const START_FADE_SAMPLES = 48; // 2ms @ 24kHz，整段音频开头淡入
const END_FADE_SAMPLES = 96;   // 4ms @ 24kHz，整段音频结尾淡出

export class AudioChunkPlayer {
  private audioContext: AudioContext | null = null;
  private sampleRate: number = 24000;
  private workletNode: AudioWorkletNode | null = null;
  private interrupted = false;
  private totalSamplesPushed = 0;
  private isReady = false;
  // 当所有音频播完时回调（interrupt 不触发）
  onPlaybackEnd: (() => void) | null = null;
  // 缓冲待 push 的 PCM（等 worklet ready）
  private pendingPush: Float32Array[] = [];
  private streamEnded = false;
  // Token to prevent stale init callbacks from overwriting newer worklet nodes
  private initToken = 0;

  init(sampleRate = 24000) {
    const myToken = ++this.initToken;
    this.close();
    this.sampleRate = sampleRate;
    this.audioContext = new AudioContext({ sampleRate });
    this.interrupted = false;
    this.totalSamplesPushed = 0;
    this.isReady = false;
    this.pendingPush = [];
    this.streamEnded = false;

    // 主动 resume
    this._resume();

    // 加载 AudioWorklet 处理器
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    this.audioContext.audioWorklet
      .addModule(url)
      .then(() => {
        URL.revokeObjectURL(url);
        // Skip if a newer init() has been called since this one started
        if (myToken !== this.initToken || this.interrupted || !this.audioContext) return;
        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-player-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.workletNode.port.onmessage = (e: MessageEvent) => {
          if (e.data.type === 'done' && !this.interrupted) {
            this.onPlaybackEnd?.();
          }
        };
        this.workletNode.connect(this.audioContext.destination);
        this.isReady = true;
        // flush 缓冲的 PCM
        for (const arr of this.pendingPush) {
          this._pushToWorklet(arr);
        }
        this.pendingPush = [];
        if (this.streamEnded) {
          this._sendEnd();
        }
      })
      .catch((err) => {
        console.error('[AudioPlayer] AudioWorklet load failed:', err);
      });
  }

  private _resume() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  private _pushToWorklet(arr: Float32Array) {
    if (!this.workletNode) return;
    // 转移所有权（零拷贝）
    this.workletNode.port.postMessage({ type: 'push', samples: arr }, [arr.buffer]);
  }

  addChunk(pcmBase64: string, seq: number, sampleRate: number) {
    if (!this.audioContext) return;
    if (sampleRate > 0) {
      this.sampleRate = sampleRate;
    }
    this._resume();

    const binaryStr = atob(pcmBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);

    // 转 Float32
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float32[i] = pcm[i] / 32768.0;
    }

    // 仅对整段音频最开始做淡入（首次 push 的前几样本）
    if (this.totalSamplesPushed === 0) {
      const fadeLen = Math.min(START_FADE_SAMPLES, float32.length);
      for (let i = 0; i < fadeLen; i++) {
        float32[i] *= i / fadeLen;
      }
    }
    this.totalSamplesPushed += float32.length;

    if (this.isReady && this.workletNode) {
      this._pushToWorklet(float32);
    } else {
      this.pendingPush.push(float32);
    }
  }

  /** 音频流结束：发送 end 信号，worklet 播完队列后触发 onPlaybackEnd */
  flush() {
    this.streamEnded = true;
    if (this.isReady) {
      this._sendEnd();
    }
  }

  private _sendEnd() {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'end' });
    }
  }

  interrupt() {
    this.interrupted = true;
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'clear' });
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }
    this.close();
  }

  close() {
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }
    this.workletNode = null;
    this.isReady = false;
  }
}
