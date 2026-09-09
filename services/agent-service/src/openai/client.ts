import type { AppConfig } from '../config/env.js';
import type {
  AgentConclusion,
  InvestigatorClient,
  ModelResult,
  ModelUsage,
  PromptRecord,
  RootCauseType,
} from '../models/types.js';

const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

// Official GPT-5.6 Luna standard-context rates, USD per one million tokens.
const PRICE = {
  input: 0.20,
  cachedInput: 0.02,
  cacheWrite: 0.25,
  output: 1.20,
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'rootCauseType', 'rootCauseDevices', 'summary', 'confidence', 'reasoning',
    'citedEventIds', 'citedLogIds',
  ],
  properties: {
    rootCauseType: {
      type: 'string',
      enum: [
        'configuration_drift',
        'routing_session_failure',
        'interface_misconfiguration',
        'routing_service_failure',
        'resource_exhaustion',
        'unknown',
      ],
    },
    rootCauseDevices: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'array', items: { type: 'string' } },
    citedEventIds: { type: 'array', items: { type: 'string' } },
    citedLogIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

type FetchLike = typeof fetch;

/** Minimal Responses API client. The service needs no tools and has no actions. */
export class OpenAIInvestigatorClient implements InvestigatorClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly endpoint = RESPONSES_ENDPOINT,
  ) {}

  async investigate(prompt: PromptRecord): Promise<ModelResult> {
    if (this.config.openAIApiKey === undefined) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const started = performance.now();
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openAIApiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
      body: JSON.stringify({
        model: this.config.model,
        store: false,
        reasoning: { effort: this.config.reasoningEffort },
        max_output_tokens: this.config.maxOutputTokens,
        input: [
          { role: 'developer', content: prompt.developer },
          { role: 'user', content: prompt.input },
        ],
        text: {
          verbosity: 'low',
          format: {
            type: 'json_schema',
            name: 'acn_incident_investigation',
            strict: true,
            schema: OUTPUT_SCHEMA,
          },
        },
      }),
    });

    const latencyMs = Math.round(performance.now() - started);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(openAIError(response.status, payload));

    const record = object(payload, 'OpenAI response');
    const status = optionalString(record['status']);
    if (status !== 'completed') {
      throw new Error(`OpenAI response did not complete (status=${status ?? 'unknown'})`);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(extractOutputText(record)) as unknown;
    } catch (error) {
      throw new Error(`OpenAI structured output was not valid JSON: ${describe(error)}`);
    }
    const conclusion = parseConclusion(decoded);
    const usage = parseUsage(record['usage']);

    return {
      responseId: requiredString(record['id'], 'response id'),
      responseModel: requiredString(record['model'], 'response model'),
      conclusion,
      usage,
      latencyMs,
      estimatedCostUsd: calculateEstimatedCostUsd(usage),
    };
  }
}

export function calculateEstimatedCostUsd(usage: ModelUsage): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cacheWrites = Math.min(usage.cacheWriteTokens, usage.inputTokens - cached);
  const regular = Math.max(0, usage.inputTokens - cached - cacheWrites);
  const cost =
    (regular * PRICE.input + cached * PRICE.cachedInput + cacheWrites * PRICE.cacheWrite +
      usage.outputTokens * PRICE.output) /
    1_000_000;
  return Math.round(cost * 1_000_000_000) / 1_000_000_000;
}

function extractOutputText(response: Record<string, unknown>): string {
  const output = response['output'];
  if (!Array.isArray(output)) throw new Error('OpenAI response has no output array');

  for (const item of output) {
    if (!isObject(item) || item['type'] !== 'message' || !Array.isArray(item['content'])) continue;
    for (const content of item['content']) {
      if (
        isObject(content) && content['type'] === 'output_text' &&
        typeof content['text'] === 'string'
      ) return content['text'];
    }
  }
  throw new Error('OpenAI response contains no output_text');
}

function parseConclusion(value: unknown): AgentConclusion {
  const data = object(value, 'structured conclusion');
  const rootCauseType = requiredString(data['rootCauseType'], 'rootCauseType');
  if (!isRootCauseType(rootCauseType)) throw new Error(`Invalid rootCauseType: ${rootCauseType}`);

  const confidence = requiredString(data['confidence'], 'confidence');
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    throw new Error(`Invalid confidence: ${confidence}`);
  }

  return {
    rootCauseType,
    rootCauseDevices: stringArray(data['rootCauseDevices'], 'rootCauseDevices'),
    summary: requiredString(data['summary'], 'summary'),
    confidence,
    reasoning: stringArray(data['reasoning'], 'reasoning'),
    citedEventIds: stringArray(data['citedEventIds'], 'citedEventIds'),
    citedLogIds: stringArray(data['citedLogIds'], 'citedLogIds'),
  };
}

function parseUsage(value: unknown): ModelUsage {
  const usage = object(value, 'usage');
  const inputDetails = isObject(usage['input_tokens_details']) ? usage['input_tokens_details'] : {};
  const outputDetails = isObject(usage['output_tokens_details']) ? usage['output_tokens_details'] : {};
  return {
    inputTokens: numeric(usage['input_tokens']),
    cachedInputTokens: numeric(inputDetails['cached_tokens']),
    cacheWriteTokens: numeric(inputDetails['cache_write_tokens']),
    outputTokens: numeric(usage['output_tokens']),
    reasoningTokens: numeric(outputDetails['reasoning_tokens']),
    totalTokens: numeric(usage['total_tokens']),
  };
}

function openAIError(status: number, payload: unknown): string {
  if (isObject(payload) && isObject(payload['error'])) {
    const message = optionalString(payload['error']['message']);
    const type = optionalString(payload['error']['type']);
    if (message !== undefined) return `OpenAI API ${status}${type ? ` ${type}` : ''}: ${message}`;
  }
  return `OpenAI API request failed with HTTP ${status}`;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${name} is not an object`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is missing`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} is not a string array`);
  }
  return value;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRootCauseType(value: string): value is RootCauseType {
  return value === 'configuration_drift' ||
    value === 'routing_session_failure' ||
    value === 'interface_misconfiguration' ||
    value === 'routing_service_failure' ||
    value === 'resource_exhaustion' ||
    value === 'unknown';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
