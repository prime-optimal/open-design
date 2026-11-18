#!/usr/bin/env node

import { planOdcInvocation } from './odc-launcher.js';

const plan = planOdcInvocation(process.argv.slice(2));
if (!plan.ok) {
  process.stderr.write(`${plan.message}\n`);
  process.exit(2);
}

process.argv.splice(2, process.argv.length - 2, ...plan.argv);
Object.assign(process.env, plan.env);
// CLI dispatch reads argv and environment at module load, after the launcher has set them.
await import('./cli.js');
