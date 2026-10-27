/**
 * SCENARIO_NULL_INPUT (null), SCENARIO_EMPTY_INPUT (empty) and
 * SCENARIO_BOUNDARY_LIMIT (boundary) — companion boundary suite.
 *
 * Null/undefined arguments, empty strings, empty collections, whitespace-only
 * values and exact upper/lower bound values must be handled explicitly: no
 * unhandled crash, no silent state corruption, and the half-open schedule grace
 * window is evaluated strictly.
 */

import {
  MAX_CONTRACTORS,
  MAX_MILESTONE_AMOUNT_CENTS,
  MAX_SCHEDULE_DAY,
  RenovationCoordinator,
  RenovationError,
  SCHEDULE_GRACE_DAYS,
  buildProject,
  handleRenovationRequest
} from '../../renovation/renovationCoordinator';
import { createSeededCoordinator, OWNER_ID, PROJECT_ID } from './fixtures';

function captureError(fn: () => unknown): RenovationError {
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

function singleContractorInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'proj-single',
    ownerId: OWNER_ID,
    contractors: [
      { id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1, dependsOn: [], ...overrides }
    ]
  };
}

function twoTradeChain(dependencyEnd: number, dependentStart: number): Record<string, unknown> {
  return {
    projectId: 'proj-pair',
    ownerId: OWNER_ID,
    contractors: [
      { id: 'c-one', trade: 'plumber', scheduledStartDay: 0, scheduledEndDay: dependencyEnd, dependsOn: [] },
      { id: 'c-two', trade: 'tiler', scheduledStartDay: dependentStart, scheduledEndDay: dependentStart + 1, dependsOn: ['c-one'] }
    ]
  };
}

describe('SCENARIO_NULL_INPUT: null/undefined arguments are rejected gracefully', () => {
  it('rejects null and undefined project payloads with a typed INVALID_INPUT error', () => {
    const coordinator = new RenovationCoordinator();
    const nullError = captureError(() => coordinator.createProject(null));
    expect(nullError.code).toBe('INVALID_INPUT');
    expect(nullError.status).toBe(400);
    expect(captureError(() => coordinator.createProject(undefined)).code).toBe('INVALID_INPUT');
  });

  it('rejects null required fields with MISSING_FIELD', () => {
    expect(captureError(() => buildProject({ projectId: null, ownerId: OWNER_ID, contractors: [] })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildProject({ projectId: PROJECT_ID, ownerId: null, contractors: [] })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildProject({ projectId: PROJECT_ID, ownerId: OWNER_ID, contractors: null })).code).toBe('MISSING_FIELD');
    expect(captureError(() => buildProject(singleContractorInput({ scheduledStartDay: null }))).code).toBe('MISSING_FIELD');
    expect(
      captureError(() =>
        buildProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }],
          milestones: [{ id: 'm-only', contractorId: 'c-only', amountCents: null }]
        })
      ).code
    ).toBe('MISSING_FIELD');
  });

  it('treats omitted optional collections as empty rather than crashing', () => {
    const project = buildProject({
      projectId: 'proj-optional',
      ownerId: OWNER_ID,
      contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }]
    });
    expect(project.milestones).toEqual([]);
    expect(project.contractors[0].dependsOn).toEqual([]);
  });

  it('rejects null operation payloads against an existing project', async () => {
    const coordinator = createSeededCoordinator();
    expect(coordinator.summarize(PROJECT_ID).projectId).toBe(PROJECT_ID);
    expect(await captureRejection(coordinator.signOffContractor(PROJECT_ID, null))).toBeInstanceOf(RenovationError);
    expect((await captureRejection(coordinator.releaseMilestone(PROJECT_ID, undefined))).code).toBe('INVALID_INPUT');
    expect((await captureRejection(coordinator.scheduleContractor(PROJECT_ID, null))).code).toBe('INVALID_INPUT');
  });
});

