/** Sourcing agent process entry. Started by the launcher with only its own key. */
import { agentFromEnv } from '../../agent-kit/src/runtime.js';
import { IpcChildTransport } from '../../agent-kit/src/transport.js';
import { serveSourcing } from './agent.js';

const link = new IpcChildTransport('sourcing-agent');
const ctx = await agentFromEnv('sourcing-agent', link);
ctx.note('Sourcing agent online (own identity, no inherited credentials)');
serveSourcing(ctx);
