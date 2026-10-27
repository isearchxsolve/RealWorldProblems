/**
 * VaultKid / family health vault — willingness-to-pay validation (issue #1634).
 *
 * This module operationalizes the landing-page + waitlist experiment described in
 * muaddibco/RealWorldProblems#1634 so the pass/fail decision is computable and
 * testable instead of living only in prose.
 *
 * Design constraints:
 * - The experiment is a `type/experiment` artifact and must never advance through
 *   the `type/problem` pipeline.
 * - Visitor de-duplication and waitlist sign-up are atomic (check-and-set with no
 *   await between read and write) so concurrent requests cannot double-count or
 *   double-spend.
 * - Every rejectable input fails with an explicit, typed error instead of crashing.
 */

export type TierId = 'free' | 'basic' | 'plus';

export type ExperimentTier = {
  id: TierId;
  label: string;
  monthlyPriceUsd: number;
  paid: boolean;
  childLimit: number | null;
  documentLimit: number | null;
  includesOfflineVault: boolean;
  includesQrShare: boolean;
  includesVaccinationAlerts: boolean;
};

export const EXPERIMENT_TIERS: readonly ExperimentTier[] = [
  {
    id: 'free',
    label: 'Free',
    monthlyPriceUsd: 0,
    paid: false,
    childLimit: 1,
    documentLimit: 10,
    includesOfflineVault: false,
    includesQrShare: false,
    includesVaccinationAlerts: false
  },
  {
    id: 'basic',
    label: 'Vault Basic',
    monthlyPriceUsd: 3.99,
    paid: true,
    childLimit: null,
    documentLimit: null,
    includesOfflineVault: true,
    includesQrShare: false,
    includesVaccinationAlerts: false
  },
  {
    id: 'plus',
    label: 'Vault Plus',
    monthlyPriceUsd: 6.99,
    paid: true,
    childLimit: null,
    documentLimit: null,
    includesOfflineVault: true,
    includesQrShare: true,
    includesVaccinationAlerts: true
  }
] as const;

/** Minimum unique visitors required before a pass/fail decision is meaningful. */
export const TRAFFIC_MIN_VISITORS = 300;
/** Upper end of the 300-400 visitor traffic target stated in the issue. */
export const TRAFFIC_TARGET_MAX_VISITORS = 400;
/** Landing-page -> sign-up conversion at or above this rate is a PASS signal. */
export const CONVERSION_PASS_RATE = 0.05;
/** Conversion below this rate is an explicit FAIL signal. */
export const CONVERSION_FAIL_RATE = 0.03;
/** Share of sign-ups selecting a paid tier at or above this is a PASS signal. */
export const PAID_TIER_PASS_SHARE = 0.25;
/** Paid-tier share below this is an explicit FAIL signal. */
export const PAID_TIER_FAIL_SHARE = 0.1;
/** Lower bound of the "$3.99-6.99/month" paid tier range from the issue. */
export const PAID_TIER_PRICE_MIN_USD = 3.99;
/** Upper bound of the "$3.99-6.99/month" paid tier range from the issue. */
export const PAID_TIER_PRICE_MAX_USD = 6.99;

export type ExperimentErrorCode =
  | 'MISSING_FIELD'
  | 'EMPTY_VALUE'
  | 'INVALID_EMAIL'
  | 'UNKNOWN_TIER'
  | 'DUPLICATE_SIGNUP'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND';

export class ExperimentValidationError extends Error {
  public readonly code: ExperimentErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: ExperimentErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ExperimentValidationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isExperimentValidationError(error: unknown): error is ExperimentValidationError {
  return error instanceof ExperimentValidationError;
}

/** Requires a present, non-blank string. Null/undefined -> MISSING_FIELD, blank -> EMPTY_VALUE. */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new ExperimentValidationError('MISSING_FIELD', `Missing required field: ${field}`, 400, { field });
  }
  if (typeof value !== 'string') {
    throw new ExperimentValidationError('EMPTY_VALUE', `Field ${field} must be a string`, 400, {
      field,
      receivedType: typeof value
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ExperimentValidationError('EMPTY_VALUE', `Field ${field} must not be empty or whitespace only`, 400, {
      field
    });
  }
  return trimmed;
}

export function normalizeEmail(value: unknown): string {
  const email = requireNonEmptyString(value, 'email').toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ExperimentValidationError('INVALID_EMAIL', `Invalid email address: ${email}`, 400, { field: 'email' });
  }
  return email;
}

