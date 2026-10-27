/**
 * SCENARIO_NEGATIVE_FAILURE (negative) — companion negative suite.
 *
 * Malformed data, unauthorized callers and invalid credentials must be refused
 * immediately with a proper typed error code; the caller must never observe a
 * partially applied state change.
 */

import {
  RenovationCoordinator,
  RenovationError,
  handleRenovationRequest
} from '../../renovation/renovationCoordinator';
import { createSeededCoordinator, OWNER_ID, PROJECT_ID } from './fixtures';

function captureSync(fn: () => unknown): RenovationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof RenovationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a RenovationError but none was thrown.');
}

async function captureRejection(promise: Promise<unknown>): Promise<RenovationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RenovationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a RenovationError rejection but the promise resolved.');
}

describe('SCENARIO_NEGATIVE_FAILURE: malformed, unauthorized and invalid requests are refused', () => {
  it('refuses malformed scheduling data with typed errors', () => {
    const coordinator = new RenovationCoordinator();

    expect(
      captureSync(() =>
        coordinator.createProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 'zero', scheduledEndDay: 1 }]
        })
      ).code
    ).toBe('INVALID_INPUT');

    expect(
      captureSync(() =>
        coordinator.createProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 5, scheduledEndDay: 2 }]
        })
      ).code
    ).toBe('OUT_OF_RANGE');

    expect(
      captureSync(() =>
        coordinator.createProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1, dependsOn: 'c-plumber' }]
        })
      ).code
    ).toBe('INVALID_INPUT');
  });

  it('refuses malformed, unknown and self-referencing milestone/contractor references', () => {
    expect(
      captureSync(() =>
        new RenovationCoordinator().createProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }],
          milestones: [{ id: 'm-only', contractorId: 'c-only', amountCents: 'lots' }]
        })
      ).code
    ).toBe('INVALID_INPUT');

    const unknownContractor = captureSync(() =>
      new RenovationCoordinator().createProject({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }],
        milestones: [{ id: 'm-only', contractorId: 'c-missing', amountCents: 100 }]
      })
    );
    expect(unknownContractor.code).toBe('UNKNOWN_CONTRACTOR');
    expect(unknownContractor.status).toBe(404);

    const selfDependency = captureSync(() =>
      new RenovationCoordinator().createProject({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1, dependsOn: ['c-only'] }]
      })
    );
    expect(selfDependency.code).toBe('INVALID_INPUT');
  });

  it('refuses callers that lack authority with 403 UNAUTHORIZED_ACTOR', async () => {
    const coordinator = createSeededCoordinator();

    const signOff = await captureRejection(
      coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-plumber', actorId: 'intruder' })
    );
    expect(signOff.code).toBe('UNAUTHORIZED_ACTOR');
    expect(signOff.status).toBe(403);

    const release = await handleRenovationRequest(coordinator, 'release-milestone', {
      projectId: PROJECT_ID,
      milestoneId: 'm-plumber',
      actorId: 'intruder'
    });
    expect(release.status).toBe(403);
    expect(release.body.code).toBe('UNAUTHORIZED_ACTOR');
    expect(release.body.ok).toBe(false);
  });
});

describe('SCENARIO_NEGATIVE_FAILURE: conflicts and out-of-sequence operations', () => {
  it('refuses duplicate project identifiers with 409 DUPLICATE_ID', () => {
    const coordinator = createSeededCoordinator();
    const duplicate = captureSync(() =>
      coordinator.createProject({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }]
      })
    );
    expect(duplicate.code).toBe('DUPLICATE_ID');
    expect(duplicate.status).toBe(409);
  });

  it('refuses out-of-sequence sign-off and premature or unknown milestone release', async () => {
    const coordinator = createSeededCoordinator();

    const tilerFirst = await captureRejection(
      coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-tiler', actorId: OWNER_ID })
    );
    expect(tilerFirst.code).toBe('DEPENDENCY_NOT_SIGNED_OFF');
    expect(tilerFirst.status).toBe(409);

    const releaseBeforeSignOff = await captureRejection(
      coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-plumber', actorId: OWNER_ID })
    );
    expect(releaseBeforeSignOff.code).toBe('MILESTONE_NOT_SIGNED_OFF');
    expect(releaseBeforeSignOff.status).toBe(409);

    const unknownMilestone = await captureRejection(
      coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-ghost', actorId: OWNER_ID })
    );
    expect(unknownMilestone.code).toBe('MILESTONE_NOT_FOUND');
    expect(unknownMilestone.status).toBe(404);

    const unknownContractor = await captureRejection(
      coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-ghost', actorId: OWNER_ID })
    );
    expect(unknownContractor.code).toBe('UNKNOWN_CONTRACTOR');
    expect(unknownContractor.status).toBe(404);

    const unknownProject = await captureRejection(
      coordinator.releaseMilestone('proj-missing', { milestoneId: 'm-plumber', actorId: OWNER_ID })
    );
    expect(unknownProject.code).toBe('PROJECT_NOT_FOUND');
    expect(unknownProject.status).toBe(404);
  });

  it('surfaces the typed error code through the request adapter', async () => {
    const coordinator = createSeededCoordinator();

    const conflict = await handleRenovationRequest(coordinator, 'sign-off', {
      projectId: PROJECT_ID,
      contractorId: 'c-tiler',
      actorId: OWNER_ID
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('DEPENDENCY_NOT_SIGNED_OFF');

    const malformed = await handleRenovationRequest(coordinator, 'create-project', {
      projectId: '',
      ownerId: OWNER_ID,
      contractors: []
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('EMPTY_FIELD');
  });
});
