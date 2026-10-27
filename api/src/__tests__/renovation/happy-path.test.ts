/**
 * SCENARIO_HAPPY_PATH (happy_path)
 *
 * Valid inputs per specification: a parent coordinates a four-trade renovation
 * end to end. The core business path — create project, follow the dependency
 * sequence, release each payment milestone once — completes with a success
 * (200) result and the expected state transition.
 */

import { handleRenovationRequest, RenovationCoordinator } from '../../renovation/renovationCoordinator';
import {
  BASE_TOTAL_CENTS,
  baseProjectInput,
  createSeededCoordinator,
  MILESTONE_SEQUENCE,
  OWNER_ID,
  PROJECT_ID,
  SEQUENCE
} from './fixtures';

describe('SCENARIO_HAPPY_PATH: multi-contractor renovation coordination', () => {
  it('creates the project and exposes the full trade/milestone state without loss', () => {
    const coordinator = new RenovationCoordinator();
    const project = coordinator.createProject(baseProjectInput());

    expect(project.projectId).toBe(PROJECT_ID);
    expect(project.ownerId).toBe(OWNER_ID);
    expect(project.contractors.map((contractor) => contractor.id)).toEqual(SEQUENCE);
    expect(project.contractors.every((contractor) => contractor.signedOff === false)).toBe(true);
    expect(project.milestones.map((milestone) => milestone.id)).toEqual(MILESTONE_SEQUENCE);
    expect(project.milestones.every((milestone) => milestone.released === false)).toBe(true);
  });

  it('walks the dependency sequence and releases every milestone exactly once', async () => {
    const coordinator = createSeededCoordinator();

    const initialSummary = coordinator.summarize(PROJECT_ID);
    expect(initialSummary.releasedTotalCents).toBe(0);
    expect(initialSummary.pendingTotalCents).toBe(BASE_TOTAL_CENTS);
    expect(initialSummary.nextActionableContractorId).toBe('c-plumber');

    for (const contractorId of SEQUENCE) {
      const project = await coordinator.signOffContractor(PROJECT_ID, { contractorId, actorId: OWNER_ID });
      expect(project.contractors.find((contractor) => contractor.id === contractorId)?.signedOff).toBe(true);
    }

    const receipts = [];
    for (const milestoneId of MILESTONE_SEQUENCE) {
      const receipt = await coordinator.releaseMilestone(PROJECT_ID, { milestoneId, actorId: OWNER_ID });
      receipts.push(receipt);
      expect(receipt.projectId).toBe(PROJECT_ID);
      expect(receipt.amountCents).toBeGreaterThan(0);
    }
    expect(receipts.map((receipt) => receipt.milestoneId)).toEqual(MILESTONE_SEQUENCE);

    const finalSummary = coordinator.summarize(PROJECT_ID);
    expect(finalSummary.releasedTotalCents).toBe(BASE_TOTAL_CENTS);
    expect(finalSummary.pendingTotalCents).toBe(0);
    expect(finalSummary.releasedMilestoneIds).toEqual(MILESTONE_SEQUENCE);
    expect(finalSummary.nextActionableContractorId).toBeNull();
  });

  it('returns a 200 success response through the request adapter and applies the state transition', async () => {
    const coordinator = new RenovationCoordinator();

    const createResponse = await handleRenovationRequest(coordinator, 'create-project', baseProjectInput());
    expect(createResponse.status).toBe(200);
    expect(createResponse.body.ok).toBe(true);

    const signOffResponse = await handleRenovationRequest(coordinator, 'sign-off', {
      projectId: PROJECT_ID,
      contractorId: 'c-plumber',
      actorId: OWNER_ID
    });
    expect(signOffResponse.status).toBe(200);
    expect(signOffResponse.body.ok).toBe(true);

    const releaseResponse = await handleRenovationRequest(coordinator, 'release-milestone', {
      projectId: PROJECT_ID,
      milestoneId: 'm-plumber',
      actorId: OWNER_ID
    });
    expect(releaseResponse.status).toBe(200);
    expect(releaseResponse.body.ok).toBe(true);

    const summaryResponse = await handleRenovationRequest(coordinator, 'summarize', { projectId: PROJECT_ID });
    expect(summaryResponse.status).toBe(200);
    const summary = summaryResponse.body.summary as { releasedTotalCents: number; pendingTotalCents: number };
    expect(summary.releasedTotalCents).toBe(150000);
    expect(summary.pendingTotalCents).toBe(BASE_TOTAL_CENTS - 150000);
  });
});
