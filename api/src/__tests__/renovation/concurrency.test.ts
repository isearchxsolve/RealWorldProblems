/**
 * SCENARIO_CONCURRENCY_RACE (concurrency) — companion concurrency suite.
 *
 * Multiple simultaneous requests against the same resource must produce an
 * atomic transition: the first operation wins, the second is safely rejected,
 * and no milestone is ever released twice (zero double spend).
 */

import { RenovationCoordinator, RenovationError } from '../../renovation/renovationCoordinator';
import {
  BASE_TOTAL_CENTS,
  createSeededCoordinator,
  MILESTONE_SEQUENCE,
  OWNER_ID,
  PROJECT_ID,
  SEQUENCE,
  signOffAll
} from './fixtures';

function reasonOf(result: PromiseSettledResult<unknown>): RenovationError {
  if (result.status !== 'rejected') {
    throw new Error('Expected a rejected result.');
  }
  if (result.reason instanceof RenovationError) {
    return result.reason;
  }
  throw result.reason;
}

describe('SCENARIO_CONCURRENCY_RACE: simultaneous requests are atomic', () => {
  it('releases a single milestone exactly once under 10 concurrent requests (no double spend)', async () => {
    const coordinator = createSeededCoordinator();
    await coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-plumber', actorId: OWNER_ID });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-plumber', actorId: OWNER_ID })
      )
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const failure of rejected) {
      expect(reasonOf(failure).code).toBe('MILESTONE_ALREADY_RELEASED');
    }

    const summary = coordinator.summarize(PROJECT_ID);
    expect(summary.releasedMilestoneIds).toEqual(['m-plumber']);
    expect(summary.releasedTotalCents).toBe(150000);
    expect(summary.pendingTotalCents).toBe(BASE_TOTAL_CENTS - 150000);
  });

  it('signs off a contractor exactly once under concurrent requests', async () => {
    const coordinator = createSeededCoordinator();

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-plumber', actorId: OWNER_ID })
      )
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(4);
    for (const failure of rejected) {
      expect(reasonOf(failure).code).toBe('INVALID_INPUT');
    }
    expect(coordinator.summarize(PROJECT_ID).nextActionableContractorId).toBe('c-electrician');
  });

  it('allows concurrent, independent milestones and never double counts', async () => {
    const coordinator: RenovationCoordinator = createSeededCoordinator();
    await signOffAll(coordinator, SEQUENCE);

    const results = await Promise.allSettled(
      MILESTONE_SEQUENCE.map((milestoneId) =>
        coordinator.releaseMilestone(PROJECT_ID, { milestoneId, actorId: OWNER_ID })
      )
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const summary = coordinator.summarize(PROJECT_ID);
    expect(summary.releasedTotalCents).toBe(BASE_TOTAL_CENTS);
    expect([...summary.releasedMilestoneIds].sort()).toEqual([...MILESTONE_SEQUENCE].sort());
    expect(summary.pendingTotalCents).toBe(0);
  });
});
