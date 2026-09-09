import { state } from './state.js';

const memory = new Map();
const key = () => state.account?.id ? `islands-onboarding:${state.account.id}` : null;
export function onboardingStep() {
  const id = key();
  if (!id) return null;
  try { return localStorage.getItem(id) || memory.get(id) || null; }
  catch { return memory.get(id) || null; }
}
export function setOnboardingStep(step) {
  const id = key();
  if (!id) return;
  memory.set(id, step);
  try {
    if (step) localStorage.setItem(id, step);
    else localStorage.removeItem(id);
  } catch { /* Continue when browser storage is unavailable. */ }
}
