/** Lead coding agent process. Started by the launcher with only its own key. */
import { agentFromEnv } from '../../agent-kit/src/runtime.js';
import { IpcChildTransport } from '../../agent-kit/src/transport.js';
import { serveLead } from './lead.js';

const link = new IpcChildTransport('lead-agent');
const ctx = await agentFromEnv('lead-agent', link);
ctx.note('Lead coding agent online');
serveLead(ctx);
