import {
  ExperimentValidationError,
  WillingnessToPayExperiment,
  classifyExperimentIssue
} from '../willingnessToPay';

describe('SCENARIO_DEFECT_REGRESSION: issue #1555 family health document vault willingness-to-pay validation', () => {
  // Labels exactly as delivered in the issue #1555 context payload.
  const issue1555Labels = ['type/experiment'];

  it('classifies issue #1555 as a type/experiment artifact excluded from the problem pipeline', () => {
    const classification = classifyExperimentIssue(issue1555Labels);

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

  it('reproduces the reported conversion inflation defect: repeated visitor and sign-up submissions no longer double-count', () => {
    const experiment = new WillingnessToPayExperiment();

    // The reported defect condition: the same visitor reloads the landing page and
    // the same parent submits the waitlist form twice.
    experiment.recordVisit({ visitorId: 'returning-visitor', channel: 'school-enrollment' });
    experiment.recordVisit({ visitorId: 'returning-visitor', channel: 'school-enrollment' });

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
  });

  it('evaluates the issue #1555 pass criteria end-to-end without regressing the decision', () => {
    const experiment = new WillingnessToPayExperiment();

    for (let index = 0; index < 320; index += 1) {
      experiment.recordVisit({ visitorId: `v-${index}`, channel: index % 2 === 0 ? 'facebook-parent-group' : 'reddit' });
    }
    for (let index = 0; index < 20; index += 1) {
      experiment.signUp({ email: `parent-${index}@example.co.uk`, tier: index < 5 ? 'plus' : 'free', channel: 'facebook-parent-group' });
    }

    const decision = experiment.decide();

    expect(decision.metrics.uniqueVisitors).toBe(320);
    expect(decision.metrics.conversionRate).toBeGreaterThanOrEqual(0.05);
    expect(decision.metrics.paidShare).toBeGreaterThanOrEqual(0.25);
    expect(decision.status).toBe('PASS');
  });
});
