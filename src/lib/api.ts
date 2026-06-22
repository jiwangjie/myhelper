/**
 * Backend REST API helpers.
 *
 * All endpoints are served by the Python backend at the same origin as the
 * WebSocket gateway. Because the gateway routes by `?XTransformPort=3003`,
 * we append that query param to every fetch.
 */

const API_BASE = '/api';

function withPort(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}XTransformPort=3003`;
}

export interface VoiceOption {
  value: string;
  label: string;
}

export interface VoiceListResponse {
  provider: string;
  defaultVoice: string;
  voices: VoiceOption[];
  modes: string[];  // ['preset' | 'clone' | 'design']
}

export interface LocalModelsResponse {
  llm: string[];
  asr: string[];
  tts: string[];
  image: string[];
  suggested: Record<string, string[]>;
}

export interface ConfigDefaults {
  configs: Record<string, any>;
  ttsSettings: Record<string, any>;
  zaiApiUrl: string;
  zaiConfigured: boolean;
}

export interface HealthResponse {
  status: string;
  zai_configured: boolean;
  local_runtimes: Record<string, boolean>;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(withPort(`${API_BASE}${path}`));
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchHealth(): Promise<HealthResponse | null> {
  return fetchJson<HealthResponse>('/health');
}

export async function fetchVoices(provider: string, mode: string = 'api'): Promise<VoiceListResponse | null> {
  return fetchJson<VoiceListResponse>(
    `/tts/voices?provider=${encodeURIComponent(provider)}&mode=${encodeURIComponent(mode)}`
  );
}

export async function fetchLocalModels(): Promise<LocalModelsResponse | null> {
  return fetchJson<LocalModelsResponse>('/models');
}

export async function fetchConfigDefaults(): Promise<ConfigDefaults | null> {
  return fetchJson<ConfigDefaults>('/config/defaults');
}
