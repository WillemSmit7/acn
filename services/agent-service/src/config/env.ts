import 'dotenv/config';

export const OPENAI_MODEL = 'gpt-5.6-luna' as const;

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  projectId: string;
  emulatorHost: string | undefined;
  openAIApiKey: string | undefined;
  model: typeof OPENAI_MODEL;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
  maxOutputTokens: number;
  logLevel: LogLevel;
}

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid ${name}="${raw}" - expected an integer >= ${min}`);
  }
  return parsed;
}

function reasoningEffortFromEnv(): ReasoningEffort {
  const raw = (process.env.OPENAI_REASONING_EFFORT ?? 'low').toLowerCase();
  if (
    raw === 'none' || raw === 'low' || raw === 'medium' || raw === 'high' ||
    raw === 'xhigh' || raw === 'max'
  ) return raw;
  throw new Error(
    `Invalid OPENAI_REASONING_EFFORT="${raw}" - expected none|low|medium|high|xhigh|max`,
  );
}

function logLevelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  throw new Error(`Invalid LOG_LEVEL="${raw}" - expected debug|info|warn|error`);
}

export function loadConfig(): AppConfig {
  const key = process.env.OPENAI_API_KEY?.trim();
  return {
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'acn-local',
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST || undefined,
    openAIApiKey: key === undefined || key === '' ? undefined : key,
    model: OPENAI_MODEL,
    reasoningEffort: reasoningEffortFromEnv(),
    timeoutMs: intFromEnv('OPENAI_TIMEOUT_MS', 60_000, 1_000),
    maxOutputTokens: intFromEnv('OPENAI_MAX_OUTPUT_TOKENS', 4_096, 256),
    logLevel: logLevelFromEnv(),
  };
}
