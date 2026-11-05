import { useSyncExternalStore } from 'react';
import { createGuideClock } from '../lib/guideClock';

const clock = createGuideClock();
export function useGuideTime() {
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
