import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI_SELECTION,
  filterSelectableAiModels,
  isSelectableAiModel,
  LOCAL_AI_MODEL,
  normalizeAiSelection,
} from './llmAi';

test('HWCloud only exposes the selected gateway model', () => {
  assert.equal(isSelectableAiModel('hwcloud', 'HW-deepseek-v4.1-flash-1017'), true);
  assert.equal(isSelectableAiModel('hwcloud', 'HW-glm-5.3'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'deepseek-v4-flash'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'deepseek-v4-pro'), false);
  assert.equal(isSelectableAiModel('hwcloud', 'Qwen3.8-27'), false);
  assert.deepEqual(
    filterSelectableAiModels('hwcloud', [
      'deepseek-v4.1-flash',
      'HW-glm-5.3',
      'HW-deepseek-v4.1-flash-1017',
      'HW-glm-5.3',
    ]),
    ['HW-deepseek-v4.1-flash-1017'],
  );
  assert.deepEqual(
    normalizeAiSelection('hwcloud', 'HW-deepseek-v4.1-flash-1017'),
    { provider: 'hwcloud', model: 'HW-deepseek-v4.1-flash-1017' },
  );
  assert.deepEqual(normalizeAiSelection('hwcloud', 'HW-glm-5.3'), {
    provider: 'hwcloud',
    model: '',
  });
  assert.deepEqual(normalizeAiSelection('hwcloud', 'deepseek-v4-flash'), {
    provider: 'hwcloud',
    model: '',
  });
  // Legacy clients that still send the old provider id are remapped to hwcloud.
  assert.deepEqual(normalizeAiSelection('deepseek', 'HW-deepseek-v4.1-flash-1017'), {
    provider: 'hwcloud',
    model: 'HW-deepseek-v4.1-flash-1017',
  });
  assert.deepEqual(normalizeAiSelection('hwcloud', undefined), DEFAULT_AI_SELECTION);
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
