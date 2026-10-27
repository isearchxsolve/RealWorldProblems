/**
 * Home renovation coordination domain module.
 *
 * Models the real-world problem tracked in muaddibco/RealWorldProblems#1020:
 * a household managing a multi-trade renovation (plumber, electrician, tiler,
 * decorator) needs one place to track each contractor's scheduled window, the
 * dependency sequence between trades, the payment milestones attached to each
 * contractor and the sign-off status of completed work, so the project does not
 * stall or overrun because of coordination gaps between trades.
 *
 * The module is deliberately framework-free (no Azure Functions runtime, no
 * network or storage I/O) so it can be unit tested and reused by the portal API
 * and by the orchestrator:
 *
 *  - strict, typed validation for every input; null, undefined, whitespace-only,
 *    malformed and out-of-range values are rejected with a `RenovationError`
 *    carrying a stable `code` and an HTTP `status`;
 *  - a half-open schedule grace window between a dependency finishing and the
 *    dependent trade starting, so a cascade of late trades is detected before it
 *    is committed;
 *  - atomic, single-writer transitions so a payment milestone can never be
 *    released twice (zero double spend) even when callers act concurrently.
 */

/** Maximum number of trades (contractors) a single project may coordinate. */
export const MAX_CONTRACTORS = 12;

/** Maximum value of a single payment milestone, in cents ($1,000,000.00). */
export const MAX_MILESTONE_AMOUNT_CENTS = 100_000_000;

/**
 * Coordination grace window, in days, allowed between the day a dependency is
 * scheduled to finish and the day the dependent trade is scheduled to start.
 *
 * The window is half-open: a gap of `>= 0` and `< SCHEDULE_GRACE_DAYS` is
 * accepted. A gap of exactly `SCHEDULE_GRACE_DAYS` is rejected.
 */
export const SCHEDULE_GRACE_DAYS = 14;

/** Inclusive upper bound, in days from project start, for a scheduled window. */
export const MAX_SCHEDULE_DAY = 3650;

export type RenovationErrorCode =
  | 'INVALID_INPUT'
  | 'MISSING_FIELD'
  | 'EMPTY_FIELD'
  | 'OUT_OF_RANGE'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_CONTRACTOR'
  | 'DEPENDENCY_NOT_SIGNED_OFF'
  | 'SCHEDULE_GRACE_EXCEEDED'
  | 'MILESTONE_NOT_FOUND'
  | 'MILESTONE_ALREADY_RELEASED'
  | 'MILESTONE_NOT_SIGNED_OFF'
  | 'UNAUTHORIZED_ACTOR'
  | 'PROJECT_NOT_FOUND';

/** Typed, stable error surfaced by every coordinator operation. */
export class RenovationError extends Error {
  readonly code: RenovationErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: RenovationErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'RenovationError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, RenovationError.prototype);
  }
}

export type Contractor = {
  id: string;
  trade: string;
  dependsOn: string[];
  scheduledStartDay: number;
  scheduledEndDay: number;
  signedOff: boolean;
};

export type Milestone = {
  id: string;
  contractorId: string;
  amountCents: number;
  released: boolean;
};

export type RenovationProject = {
  projectId: string;
  ownerId: string;
  contractors: Contractor[];
  milestones: Milestone[];
  createdAt: string;
};

export type ProjectSummary = {
  projectId: string;
  contractorCount: number;
  milestoneCount: number;
  releasedMilestoneIds: string[];
  releasedTotalCents: number;
  pendingTotalCents: number;
  nextActionableContractorId: string | null;
};

export type MilestoneReceipt = {
  projectId: string;
  milestoneId: string;
  contractorId: string;
  amountCents: number;
  releasedAt: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a required, non-blank string field. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new RenovationError('MISSING_FIELD', `Field '${field}' is required.`, 400, { field });
  }
  if (typeof value !== 'string') {
    throw new RenovationError('INVALID_INPUT', `Field '${field}' must be a string.`, 400, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RenovationError('EMPTY_FIELD', `Field '${field}' must not be empty or whitespace-only.`, 400, { field });
  }
  return trimmed;
}

