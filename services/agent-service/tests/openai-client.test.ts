import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppConfig } from '../src/config/env.js';
import { calculateEstimatedCostUsd, OpenAIInvestigatorClient } from '../src/openai/client.js';
import { buildPrompt } from '../src/investigation/prompt.js';
import { agreeingConclusion, linkEvidence, linkIncident } from './fixtures.js';

const config: AppConfig = {
  projectId: 'acn-local',
  emulatorHost: '127.0.0.1:8080',
  openAIApiKey: 'test-key',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
  timeoutMs: 5_000,
  maxOutputTokens: 4_096,
  logLevel: 'error',
};

test('Responses API request pins Luna, low reasoning, no storage and structured output', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(successPayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new OpenAIInvestigatorClient(config, fakeFetch, 'https://example.test/responses');
  const result = await client.investigate(buildPrompt(linkIncident, linkEvidence));

  assert.equal(requestBody?.['model'], 'gpt-5.6-luna');
  assert.equal(requestBody?.['store'], false);
  assert.deepEqual(requestBody?.['reasoning'], { effort: 'low' });
  const text = requestBody?.['text'] as Record<string, unknown>;
  assert.equal((text['format'] as Record<string, unknown>)['type'], 'json_schema');
  assert.equal(result.conclusion.rootCauseType, 'interface_misconfiguration');
  assert.equal(result.usage.reasoningTokens, 80);
  assert.equal(result.estimatedCostUsd, 0.0004);
});

test('missing API key fails locally without making a request', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    throw new Error('should not run');
  }) as typeof fetch;
  const client = new OpenAIInvestigatorClient({ ...config, openAIApiKey: undefined }, fakeFetch);

  await assert.rejects(() => client.investigate(buildPrompt(linkIncident, linkEvidence)), /not configured/);
  assert.equal(called, false);
});

test('API errors retain useful status and message without exposing credentials', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'model unavailable' },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const client = new OpenAIInvestigatorClient(config, fakeFetch);

  await assert.rejects(
    () => client.investigate(buildPrompt(linkIncident, linkEvidence)),
    /OpenAI API 400 invalid_request_error: model unavailable/,
  );
});

test('cost calculation accounts for cached input and cache writes', () => {
  assert.equal(calculateEstimatedCostUsd({
    inputTokens: 2_000,
    cachedInputTokens: 500,
    cacheWriteTokens: 500,
    outputTokens: 1_000,
    reasoningTokens: 200,
    totalTokens: 3_000,
  }), 0.001535);
});

function successPayload() {
  return {
    id: 'resp_test',
    model: 'gpt-5.6-luna',
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify(agreeingConclusion) }],
    }],
    usage: {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 250, cache_write_tokens: 100 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 80 },
      total_tokens: 1_200,
    },
  };
}
