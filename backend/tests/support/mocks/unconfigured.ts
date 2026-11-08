import { vi } from 'vitest';

export function unconfigured<T extends (...args: never[]) => Promise<unknown>>(operation: string) {
  return vi.fn<T>().mockImplementation((() => {
    throw new Error('Configure mock operation before calling: ' + operation);
  }));
}
