import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import SwaggerParser from '@apidevtools/swagger-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { onboardingSchemas } from '../../../packages/contracts/src/onboarding.js';
import { scopeSchema } from '../src/validation.js';
import { openDatabase } from '../../../db/database.js';
import { seedDatabase } from '../../../db/seed.js';
import { createAuthorityApp } from '../src/app.js';

const specPath = new URL('../../../contracts/agentpass.openapi.yaml', import.meta.url).pathname;
// Parser's OpenAPI union does not expose 3.1 JSON Schema keywords used by this document.
let raw: any;
let api: any;
const pascal = (name: string) => name.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
const normalize = (path: string) => path.replace(/:[A-Za-z_]+|\{[^}]+\}/g, '{}').replace(/\/$/, '') || '/';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const responseSchema = (path: string, method: string, status: number) =>
  z.fromJSONSchema(api.paths[path][method].responses[String(status)].content['application/json'].schema);

beforeAll(async () => {
  raw = await SwaggerParser.parse(specPath);
  api = await SwaggerParser.validate(specPath, { resolve: { external: false } });
});

describe('complete product OpenAPI contract', () => {
  it('validates OpenAPI 3.1 with unique operation IDs and explicit service/security boundaries', () => {
    expect(api.openapi).toBe('3.1.0');
    const ids: string[] = [];
    for (const [path, item] of Object.entries<any>(raw.paths)) {
      for (const [method, operation] of Object.entries<any>(item)) {
        ids.push(operation.operationId);
        expect(operation.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(operation.responses).some(code => /^[23]\d\d$/.test(code)), `${method} ${path}`).toBe(true);
        if (path.startsWith('/internal/agent-jobs')) expect(operation.security).toEqual([{ RunnerBearer: [] }]);
        else if (path.startsWith('/internal/')) expect(operation.security).toEqual([{ SupplierServiceKey: [] }]);
        if (path.startsWith('/console-api/v1/')) expect(operation.security).toEqual([{ ConsoleCookie: [] }]);
        for (const match of path.matchAll(/\{([^}]+)\}/g)) {
          expect(operation.parameters?.some((p: any) => p.in === 'path' && p.name === match[1] && p.required)).toBe(true);
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(raw.paths['/internal/agent-jobs/{job_id}/credential'].post['x-internal']).toBe(true);
    expect(raw.paths['/onboarding/approve'].post.requestBody.content).toHaveProperty('application/x-www-form-urlencoded');
  });

  it('covers every explicit authority, agent-control, supplier and trusted browser route', () => {
    const documented = new Set(Object.entries<any>(raw.paths).flatMap(([path, item]) =>
      Object.keys(item).map(method => `${method} ${normalize(path)}`)));
    for (const [file, prefix] of [
      ['../src/app.ts', ''], ['../src/agent-control.ts', ''],
      ['../../supplier/src/app.ts', ''], ['../src/consent-browser.ts', '/onboarding'],
      ['../src/supabase-login.ts', '/onboarding/identity'],
    ]) {
      for (const match of source(file).matchAll(/(?:app|router)\.(get|post)\('([^']+)'/g)) {
        expect(documented.has(`${match[1]} ${normalize(prefix + match[2])}`), `${file}: ${match[1]} ${prefix + match[2]}`).toBe(true);
      }
    }
    for (const path of ['/connect', '/console', '/console.js', '/console.css', '/console-api/config', '/console-api/snapshot']) {
      expect(raw.paths[path]).toHaveProperty('get');
    }
    for (const path of ['/console-api/session', '/console-api/logout', '/console-api/v1/authority/requests',
      '/console-api/v1/authority/requests/{requestId}/respond', '/console-api/v1/authority/requests/{requestId}/accept',
      '/console-api/v1/grants/{grantId}/revoke']) expect(raw.paths[path]).toHaveProperty('post');
    expect(Object.keys(raw.paths['/mcp']).sort()).toEqual(['delete', 'get', 'post']);
    const tools = Array.from(source('../../mcp/agentpass-manufact/index.ts').matchAll(/server\.tool\(\{\s*name:\s*'([^']+)'/g), match => match[1]);
    expect([...raw['x-mcp-tools'].legacy_service_tools, ...raw['x-mcp-tools'].remote_onboarding_tools].sort()).toEqual(tools.sort());
  });

  it('keeps every onboarding schema synchronized with the canonical shared Zod contracts', () => {
    for (const [name, schema] of Object.entries(onboardingSchemas)) {
      const { $schema, ...expected } = z.toJSONSchema(schema);
      expect(raw.components.schemas['Onboarding' + pascal(name)], name).toEqual(expected);
    }
    const { $schema, ...expected } = z.toJSONSchema(scopeSchema);
    const { description, examples, ...actual } = raw.components.schemas.AuthorityScope;
    expect(actual).toEqual(expected);
  });

  it('accepts the existing safe receipt/denial fixtures and rejects leaked private response fields', () => {
    const receipt = JSON.parse(source('../../../fixtures/response-purchase-receipt.json'));
    const denied = JSON.parse(source('../../../fixtures/response-authority-required.json'));
    responseSchema('/v1/actions/execute', 'post', 200).parse(receipt);
    responseSchema('/v1/actions/execute', 'post', 403).parse(denied);
    expect(responseSchema('/v1/actions/execute', 'post', 200).safeParse({ ...receipt, data: { ...receipt.data, internal_unit_cost_cents: 1 } }).success).toBe(false);
  });

  it('matches successful and denied real HTTP responses against documented schemas (in-memory fixture)', async () => {
    const db = openDatabase(':memory:');
    seedDatabase(db, { 'owner-1': 'openapi-owner', 'buyer-agent': 'openapi-buyer', 'sourcing-agent': 'openapi-child', 'supplier-agent': 'openapi-seller' });
    let server: Server | undefined;
    try {
      server = createAuthorityApp({ db, supplier: {
        policy: async () => true,
        quote: async () => { throw new Error('Not used'); },
        getQuote: async () => { throw new Error('Not used'); },
        fulfill: async () => { throw new Error('Not used'); },
      } }).listen(0, '127.0.0.1');
      await new Promise<void>((resolve, reject) => server!.once('listening', resolve).once('error', reject));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const me = await fetch(base + '/v1/me', { headers: { authorization: 'Bearer openapi-buyer' } });
      expect(me.status).toBe(200);
      responseSchema('/v1/me', 'get', 200).parse(await me.json());
      const missing = await fetch(base + '/v1/me');
      expect(missing.status).toBe(401);
      responseSchema('/v1/me', 'get', 401).parse(await missing.json());
      const scope = { ...raw.components.schemas.AuthorityScope.examples[0], expires_at: new Date(Date.now() + 60000).toISOString() };
      const delegate = async (extra: object) => fetch(base + '/v1/grants/grant-root-buyer/delegate', {
        method: 'POST', headers: { authorization: 'Bearer openapi-buyer', 'content-type': 'application/json' },
        body: JSON.stringify({ recipient_principal_id: 'sourcing-agent', scope, ...extra }),
      });
      const granted = await delegate({});
      expect(granted.status).toBe(200);
      responseSchema('/v1/grants/{grantId}/delegate', 'post', 200).parse(await granted.json());
      const forged = await delegate({ organization_id: 'foreign-org' });
      expect(forged.status).toBe(400);
      responseSchema('/v1/grants/{grantId}/delegate', 'post', 400).parse(await forged.json());
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      db.close();
    }
  });
});