describe('SCENARIO_EMPTY_INPUT: empty and whitespace-only values are rejected with diagnostics', () => {
  it('rejects empty and whitespace-only string identifiers', () => {
    expect(captureError(() => buildProject({ projectId: '', ownerId: OWNER_ID, contractors: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildProject({ projectId: '   ', ownerId: OWNER_ID, contractors: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildProject({ projectId: PROJECT_ID, ownerId: '\t', contractors: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildProject(singleContractorInput({ id: '' }))).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildProject(singleContractorInput({ trade: '   ' }))).code).toBe('EMPTY_FIELD');
  });

  it('rejects empty collections and empty nested entries', () => {
    expect(captureError(() => buildProject({ projectId: PROJECT_ID, ownerId: OWNER_ID, contractors: [] })).code).toBe('EMPTY_FIELD');
    expect(captureError(() => buildProject(singleContractorInput({ dependsOn: ['   '] }))).code).toBe('EMPTY_FIELD');
    expect(
      captureError(() =>
        buildProject({
          projectId: PROJECT_ID,
          ownerId: OWNER_ID,
          contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }],
          milestones: [{ id: '   ', contractorId: 'c-only', amountCents: 10 }]
        })
      ).code
    ).toBe('EMPTY_FIELD');
  });

  it('leaves existing project state untouched after a rejected empty payload', async () => {
    const coordinator = createSeededCoordinator();
    const before = JSON.stringify(coordinator.getProject(PROJECT_ID));
    const rejection = await captureRejection(
      coordinator.releaseMilestone(PROJECT_ID, { milestoneId: '   ', actorId: OWNER_ID })
    );
    expect(rejection.code).toBe('EMPTY_FIELD');
    expect(JSON.stringify(coordinator.getProject(PROJECT_ID))).toBe(before);
  });
});

describe('SCENARIO_BOUNDARY_LIMIT: exact bounds are evaluated strictly', () => {
  it('accepts 1 contractor and the maximum of 12, and rejects 13', () => {
    expect(buildProject(singleContractorInput()).contractors).toHaveLength(1);

    const many = Array.from({ length: MAX_CONTRACTORS }, (_, index) => ({
      id: `c-${index}`,
      trade: 'trade',
      scheduledStartDay: index * 2,
      scheduledEndDay: index * 2 + 1,
      dependsOn: index === 0 ? [] : [`c-${index - 1}`]
    }));
    expect(buildProject({ projectId: 'proj-max', ownerId: OWNER_ID, contractors: many }).contractors).toHaveLength(MAX_CONTRACTORS);

    const tooMany = [...many, { id: 'c-extra', trade: 'trade', scheduledStartDay: 40, scheduledEndDay: 41, dependsOn: [] }];
    expect(captureError(() => buildProject({ projectId: 'proj-too-many', ownerId: OWNER_ID, contractors: tooMany })).code).toBe('OUT_OF_RANGE');
  });

  it('accepts the minimum (1 cent) and maximum milestone amounts, and rejects 0 and max+1', () => {
    const withAmount = (amountCents: number) =>
      buildProject({
        projectId: 'proj-amount',
        ownerId: OWNER_ID,
        contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: 0, scheduledEndDay: 1 }],
        milestones: [{ id: 'm-only', contractorId: 'c-only', amountCents }]
      });

    expect(withAmount(1).milestones[0].amountCents).toBe(1);
    expect(withAmount(MAX_MILESTONE_AMOUNT_CENTS).milestones[0].amountCents).toBe(MAX_MILESTONE_AMOUNT_CENTS);
    expect(captureError(() => withAmount(0)).code).toBe('OUT_OF_RANGE');
    expect(captureError(() => withAmount(MAX_MILESTONE_AMOUNT_CENTS + 1)).code).toBe('OUT_OF_RANGE');
  });

  it('accepts schedule day bounds 0 and MAX, and rejects -1 and MAX+1', () => {
    const onDay = (day: number) =>
      buildProject({
        projectId: 'proj-day',
        ownerId: OWNER_ID,
        contractors: [{ id: 'c-only', trade: 'decorator', scheduledStartDay: day, scheduledEndDay: day }]
      });

    expect(onDay(0).contractors[0].scheduledStartDay).toBe(0);
    expect(onDay(MAX_SCHEDULE_DAY).contractors[0].scheduledEndDay).toBe(MAX_SCHEDULE_DAY);
    expect(captureError(() => onDay(-1)).code).toBe('OUT_OF_RANGE');
    expect(captureError(() => onDay(MAX_SCHEDULE_DAY + 1)).code).toBe('OUT_OF_RANGE');
  });

  it('evaluates the half-open coordination grace window strictly at the threshold', () => {
    const dependencyEnd = 10;
    expect(buildProject(twoTradeChain(dependencyEnd, dependencyEnd)).contractors).toHaveLength(2);
    expect(buildProject(twoTradeChain(dependencyEnd, dependencyEnd + SCHEDULE_GRACE_DAYS - 1)).contractors).toHaveLength(2);
    expect(captureError(() => buildProject(twoTradeChain(dependencyEnd, dependencyEnd + SCHEDULE_GRACE_DAYS))).code).toBe('SCHEDULE_GRACE_EXCEEDED');
    expect(captureError(() => buildProject(twoTradeChain(dependencyEnd, dependencyEnd - 1))).code).toBe('OUT_OF_RANGE');
  });

  it('rejects a whitespace-only action with a 400 diagnostic', async () => {
    const response = await handleRenovationRequest(new RenovationCoordinator(), '   ', {});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_INPUT');
  });
});
