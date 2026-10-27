/**
 * SCENARIO_DEFECT_REGRESSION (regression) — reproduction of the reported defect.
 *
 * Issue #1020: parents could not coordinate multi-contractor scheduling and
 * payment milestones. The reported failure was that a later trade could be
 * treated as complete (and paid) while an earlier trade it depends on was still
 * open, so delays cascaded and money was released for unfinished work. This
 * suite reproduces that condition and asserts it is now resolved cleanly.
 */

import { RenovationCoordinator, RenovationError } from '../../renovation/renovationCoordinator';
import { createSeededCoordinator, OWNER_ID, PROJECT_ID, SEQUENCE, signOffAll } from './fixtures';

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

describe('SCENARIO_DEFECT_REGRESSION: coordination gaps no longer cascade or overpay', () => {
  it('reproduces the reported defect condition and confirms it is resolved', async () => {
    const coordinator = createSeededCoordinator();

    const earlySignOff = await captureRejection(
      coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-tiler', actorId: OWNER_ID })
    );
    expect(earlySignOff.code).toBe('DEPENDENCY_NOT_SIGNED_OFF');

    const earlyPayment = await captureRejection(
      coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-tiler', actorId: OWNER_ID })
    );
    expect(earlyPayment.code).toBe('MILESTONE_NOT_SIGNED_OFF');

    const summary = coordinator.summarize(PROJECT_ID);
    expect(summary.releasedTotalCents).toBe(0);
    expect(summary.nextActionableContractorId).toBe('c-plumber');
  });

  it('rejects a schedule that would start a dependent trade before its dependency completes', async () => {
    const coordinator = createSeededCoordinator();

    // The electrician finishes on day 7; the reported cascade is scheduling the
    // tiler to start on day 6, before the electrician has handed over.
    const cascade = await captureRejection(
      coordinator.scheduleContractor(PROJECT_ID, {
        contractorId: 'c-tiler',
        scheduledStartDay: 6,
        scheduledEndDay: 10
      })
    );
    expect(cascade.code).toBe('OUT_OF_RANGE');

    const tiler = coordinator.getProject(PROJECT_ID).contractors.find((contractor) => contractor.id === 'c-tiler');
    expect(tiler?.scheduledStartDay).toBe(8);
  });

  it('rejects a schedule gap beyond the coordination grace window', async () => {
    const coordinator = createSeededCoordinator();

    const stalled = await captureRejection(
      coordinator.scheduleContractor(PROJECT_ID, {
        contractorId: 'c-tiler',
        scheduledStartDay: 25,
        scheduledEndDay: 28
      })
    );
    expect(stalled.code).toBe('SCHEDULE_GRACE_EXCEEDED');
  });

  it('leaves project state unchanged after each rejected defect-path request', async () => {
    const coordinator = createSeededCoordinator();
    const before = JSON.stringify(coordinator.getProject(PROJECT_ID));

    await captureRejection(coordinator.signOffContractor(PROJECT_ID, { contractorId: 'c-decorator', actorId: OWNER_ID }));
    await captureRejection(coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-decorator', actorId: OWNER_ID }));
    await captureRejection(
      coordinator.scheduleContractor(PROJECT_ID, { contractorId: 'c-tiler', scheduledStartDay: 6, scheduledEndDay: 10 })
    );

    expect(JSON.stringify(coordinator.getProject(PROJECT_ID))).toBe(before);
  });

  it('completes cleanly once dependencies are signed off in order', async () => {
    const coordinator: RenovationCoordinator = createSeededCoordinator();
    await signOffAll(coordinator, SEQUENCE);

    const receipt = await coordinator.releaseMilestone(PROJECT_ID, { milestoneId: 'm-decorator', actorId: OWNER_ID });
    expect(receipt.milestoneId).toBe('m-decorator');
    expect(coordinator.summarize(PROJECT_ID).releasedTotalCents).toBe(80000);
  });
});
