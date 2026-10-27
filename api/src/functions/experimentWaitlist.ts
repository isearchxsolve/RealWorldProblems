import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  ExperimentHttpResponse,
  WillingnessToPayExperiment,
  handleExperimentHttpRequest
} from '../experiments/willingnessToPay';

// HTTP surface for the family health document vault willingness-to-pay experiment
// (muaddibco/RealWorldProblems#1555, child of problem #15).
//
// Module-level experiment state for the landing-page campaign. A production
// deployment would persist this in Table Storage; the in-memory store keeps the
// artifact self-contained and dependency-free.
const experiment = new WillingnessToPayExperiment();

function toResponse(result: ExperimentHttpResponse): HttpResponseInit {
  return { status: result.status, jsonBody: result.jsonBody };
}

async function readBody(request: HttpRequest): Promise<{ ok: true; body: unknown } | { ok: false; response: HttpResponseInit }> {
  if (request.method === 'GET') {
    return { ok: true, body: undefined };
  }
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: {
        status: 400,
        jsonBody: { ok: false, code: 'EMPTY_VALUE', message: 'Request body must be valid JSON' }
      }
    };
  }
}

async function handler(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const action = request.params.action;
  const path = `/${typeof action === 'string' ? action : ''}`;

  const bodyResult = await readBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return toResponse(
    handleExperimentHttpRequest(
      experiment,
      {
        method: request.method,
        path,
        body: bodyResult.body,
        authorization: request.headers.get('authorization')
      },
      { adminToken: process.env.EXPERIMENT_ADMIN_TOKEN }
    )
  );
}

app.http('experimentWaitlist', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'experiments/family-health-vault/{action}',
  handler
});