export function resolveTier(value: unknown): ExperimentTier {
  const id = requireNonEmptyString(value, 'tier').toLowerCase();
  const tier = EXPERIMENT_TIERS.find((candidate) => candidate.id === id);
  if (!tier) {
    throw new ExperimentValidationError('UNKNOWN_TIER', `Unknown pricing tier: ${id}`, 400, {
      field: 'tier',
      allowed: EXPERIMENT_TIERS.map((candidate) => candidate.id)
    });
  }
  return tier;
}

export type RecordVisitInput = { visitorId?: unknown; channel?: unknown };
export type SignUpInput = { email?: unknown; tier?: unknown; channel?: unknown; visitorId?: unknown };

export type ExperimentVisit = {
  visitorId: string;
  channel: string;
  recordedAt: string;
};

export type ExperimentSignup = {
  email: string;
  tierId: TierId;
  channel: string;
  visitorId: string | null;
  createdAt: string;
};

export type ExperimentMetrics = {
  uniqueVisitors: number;
  signups: number;
  paidSignups: number;
  freeSignups: number;
  conversionRate: number;
  paidShare: number;
  tierBreakdown: Record<TierId, number>;
};

export type ExperimentDecisionStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export type ExperimentDecision = {
  status: ExperimentDecisionStatus;
  reasons: string[];
  metrics: ExperimentMetrics;
  thresholds: {
    minVisitors: number;
    conversionPassRate: number;
    conversionFailRate: number;
    paidTierPassShare: number;
    paidTierFailShare: number;
  };
};

export type ExperimentOptions = { now?: () => Date };

export class WillingnessToPayExperiment {
  private readonly visits = new Map<string, ExperimentVisit>();
  private readonly signupsByEmail = new Map<string, ExperimentSignup>();
  private readonly tierBreakdown: Record<TierId, number> = { free: 0, basic: 0, plus: 0 };
  private readonly now: () => Date;