/** Validates a required integer inside the inclusive range [min, max]. */
export function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (value === undefined || value === null) {
    throw new RenovationError('MISSING_FIELD', `Field '${field}' is required.`, 400, { field });
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RenovationError('INVALID_INPUT', `Field '${field}' must be an integer.`, 400, { field });
  }
  if (value < min || value > max) {
    throw new RenovationError(
      'OUT_OF_RANGE',
      `Field '${field}' must be between ${min} and ${max} (received ${value}).`,
      400,
      { field, value, min, max }
    );
  }
  return value;
}

function normalizeDependsOn(value: unknown, contractorId: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RenovationError('INVALID_INPUT', `Contractor '${contractorId}' dependsOn must be an array.`, 400, { contractorId });
  }
  const result: string[] = [];
  for (const item of value) {
    const dependencyId = requireNonEmptyString(item, `contractors[${contractorId}].dependsOn`);
    if (!result.includes(dependencyId)) {
      result.push(dependencyId);
    }
  }
  return result;
}

function detectDependencyCycle(contractors: Contractor[]): void {
  const byId = new Map(contractors.map((contractor) => [contractor.id, contractor]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') {
      return;
    }
    if (current === 'visiting') {
      throw new RenovationError(
        'INVALID_INPUT',
        `Dependency cycle detected: ${[...trail, id].join(' -> ')}.`,
        400,
        { cycle: [...trail, id] }
      );
    }
    state.set(id, 'visiting');
    const contractor = byId.get(id);
    if (contractor) {
      for (const dependencyId of contractor.dependsOn) {
        visit(dependencyId, [...trail, id]);
      }
    }
    state.set(id, 'done');
  };

  for (const contractor of contractors) {
    visit(contractor.id, []);
  }
}

function validateSchedule(contractors: Contractor[]): void {
  const byId = new Map(contractors.map((contractor) => [contractor.id, contractor]));
  for (const contractor of contractors) {
    for (const dependencyId of contractor.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new RenovationError(
          'UNKNOWN_CONTRACTOR',
          `Contractor '${contractor.id}' depends on unknown contractor '${dependencyId}'.`,
          404,
          { contractorId: contractor.id, dependencyId }
        );
      }
      const gapDays = contractor.scheduledStartDay - dependency.scheduledEndDay;
      if (gapDays < 0) {
        throw new RenovationError(
          'OUT_OF_RANGE',
          `Contractor '${contractor.id}' is scheduled to start before dependency '${dependencyId}' completes.`,
          409,
          { contractorId: contractor.id, dependencyId, gapDays }
        );
      }
      if (gapDays >= SCHEDULE_GRACE_DAYS) {
        throw new RenovationError(
          'SCHEDULE_GRACE_EXCEEDED',
          `Contractor '${contractor.id}' starts ${gapDays} days after dependency '${dependencyId}' completes, exceeding the ${SCHEDULE_GRACE_DAYS}-day coordination grace window.`,
          409,
          { contractorId: contractor.id, dependencyId, gapDays, graceDays: SCHEDULE_GRACE_DAYS }
        );
      }
    }
  }
}

function cloneProject(project: RenovationProject): RenovationProject {
  return {
    projectId: project.projectId,
    ownerId: project.ownerId,
    createdAt: project.createdAt,
    contractors: project.contractors.map((contractor) => ({
      id: contractor.id,
      trade: contractor.trade,
      dependsOn: [...contractor.dependsOn],
      scheduledStartDay: contractor.scheduledStartDay,
      scheduledEndDay: contractor.scheduledEndDay,
      signedOff: contractor.signedOff
    })),
    milestones: project.milestones.map((milestone) => ({ ...milestone }))
  };
}

/**
 * Validates an untrusted payload and builds a brand new project aggregate.
 * Throws a typed `RenovationError` for any null, empty, malformed or
 * out-of-range input; never returns a partially built project.
 */
