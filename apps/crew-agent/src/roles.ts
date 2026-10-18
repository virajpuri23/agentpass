import type { CrewRole } from '../../agent-kit/src/transport.js';

/** The release crew: what each specialist may buy, its budget slice, and what its job needs. */
export const RELEASE_CREW: CrewRole[] = [
  { agent: 'security-agent', label: 'Security agent', sku_id: 'SEC-SCAN', slice_cents: 30000, quantity: 1 },
  { agent: 'design-agent', label: 'Design agent', sku_id: 'DESIGN-PACK', slice_cents: 20000, quantity: 1 },
  // QA's job needs 350 minutes ($350) but its slice is $250, so it must ask for a top-up.
  { agent: 'qa-agent', label: 'QA agent', sku_id: 'QA-MINUTES', slice_cents: 25000, quantity: 350 },
];

/** Why each specialist needs what it asks for; sent as the request's `reason`. */
export function justification(role: CrewRole, neededCents: number, sliceCents: number): string {
  if (role.sku_id === 'QA-MINUTES') {
    return `Release regression suite needs ${role.quantity} device-minutes (7 devices x 50 min). `
      + `My slice covers ${Math.floor(sliceCents / 100)}. Requesting $${neededCents / 100} total for QA-MINUTES.`;
  }
  return `Task needs ${role.quantity} x ${role.sku_id}, costing $${neededCents / 100}; my slice is $${sliceCents / 100}.`;
}
