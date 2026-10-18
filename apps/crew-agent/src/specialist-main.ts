/** Specialist process. Reads its own provisioned secret from a private file; never sees the lead's key. */
import { agentFromEnv } from '../../agent-kit/src/runtime.js';
import { IpcChildTransport } from '../../agent-kit/src/transport.js';
import { RELEASE_CREW } from './roles.js';
import { serveSpecialist } from './specialist.js';

const name = process.env.AGENT_NAME ?? '';
const role = RELEASE_CREW.find((r) => r.agent === name);
if (!role) throw new Error(`Unknown specialist ${name}`);
const link = new IpcChildTransport(name);
const ctx = await agentFromEnv(name, link);
ctx.note(`${role.label} online with its own identity`);
serveSpecialist(ctx, role);
