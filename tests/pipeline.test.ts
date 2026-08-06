import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allowedTransitions,
  canTransition,
  isStageKey,
  stageProgress,
  stageStates,
  STAGES,
} from '../src/lib/pipeline/stages';

describe('pipeline stages', () => {
  it('is ordered without gaps', () => {
    STAGES.forEach((stage, index) => assert.equal(stage.sortOrder, index + 1));
  });

  it('recognises valid keys only', () => {
    assert.equal(isStageKey('inquiry'), true);
    assert.equal(isStageKey('funded'), true);
    assert.equal(isStageKey('approved'), false);
  });

  it('marks earlier stages complete, later stages locked', () => {
    const states = stageStates('under_review');
    assert.equal(states[0]!.state, 'complete');
    assert.equal(states[1]!.state, 'complete');
    assert.equal(states[2]!.state, 'current');
    assert.equal(states[3]!.state, 'locked');
    assert.equal(states[5]!.state, 'locked');
  });

  it('reports progress from 0 to 1', () => {
    assert.equal(stageProgress('inquiry'), 0);
    assert.equal(stageProgress('funded'), 1);
    assert.ok(stageProgress('under_review') > 0 && stageProgress('under_review') < 1);
  });
});

describe('stage transitions', () => {
  it('allows exactly one step forward', () => {
    assert.equal(canTransition('inquiry', 'documents_received'), true);
    assert.equal(canTransition('inquiry', 'under_review'), false);
    assert.equal(canTransition('inquiry', 'funded'), false);
  });

  it('allows any step backward, so a premature advance can be corrected', () => {
    assert.equal(canTransition('final_approval', 'inquiry'), true);
    assert.equal(canTransition('final_approval', 'under_review'), true);
  });

  it('offers nothing beyond the last stage', () => {
    assert.equal(allowedTransitions('funded').includes('funded' as never), false);
    assert.equal(canTransition('funded', 'funded'), false);
  });

  it('never offers the current stage as a target', () => {
    for (const stage of STAGES) {
      assert.equal(
        allowedTransitions(stage.key).includes(stage.key),
        false,
        `${stage.key} offered itself`,
      );
    }
  });
});