export function buildProject(input: unknown): RenovationProject {
  if (input === undefined || input === null) {
    throw new RenovationError('INVALID_INPUT', 'Project payload is required.', 400);
  }
  if (!isPlainObject(input)) {
    throw new RenovationError('INVALID_INPUT', 'Project payload must be an object.', 400);
  }

  const projectId = requireNonEmptyString(input.projectId, 'projectId');
  const ownerId = requireNonEmptyString(input.ownerId, 'ownerId');

  const rawContractors = input.contractors;
  if (rawContractors === undefined || rawContractors === null) {
    throw new RenovationError('MISSING_FIELD', "Field 'contractors' is required.", 400, { field: 'contractors' });
  }
  if (!Array.isArray(rawContractors)) {
    throw new RenovationError('INVALID_INPUT', "Field 'contractors' must be an array.", 400, { field: 'contractors' });
  }
  if (rawContractors.length === 0) {
    throw new RenovationError('EMPTY_FIELD', 'Project must include at least one contractor.', 400, { field: 'contractors' });
  }
  if (rawContractors.length > MAX_CONTRACTORS) {
    throw new RenovationError(
      'OUT_OF_RANGE',
      `Project may include at most ${MAX_CONTRACTORS} contractors (received ${rawContractors.length}).`,
      400,
      { field: 'contractors', max: MAX_CONTRACTORS, received: rawContractors.length }
    );
  }

  const contractors: Contractor[] = [];
  const contractorIds = new Set<string>();
  const rawContractorList = rawContractors as unknown[];

  for (let index = 0; index < rawContractorList.length; index += 1) {
    const raw = rawContractorList[index];
    if (!isPlainObject(raw)) {
      throw new RenovationError('INVALID_INPUT', `Contractor at index ${index} must be an object.`, 400, { index });
    }
    const id = requireNonEmptyString(raw.id, `contractors[${index}].id`);
    if (contractorIds.has(id)) {
      throw new RenovationError('DUPLICATE_ID', `Duplicate contractor id '${id}'.`, 409, { id });
    }
    contractorIds.add(id);

    const trade = requireNonEmptyString(raw.trade, `contractors[${index}].trade`);
    const scheduledStartDay = requireIntegerInRange(raw.scheduledStartDay, `contractors[${index}].scheduledStartDay`, 0, MAX_SCHEDULE_DAY);
    const scheduledEndDay = requireIntegerInRange(raw.scheduledEndDay, `contractors[${index}].scheduledEndDay`, 0, MAX_SCHEDULE_DAY);
    if (scheduledEndDay < scheduledStartDay) {
      throw new RenovationError(
        'OUT_OF_RANGE',
        `Contractor '${id}' scheduledEndDay must be greater than or equal to scheduledStartDay.`,
        400,
        { id, scheduledStartDay, scheduledEndDay }
      );
    }

    const dependsOn = normalizeDependsOn(raw.dependsOn, id);
    if (dependsOn.includes(id)) {
      throw new RenovationError('INVALID_INPUT', `Contractor '${id}' cannot depend on itself.`, 400, { id });
    }

    contractors.push({
      id,
      trade,
      dependsOn,
      scheduledStartDay,
      scheduledEndDay,
      signedOff: raw.signedOff === true
    });
  }

  for (const contractor of contractors) {
    for (const dependencyId of contractor.dependsOn) {
      if (!contractorIds.has(dependencyId)) {
        throw new RenovationError(
          'UNKNOWN_CONTRACTOR',
          `Contractor '${contractor.id}' depends on unknown contractor '${dependencyId}'.`,
          404,
          { contractorId: contractor.id, dependencyId }
        );
      }
    }
  }

  detectDependencyCycle(contractors);
  validateSchedule(contractors);

  const rawMilestones = input.milestones === undefined || input.milestones === null ? [] : input.milestones;
  if (!Array.isArray(rawMilestones)) {
    throw new RenovationError('INVALID_INPUT', "Field 'milestones' must be an array.", 400, { field: 'milestones' });
  }

  const milestones: Milestone[] = [];
  const milestoneIds = new Set<string>();
  const rawMilestoneList = rawMilestones as unknown[];

  for (let index = 0; index < rawMilestoneList.length; index += 1) {
    const raw = rawMilestoneList[index];
    if (!isPlainObject(raw)) {
      throw new RenovationError('INVALID_INPUT', `Milestone at index ${index} must be an object.`, 400, { index });
    }
    const id = requireNonEmptyString(raw.id, `milestones[${index}].id`);
    if (milestoneIds.has(id)) {
      throw new RenovationError('DUPLICATE_ID', `Duplicate milestone id '${id}'.`, 409, { id });
    }
    milestoneIds.add(id);

    const contractorId = requireNonEmptyString(raw.contractorId, `milestones[${index}].contractorId`);
    if (!contractorIds.has(contractorId)) {
      throw new RenovationError(
        'UNKNOWN_CONTRACTOR',
        `Milestone '${id}' references unknown contractor '${contractorId}'.`,
        404,
        { milestoneId: id, contractorId }
      );
    }
    const amountCents = requireIntegerInRange(raw.amountCents, `milestones[${index}].amountCents`, 1, MAX_MILESTONE_AMOUNT_CENTS);
    milestones.push({ id, contractorId, amountCents, released: false });
  }

  return {
    projectId,
    ownerId,
    contractors,
    milestones,
    createdAt: new Date().toISOString()
  };
}

