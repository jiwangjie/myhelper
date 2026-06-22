/**
 * Socket.io 客户端适配器：自动重连 + 按事件类型订阅。
 *
 * 与后端 ai-pipeline 服务协议对应：
 *   服务端 → 客户端：llm_chunk / llm_end / audio_chunk / audio_end /
 *                    image_start / image_done / asr_result / model_status /
 *                    error / warmup_done
 *   客户端 → 服务端：chat / asr / interrupt / image
 */

import { io, Socket } from 'socket.io-client';

export type ServerEventType =
  | 'warmup_done'
  | 'llm_chunk'
  | 'llm_end'
  | 'audio_chunk'
  | 'audio_end'
  | 'image_start'
  | 'image_done'
  | 'asr_result'
  | 'model_status'
  | 'model_downloaded'
  | 'download_progress'
  | 'error';

export type ClientEventType = 'chat' | 'asr' | 'interrupt' | 'image' | 'download_model' | 'regenerate_image';

export interface WSMessage {
  type: ServerEventType;
  data: any;
  seq?: number;
  sample_rate?: number;
  service?: string;
  status?: string;
}

type Handler = (msg: WSMessage) => void;
type StatusHandler = (connected: boolean) => void;

const DEFAULT_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.host}`
    : '';

class WSClient {
  private socket: Socket | null = null;
  private url = '';
  private handlers = new Map<ServerEventType, Set<Handler>>();
  private statusHandlers = new Set<StatusHandler>();
  private shouldConnect = false;

  connect(url?: string) {
    this.url = url || DEFAULT_URL;
    if (!this.url) return;
    this.shouldConnect = true;
    this._open();
  }

  private _open() {
    // 已存在 socket（连接中或重连中）则复用，避免重复创建导致监听器重复绑定
    if (this.socket) return;

    try {
      this.socket = io(this.url, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15000,
        timeout: 10000,
        // Caddy uses XTransformPort query param to route to backend (port 3003)
        query: { XTransformPort: '3003' },
      });

      this.socket.on('connect', () => {
        this._notifyStatus(true);
      });

      this.socket.on('disconnect', () => {
        this._notifyStatus(false);
      });

      this.socket.on('connect_error', () => {
        this._notifyStatus(false);
      });

      // 监听各事件类型，包装成统一的 WSMessage
      const eventTypes: ServerEventType[] = [
        'warmup_done', 'llm_chunk', 'llm_end', 'audio_chunk',
        'audio_end', 'image_start', 'image_done', 'asr_result',
        'model_status', 'model_downloaded', 'download_progress', 'error',
      ];
      for (const et of eventTypes) {
        this.socket.on(et, (data: any) => {
          const msg: WSMessage = {
            type: et,
            data,
            seq: data?.seq,
            sample_rate: data?.sample_rate,
            service: data?.service,
            status: data?.status,
          };
          const set = this.handlers.get(et);
          if (set) for (const h of set) h(msg);
        });
      }
    } catch {
      this._notifyStatus(false);
    }
  }

  /** 订阅某类服务端消息，返回取消订阅函数。 */
  on(type: ServerEventType, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** 订阅连接状态变化。 */
  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private _notifyStatus(connected: boolean) {
    for (const h of this.statusHandlers) h(connected);
  }

  /** 发送一条客户端消息。 */
  send(type: ClientEventType | string, data: any = {}) {
    if (this.socket?.connected) {
      this.socket.emit(type, data);
      return true;
    }
    return false;
  }

  get connected() {
    return this.socket?.connected ?? false;
  }

  disconnect() {
    this.shouldConnect = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this._notifyStatus(false);
  }
}

// 模块级单例
export const wsClient = new WSClient();
