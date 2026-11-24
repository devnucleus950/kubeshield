import type { Scenario } from '../scenario.js';
import { baseline } from './baseline.js';
import { burst } from './burst.js';
import { fileTamper } from './fileTamper.js';
import { malformed } from './malformed.js';
import { privilegedContainer } from './privilegedContainer.js';
import { shellAttack } from './shellAttack.js';

export const SCENARIOS: readonly Scenario[] = [baseline, shellAttack, privilegedContainer, fileTamper, burst, malformed];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
