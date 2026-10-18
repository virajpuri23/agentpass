import { z } from 'zod';
import { WORKFORCE_ACTIONS, workforceDecisionSchema, workforceScopeSchema } from '../../../../packages/contracts/src/workforce.js';

export const SUPPLIER_ACTIONS = [
  'supplier.quote.request',
  'supplier.purchase.execute',
  'supplier.margin.read',
] as const;
export const ACTIONS = [...SUPPLIER_ACTIONS, ...WORKFORCE_ACTIONS] as const;

const supplierScopeSchema = z.object({
  actions: z.array(z.enum(SUPPLIER_ACTIONS)),
  supplier_ids: z.array(z.string().min(1)),
  sku_ids: z.array(z.string().min(1)),
  max_per_action_cents: z.number().int().nonnegative(),
  total_budget_cents: z.number().int().nonnegative(),
  expires_at: z.iso.datetime({ offset: true }),
  max_delegation_depth: z.number().int().nonnegative(),
}).strict();
export const scopeSchema = z.union([supplierScopeSchema, workforceScopeSchema]);

const errorSchema = z.object({
  status: z.enum(['AUTHORITY_REQUIRED', 'DENIED', 'ERROR']),
  code: z.string().min(1),
  reason: z.string().min(1),
  next_action: z.enum(['request_authority', 'retry', 'contact_owner']).optional(),
  required_scope: scopeSchema.optional(),
}).passthrough();

const successSchema = z.object({
  status: z.literal('OK'),
  data: z.record(z.string(), z.unknown()),
}).passthrough();



export const envelopeSchema = z.union([successSchema, workforceDecisionSchema, errorSchema]);
export type Envelope = z.infer<typeof envelopeSchema>;
type Config = { authorityUrl: string; agentApiKey: string; runId?: string };

const invalidCaller = (reason: string): Envelope => ({
  status: 'DENIED',
  code: 'INVALID_CALLER',
  reason,
});

const serviceUnavailable = (reason: string): Envelope => ({
  status: 'ERROR',
  code: 'SERVICE_UNAVAILABLE',
  reason,
  next_action: 'retry',
});

function configuredBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('AUTHORITY_URL must be an HTTP(S) service URL without credentials, query, or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

export function toolResult(value: Envelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function createAuthorityClient(config: Config) {
  const baseUrl = configuredBaseUrl(config.authorityUrl);

  return async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Envelope> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${config.agentApiKey}`,
          ...(config.runId ? {'x-agentpass-run-id':config.runId} : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return serviceUnavailable('Could not reach the authority service.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const parsed = envelopeSchema.safeParse(payload);
    if (parsed.success) {
      if (!response.ok && parsed.data.status === 'OK') {
        return serviceUnavailable(`Authority service returned HTTP ${response.status}.`);
      }
      return parsed.data;
    }

    if (response.status === 401) return invalidCaller('Authority service rejected the configured agent credentials.');
    if (response.status === 403) return invalidCaller('Authority service rejected this principal for the requested operation.');
    if (response.status >= 400 && response.status < 500) {
      return { status: 'ERROR', code: 'INVALID_REQUEST', reason: 'Authority service rejected the request.' };
    }
    return serviceUnavailable('Authority service returned an invalid response.');
  };
}