  constructor(options: ExperimentOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Records one unique landing-page visitor. Re-recording the same visitorId is idempotent. */
  recordVisit(input: RecordVisitInput | null | undefined): ExperimentVisit {
    const visitorId = requireNonEmptyString(input?.visitorId, 'visitorId');
    const channel = requireNonEmptyString(input?.channel, 'channel');

    const existing = this.visits.get(visitorId);
    if (existing) {
      return existing;
    }

    const visit: ExperimentVisit = { visitorId, channel, recordedAt: this.now().toISOString() };
    this.visits.set(visitorId, visit);
    return visit;
  }

  /**
   * Registers a waitlist sign-up with an explicit tier selection.
   * The check-and-set below is atomic: there is no await between the duplicate
   * check and the write, so concurrent requests cannot double-register an email.
   */
  signUp(input: SignUpInput | null | undefined): ExperimentSignup {
    const email = normalizeEmail(input?.email);
    const tier = resolveTier(input?.tier);
    const channel = requireNonEmptyString(input?.channel, 'channel');
    const visitorId =
      input?.visitorId === null || input?.visitorId === undefined
        ? null
        : requireNonEmptyString(input.visitorId, 'visitorId');

    if (this.signupsByEmail.has(email)) {
      throw new ExperimentValidationError(
        'DUPLICATE_SIGNUP',
        `Email is already registered on the waitlist: ${email}`,
        409,
        { field: 'email' }
      );
    }

    const signup: ExperimentSignup = { email, tierId: tier.id, channel, visitorId, createdAt: this.now().toISOString() };
    this.signupsByEmail.set(email, signup);
    this.tierBreakdown[tier.id] += 1;
    return signup;
  }

  getMetrics(): ExperimentMetrics {
    const uniqueVisitors = this.visits.size;
    const signups = this.signupsByEmail.size;
    const paidSignups = this.tierBreakdown.basic + this.tierBreakdown.plus;
    const freeSignups = this.tierBreakdown.free;

    return {
      uniqueVisitors,
      signups,
      paidSignups,
      freeSignups,
      conversionRate: uniqueVisitors === 0 ? 0 : signups / uniqueVisitors,
      paidShare: signups === 0 ? 0 : paidSignups / signups,
      tierBreakdown: { ...this.tierBreakdown }
    };
  }

  /** Evaluates the issue's pass/fail criteria using strict (>= / <) threshold semantics. */
  decide(): ExperimentDecision {
    const metrics = this.getMetrics();
    const reasons: string[] = [];

    const trafficSufficient = metrics.uniqueVisitors >= TRAFFIC_MIN_VISITORS;
    const conversionPass = trafficSufficient && metrics.conversionRate >= CONVERSION_PASS_RATE;
    const conversionFail = trafficSufficient && metrics.conversionRate < CONVERSION_FAIL_RATE;
    const paidPass = trafficSufficient && metrics.signups > 0 && metrics.paidShare >= PAID_TIER_PASS_SHARE;
    const paidFail = trafficSufficient && metrics.signups > 0 && metrics.paidShare < PAID_TIER_FAIL_SHARE;

    let status: ExperimentDecisionStatus;

    if (!trafficSufficient) {
      status = 'INCONCLUSIVE';
      reasons.push(`insufficient-traffic:${metrics.uniqueVisitors}/${TRAFFIC_MIN_VISITORS}`);
    } else if (conversionFail || paidFail) {
      status = 'FAIL';
      if (conversionFail) {
        reasons.push('conversion-below-fail-threshold');
      }
      if (paidFail) {
        reasons.push('paid-intent-below-fail-threshold');
      }
    } else if (conversionPass && paidPass) {
      status = 'PASS';
      reasons.push('conversion-at-or-above-pass-threshold');
      reasons.push('paid-intent-at-or-above-pass-threshold');
    } else {
      status = 'INCONCLUSIVE';
      if (!conversionPass) {
        reasons.push('conversion-between-thresholds');
      }
      if (!paidPass) {
        reasons.push('paid-intent-between-thresholds');
      }
    }

    return {
      status,
      reasons,
      metrics,
      thresholds: {
        minVisitors: TRAFFIC_MIN_VISITORS,
        conversionPassRate: CONVERSION_PASS_RATE,
        conversionFailRate: CONVERSION_FAIL_RATE,
        paidTierPassShare: PAID_TIER_PASS_SHARE,
        paidTierFailShare: PAID_TIER_FAIL_SHARE
      }
    };
  }
}

export type ExperimentHttpRequest = {
  method?: unknown;
  path?: unknown;
  body?: unknown;
  authorization?: unknown;
};

export type ExperimentHttpOptions = { adminToken?: string };

export type ExperimentHttpResponse = { status: number; jsonBody: unknown };

/**
 * Thin transport adapter so the experiment can be exercised over HTTP without a
 * live Functions host. Returns 200 on success and typed 400/401/404/409 refusals.
 */
export function handleExperimentHttpRequest(
  experiment: WillingnessToPayExperiment,
  request: ExperimentHttpRequest | null | undefined,
  options: ExperimentHttpOptions = {}
): ExperimentHttpResponse {
  try {
    const method = requireNonEmptyString(request?.method, 'method').toUpperCase();
    const path = requireNonEmptyString(request?.path, 'path');

    if (method === 'POST' && path === '/visits') {
      const visit = experiment.recordVisit(request?.body as RecordVisitInput | null | undefined);
      return { status: 200, jsonBody: { ok: true, visit } };
    }

    if (method === 'POST' && path === '/signups') {
      const signup = experiment.signUp(request?.body as SignUpInput | null | undefined);
      return { status: 200, jsonBody: { ok: true, signup } };
    }

    if (method === 'GET' && path === '/decision') {
      const expectedToken = typeof options.adminToken === 'string' ? options.adminToken.trim() : '';
      const provided = typeof request?.authorization === 'string' ? request.authorization.trim() : '';
      if (expectedToken.length === 0 || provided !== `Bearer ${expectedToken}`) {
        throw new ExperimentValidationError(
          'UNAUTHORIZED',
          'Admin credential required to read experiment metrics',
          401,
          { field: 'authorization' }
        );
      }
      return { status: 200, jsonBody: { ok: true, decision: experiment.decide() } };
    }

    throw new ExperimentValidationError('NOT_FOUND', `Unsupported experiment route: ${method} ${path}`, 404, {
      method,
      path
    });
  } catch (error) {
    if (isExperimentValidationError(error)) {
      return {
        status: error.status,
        jsonBody: { ok: false, code: error.code, message: error.message, details: error.details }
      };
    }
    return {
      status: 500,
      jsonBody: {
        ok: false,
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}

export type ExperimentIssueClassification = {
  isExperiment: boolean;
  excludedFromProblemPipeline: boolean;
  reason: string;
};

/**
 * Issue #1634 is a `type/experiment` child artifact of the validation stage. It has
 * no `stage/*` label and must never be advanced, scored or archived by the
 * `type/problem` pipeline.
 */
export function classifyExperimentIssue(labels: unknown): ExperimentIssueClassification {
  const normalized = Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === 'string')
    : [];

  const isExperiment = normalized.includes('type/experiment');
  const excludedFromProblemPipeline =
    isExperiment || normalized.includes('agentic-workflows') || normalized.includes('stage/9-archived');

  return {
    isExperiment,
    excludedFromProblemPipeline,
    reason: isExperiment
      ? 'Issue is a type/experiment validation artifact and must not advance through the type/problem pipeline.'
      : 'Issue is not a type/experiment issue.'
  };
}