/** Applies a schedule change to a copy of the project, re-validating the whole chain. */
export function applyScheduleChange(project: RenovationProject, input: unknown): RenovationProject {
  if (!isPlainObject(input)) {
    throw new RenovationError('INVALID_INPUT', 'Schedule update payload must be an object.', 400);
  }
  const contractorId = requireNonEmptyString(input.contractorId, 'contractorId');
  const scheduledStartDay = requireIntegerInRange(input.scheduledStartDay, 'scheduledStartDay', 0, MAX_SCHEDULE_DAY);
  const scheduledEndDay = requireIntegerInRange(input.scheduledEndDay, 'scheduledEndDay', 0, MAX_SCHEDULE_DAY);
  if (scheduledEndDay < scheduledStartDay) {
    throw new RenovationError(
      'OUT_OF_RANGE',
      `Contractor '${contractorId}' scheduledEndDay must be greater than or equal to scheduledStartDay.`,
      400,
      { contractorId, scheduledStartDay, scheduledEndDay }
    );
  }

  const next = cloneProject(project);
  const target = next.contractors.find((contractor) => contractor.id === contractorId);
  if (!target) {
    throw new RenovationError('UNKNOWN_CONTRACTOR', `Unknown contractor '${contractorId}'.`, 404, { contractorId });
  }
  if (target.signedOff) {
    throw new RenovationError('INVALID_INPUT', `Cannot reschedule contractor '${contractorId}' after sign-off.`, 409, { contractorId });
  }

  target.scheduledStartDay = scheduledStartDay;
  target.scheduledEndDay = scheduledEndDay;
  validateSchedule(next.contractors);
  return next;
}

/** Marks a contractor's work as signed off, enforcing the dependency sequence. */
export function applySignOff(project: RenovationProject, input: unknown): RenovationProject {
  if (!isPlainObject(input)) {
    throw new RenovationError('INVALID_INPUT', 'Sign-off payload must be an object.', 400);
  }
  const contractorId = requireNonEmptyString(input.contractorId, 'contractorId');
  const actorId = requireNonEmptyString(input.actorId, 'actorId');
  if (actorId !== project.ownerId) {
    throw new RenovationError(
      'UNAUTHORIZED_ACTOR',
      `Actor '${actorId}' is not authorized to sign off work for project '${project.projectId}'.`,
      403,
      { actorId }
    );
  }

  const next = cloneProject(project);
  const target = next.contractors.find((contractor) => contractor.id === contractorId);
  if (!target) {
    throw new RenovationError('UNKNOWN_CONTRACTOR', `Unknown contractor '${contractorId}'.`, 404, { contractorId });
  }
  if (target.signedOff) {
    throw new RenovationError('INVALID_INPUT', `Contractor '${contractorId}' is already signed off.`, 409, { contractorId });
  }

  for (const dependencyId of target.dependsOn) {
    const dependency = next.contractors.find((contractor) => contractor.id === dependencyId);
    if (!dependency || !dependency.signedOff) {
      throw new RenovationError(
        'DEPENDENCY_NOT_SIGNED_OFF',
        `Cannot sign off '${contractorId}' before dependency '${dependencyId}' is signed off.`,
        409,
        { contractorId, dependencyId }
      );
    }
  }

  target.signedOff = true;
  return next;
}

