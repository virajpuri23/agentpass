/** Buyer agent process entry. Started by the launcher with only its own key. */
import { agentFromEnv } from '../../agent-kit/src/runtime.js';
import { IpcChildTransport } from '../../agent-kit/src/transport.js';
import { serveBuyer } from './agent.js';

const link = new IpcChildTransport('buyer-agent');
const ctx = await agentFromEnv('buyer-agent', link);
ctx.note('Buyer agent online');
serveBuyer(ctx);
