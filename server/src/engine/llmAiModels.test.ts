import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_SELECTION,
  filterSelectableAiModels,
  isSelectableAiModel,
  LOCAL_AI_MODEL,
  normalizeAiSelection,
  llmFindBestPlay,
} from './llmAi';
import { generateLegalPlays } from './ai';
import { Rank, Suit } from '../../../shared/types';

test('DeepSeek exposes queried non-Pro models and rejects Pro models', () => {
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-v4-flash'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-chat'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-reasoner'), true);
  assert.equal(isSelectableAiModel('deepseek', 'deepseek-v4-pro'), false);
  assert.equal(isSelectableAiModel('deepseek', 'DEEPSEEK-PRO-FAST'), false);
  assert.deepEqual(
    filterSelectableAiModels('deepseek', [
      'deepseek-chat',
      'deepseek-v4-flash',
      'deepseek-reasoner',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]),
    ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'],
  );
  assert.deepEqual(
    normalizeAiSelection('deepseek', 'deepseek-chat'),
    { provider: 'deepseek', model: 'deepseek-chat' },
  );
  assert.deepEqual(normalizeAiSelection('deepseek', 'deepseek-v4-pro'), {
    provider: 'deepseek',
    model: '',
  });
  assert.deepEqual(normalizeAiSelection('deepseek', undefined), {
    provider: 'deepseek', model: 'deepseek-v4-flash',
  });
  assert.deepEqual(normalizeAiSelection(undefined, undefined), DEFAULT_AI_SELECTION);
  assert.deepEqual(normalizeAiSelection('local', undefined), { provider: 'local', model: LOCAL_AI_MODEL });
});

test('Local only exposes and accepts Qwen3.8-27', () => {
  assert.equal(isSelectableAiModel('local', LOCAL_AI_MODEL), true);
  assert.equal(isSelectableAiModel('local', 'qwen2.5-7b-instruct'), false);
  assert.equal(isSelectableAiModel('local', 'qwen-27B'), false);
  assert.equal(isSelectableAiModel('local', 'Qwen3.8-27B'), false);
  assert.deepEqual(
    filterSelectableAiModels('local', [
      'qwen-72b',
      'qwen-27B',
      LOCAL_AI_MODEL,
      LOCAL_AI_MODEL,
    ]),
    [LOCAL_AI_MODEL],
  );
  assert.deepEqual(normalizeAiSelection('local', 'qwen-32b'), {
    provider: 'local',
    model: '',
  });
});

test('default Qwen request uses Fueternal credentials and disables thinking', async () => {
  const previousFetch = globalThis.fetch;
  const names = ['LOCAL_LLM_BASE_URL', 'LOCAL_LLM_API_KEY', 'FUETERNAL_API_KEY'] as const;
  const previous = names.map(name => process.env[name]);
  delete process.env.LOCAL_LLM_BASE_URL;
  delete process.env.LOCAL_LLM_API_KEY;
  process.env.FUETERNAL_API_KEY = 'test-only';
  const hand = [{ id: 0, suit: Suit.Spade, rank: Rank.Two }];
  const plays = generateLegalPlays(hand, Rank.Two);
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://fueternal.com/api/v1/chat/completions');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-only');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'Qwen3.8-27');
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.thinking, undefined);
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"action_id":0}' } }] }));
  }) as typeof fetch;
  try {
    assert.equal(await llmFindBestPlay(hand, plays, null, true, Rank.Two, undefined,
      { provider: 'local', model: LOCAL_AI_MODEL }), plays[0]);
  } finally {
    globalThis.fetch = previousFetch;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