/** Releases a payment milestone exactly once, requiring contractor sign-off. */
export function applyMilestoneRelease(
  project: RenovationProject,
  input: unknown
): { project: RenovationProject; milestone: Milestone } {
  if (!isPlainObject(input)) {
    throw new RenovationError('INVALID_INPUT', 'Milestone release payload must be an object.', 400);
  }
  const milestoneId = requireNonEmptyString(input.milestoneId, 'milestoneId');
  const actorId = requireNonEmptyString(input.actorId, 'actorId');
  if (actorId !== project.ownerId) {
    throw new RenovationError(
      'UNAUTHORIZED_ACTOR',
      `Actor '${actorId}' is not authorized to release milestones for project '${project.projectId}'.`,
      403,
      { actorId }
    );
  }

  const next = cloneProject(project);
  const milestone = next.milestones.find((entry) => entry.id === milestoneId);
  if (!milestone) {
    throw new RenovationError('MILESTONE_NOT_FOUND', `Unknown milestone '${milestoneId}'.`, 404, { milestoneId });
  }
  if (milestone.released) {
    throw new RenovationError('MILESTONE_ALREADY_RELEASED', `Milestone '${milestoneId}' has already been released.`, 409, {
      milestoneId
    });
  }

  const contractor = next.contractors.find((entry) => entry.id === milestone.contractorId);
  if (!contractor || !contractor.signedOff) {
    throw new RenovationError(
      'MILESTONE_NOT_SIGNED_OFF',
      `Milestone '${milestoneId}' cannot be released before contractor '${milestone.contractorId}' is signed off.`,
      409,
      { milestoneId, contractorId: milestone.contractorId }
    );
  }

  milestone.released = true;
  return { project: next, milestone };
}

export function summarizeProject(project: RenovationProject): ProjectSummary {
  const released = project.milestones.filter((milestone) => milestone.released);
  const releasedTotalCents = released.reduce((total, milestone) => total + milestone.amountCents, 0);
  const pendingTotalCents = project.milestones.reduce((total, milestone) => total + milestone.amountCents, 0) - releasedTotalCents;

  const nextActionable = project.contractors
    .filter((contractor) => !contractor.signedOff)
    .filter((contractor) =>
      contractor.dependsOn.every((dependencyId) => {
        const dependency = project.contractors.find((entry) => entry.id === dependencyId);
        return dependency !== undefined && dependency.signedOff;
      })
    )
    .sort((a, b) => a.scheduledStartDay - b.scheduledStartDay || a.id.localeCompare(b.id))[0];

  return {
    projectId: project.projectId,
    contractorCount: project.contractors.length,
    milestoneCount: project.milestones.length,
    releasedMilestoneIds: released.map((milestone) => milestone.id),
    releasedTotalCents,
    pendingTotalCents,
    nextActionableContractorId: nextActionable ? nextActionable.id : null
  };
}

/**
 * In-memory, single-writer coordinator.
 *
 * Every mutation is serialized per project with a lightweight promise mutex, so
 * two concurrent requests against the same milestone result in exactly one
 * release and a safe rejection for the loser (no double spend).
 */
export class RenovationCoordinator {
  private readonly projects = new Map<string, RenovationProject>();
  private readonly locks = new Map<string, Promise<void>>();

  createProject(input: unknown): RenovationProject {
    const project = buildProject(input);
    if (this.projects.has(project.projectId)) {
      throw new RenovationError('DUPLICATE_ID', `Project '${project.projectId}' already exists.`, 409, { projectId: project.projectId });
    }
    this.projects.set(project.projectId, project);
    return cloneProject(project);
  }

  getProject(projectId: string): RenovationProject {
    return cloneProject(this.requireProject(requireNonEmptyString(projectId, 'projectId')));
  }

  hasProject(projectId: string): boolean {
    return typeof projectId === 'string' && this.projects.has(projectId);
  }

