import {
  CONVERSION_PASS_RATE,
  ExperimentValidationError,
  PAID_TIER_PASS_SHARE,
  WillingnessToPayExperiment,
  classifyExperimentIssue
} from '../willingnessToPay';

describe('SCENARIO_DEFECT_REGRESSION: issue #1647 family health docs willingness-to-pay landing page test', () => {
  // Labels exactly as delivered in the issue #1647 context payload.
  const issue1647Labels = ['type/experiment'];

  it('classifies issue #1647 as a type/experiment artifact excluded from the problem pipeline', () => {
    const classification = classifyExperimentIssue(issue1647Labels);

    expect(classification.isExperiment).toBe(true);
    expect(classification.excludedFromProblemPipeline).toBe(true);
    expect(classification.reason).toContain('type/experiment');
  });

  it('does not exclude genuine type/problem issues from the pipeline', () => {
    const classification = classifyExperimentIssue(['type/problem', 'stage/3-scored']);
    expect(classification.isExperiment).toBe(false);
    expect(classification.excludedFromProblemPipeline).toBe(false);
  });

  it('excludes agentic-workflows and archived issues as before', () => {
    expect(classifyExperimentIssue(['type/problem', 'agentic-workflows']).excludedFromProblemPipeline).toBe(true);
    expect(classifyExperimentIssue(['type/problem', 'stage/9-archived']).excludedFromProblemPipeline).toBe(true);
    expect(classifyExperimentIssue(undefined).isExperiment).toBe(false);
  });

  it('reproduces the reported conversion inflation defect: page reloads and duplicate submits no longer double-count', () => {
    const experiment = new WillingnessToPayExperiment();

    // The reported defect condition: the same parent reloads the landing page at the
    // school enrollment failure moment and submits the waitlist form twice.
    experiment.recordVisit({ visitorId: 'returning-parent', channel: 'school-enrollment' });
    experiment.recordVisit({ visitorId: 'returning-parent', channel: 'school-enrollment' });

    experiment.signUp({ email: 'stressed-parent@example.com', tier: 'plus', channel: 'school-enrollment' });
    let duplicateError: unknown;
    try {
      experiment.signUp({ email: 'stressed-parent@example.com', tier: 'plus', channel: 'school-enrollment' });
    } catch (error) {
      duplicateError = error;
    }

    // Assertions proving the expected behavior after the fix.
    expect(duplicateError).toBeInstanceOf(ExperimentValidationError);
    expect((duplicateError as ExperimentValidationError).code).toBe('DUPLICATE_SIGNUP');

    const metrics = experiment.getMetrics();
    expect(metrics.uniqueVisitors).toBe(1);
    expect(metrics.signups).toBe(1);
    expect(metrics.conversionRate).toBe(1);
    expect(metrics.paidSignups).toBe(1);
    expect(metrics.selectedMonthlyPriceGbp).toBe(6.99);
  });

  it('reproduces the reported silent-default defect: a tierless sign-up is refused instead of counted as free', () => {
    const experiment = new WillingnessToPayExperiment();

    // Before the fix a missing tier silently defaulted to the free tier, which
    // deflated the paid-intent share that the experiment is meant to measure.
    let error: unknown;
    try {
      experiment.signUp({ email: 'tierless-parent@example.com', channel: 'school-enrollment' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ExperimentValidationError);
    expect((error as ExperimentValidationError).code).toBe('MISSING_FIELD');
    expect((error as ExperimentValidationError).details).toMatchObject({ field: 'tier' });
    expect(experiment.getMetrics().tierBreakdown).toEqual({ free: 0, basic: 0, plus: 0 });
  });

  it('evaluates the issue #1647 pass criteria end-to-end without regressing the decision', () => {
    const experiment = new WillingnessToPayExperiment();

    for (let index = 0; index < 320; index += 1) {
      experiment.recordVisit({
        visitorId: `v-${index}`,
        channel: index % 2 === 0 ? 'school-parent-facebook-group' : 'reddit-ukparenting'
      });
    }
    for (let index = 0; index < 20; index += 1) {
      experiment.signUp({
        email: `parent-${index}@example.co.uk`,
        tier: index < 5 ? 'plus' : 'free',
        channel: 'school-parent-facebook-group'
      });
    }

    const decision = experiment.decide();

    expect(decision.metrics.uniqueVisitors).toBe(320);
    expect(decision.metrics.conversionRate).toBeGreaterThanOrEqual(CONVERSION_PASS_RATE);
    expect(decision.metrics.paidShare).toBeGreaterThanOrEqual(PAID_TIER_PASS_SHARE);
    expect(decision.status).toBe('PASS');
  });
});
