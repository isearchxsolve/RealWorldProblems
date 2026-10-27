import { RenovationCoordinator, RenovationProject } from '../../renovation/renovationCoordinator';

/** Shared fixtures for the home renovation coordination scenario suites (#1020). */

export const OWNER_ID = 'owner-1020';
export const PROJECT_ID = 'proj-1020';

export type ContractorFixture = {
  id: string;
  trade: string;
  scheduledStartDay: number;
  scheduledEndDay: number;
  dependsOn: string[];
};

export type MilestoneFixture = { id: string; contractorId: string; amountCents: number };

/**
 * A realistic kitchen/bathroom renovation: plumber -> electrician -> tiler ->
 * decorator, with each dependent trade starting one day after its dependency
 * finishes (inside the coordination grace window).
 */
export const BASE_CONTRACTORS: ContractorFixture[] = [
  { id: 'c-plumber', trade: 'plumber', scheduledStartDay: 0, scheduledEndDay: 3, dependsOn: [] },
  { id: 'c-electrician', trade: 'electrician', scheduledStartDay: 4, scheduledEndDay: 7, dependsOn: ['c-plumber'] },
  { id: 'c-tiler', trade: 'tiler', scheduledStartDay: 8, scheduledEndDay: 11, dependsOn: ['c-electrician'] },
  { id: 'c-decorator', trade: 'decorator', scheduledStartDay: 12, scheduledEndDay: 15, dependsOn: ['c-tiler'] }
];

export const BASE_MILESTONES: MilestoneFixture[] = [
  { id: 'm-plumber', contractorId: 'c-plumber', amountCents: 150000 },
  { id: 'm-electrician', contractorId: 'c-electrician', amountCents: 120000 },
  { id: 'm-tiler', contractorId: 'c-tiler', amountCents: 90000 },
  { id: 'm-decorator', contractorId: 'c-decorator', amountCents: 80000 }
];

export const BASE_TOTAL_CENTS = 440000;

export const SEQUENCE = ['c-plumber', 'c-electrician', 'c-tiler', 'c-decorator'];
export const MILESTONE_SEQUENCE = ['m-plumber', 'm-electrician', 'm-tiler', 'm-decorator'];

export function baseProjectInput(): {
  projectId: string;
  ownerId: string;
  contractors: ContractorFixture[];
  milestones: MilestoneFixture[];
} {
  return {
    projectId: PROJECT_ID,
    ownerId: OWNER_ID,
    contractors: BASE_CONTRACTORS.map((contractor) => ({ ...contractor, dependsOn: [...contractor.dependsOn] })),
    milestones: BASE_MILESTONES.map((milestone) => ({ ...milestone }))
  };
}

export function createSeededCoordinator(): RenovationCoordinator {
  const coordinator = new RenovationCoordinator();
  coordinator.createProject(baseProjectInput());
  return coordinator;
}

export async function signOffAll(
  coordinator: RenovationCoordinator,
  order: string[] = SEQUENCE
): Promise<RenovationProject> {
  let project = coordinator.getProject(PROJECT_ID);
  for (const contractorId of order) {
    project = await coordinator.signOffContractor(PROJECT_ID, { contractorId, actorId: OWNER_ID });
  }
  return project;
}