  summarize(projectId: string): ProjectSummary {
    return summarizeProject(this.requireProject(requireNonEmptyString(projectId, 'projectId')));
  }

  async scheduleContractor(projectId: string, input: unknown): Promise<RenovationProject> {
    const id = requireNonEmptyString(projectId, 'projectId');
    return this.withLock(id, () => {
      const next = applyScheduleChange(this.requireProject(id), input);
      this.projects.set(id, next);
      return cloneProject(next);
    });
  }

  async signOffContractor(projectId: string, input: unknown): Promise<RenovationProject> {
    const id = requireNonEmptyString(projectId, 'projectId');
    return this.withLock(id, () => {
      const next = applySignOff(this.requireProject(id), input);
      this.projects.set(id, next);
      return cloneProject(next);
    });
  }

  async releaseMilestone(projectId: string, input: unknown): Promise<MilestoneReceipt> {
    const id = requireNonEmptyString(projectId, 'projectId');
    return this.withLock(id, () => {
      const { project: next, milestone } = applyMilestoneRelease(this.requireProject(id), input);
      this.projects.set(id, next);
      return {
        projectId: id,
        milestoneId: milestone.id,
        contractorId: milestone.contractorId,
        amountCents: milestone.amountCents,
        releasedAt: new Date().toISOString()
      };
    });
  }

  private requireProject(projectId: string): RenovationProject {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new RenovationError('PROJECT_NOT_FOUND', `Project '${projectId}' was not found.`, 404, { projectId });
    }
    return project;
  }

  private async withLock<T>(key: string, operation: () => T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.locks.set(key, chained);
    await previous;
    try {
      return operation();
    } finally {
      release();
      if (this.locks.get(key) === chained) {
        this.locks.delete(key);
      }
    }
  }
}

export type RenovationHttpResponse = { status: number; body: Record<string, unknown> };

/**
 * Thin request adapter used by the portal API surface and by the scenario tests.
 * Returns an explicit status code so callers can distinguish success from typed
 * validation, authorization, conflict and not-found failures.
 */
export async function handleRenovationRequest(
  coordinator: RenovationCoordinator,
  action: string,
  payload: unknown
): Promise<RenovationHttpResponse> {
  try {
    if (typeof action !== 'string' || action.trim().length === 0) {
      throw new RenovationError('INVALID_INPUT', 'An action name is required.', 400, { action });
    }

    switch (action) {
      case 'create-project': {
        const project = coordinator.createProject(payload);
        return { status: 200, body: { ok: true, project } };
      }
      case 'get-project': {
        const projectId = isPlainObject(payload) ? payload.projectId : undefined;
        const project = coordinator.getProject(requireNonEmptyString(projectId, 'projectId'));
        return { status: 200, body: { ok: true, project } };
      }
      case 'summarize': {
        const projectId = isPlainObject(payload) ? payload.projectId : undefined;
        const summary = coordinator.summarize(requireNonEmptyString(projectId, 'projectId'));
        return { status: 200, body: { ok: true, summary } };
      }
      case 'schedule-contractor': {
        const projectId = isPlainObject(payload) ? payload.projectId : undefined;
        const project = await coordinator.scheduleContractor(requireNonEmptyString(projectId, 'projectId'), payload);
        return { status: 200, body: { ok: true, project } };
      }
      case 'sign-off': {
        const projectId = isPlainObject(payload) ? payload.projectId : undefined;
        const project = await coordinator.signOffContractor(requireNonEmptyString(projectId, 'projectId'), payload);
        return { status: 200, body: { ok: true, project } };
      }
      case 'release-milestone': {
        const projectId = isPlainObject(payload) ? payload.projectId : undefined;
        const receipt = await coordinator.releaseMilestone(requireNonEmptyString(projectId, 'projectId'), payload);
        return { status: 200, body: { ok: true, receipt } };
      }
      default:
        throw new RenovationError('INVALID_INPUT', `Unknown action '${action}'.`, 400, { action });
    }
  } catch (error) {
    if (error instanceof RenovationError) {
      return {
        status: error.status,
        body: { ok: false, code: error.code, message: error.message, details: error.details ?? null }
      };
    }
    throw error;
  }
}
