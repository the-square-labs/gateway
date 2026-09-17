import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<{ active: boolean }>();

/** Admission follows a running request across service boundaries, but never outlives it. */
export const acceptedOperations = {
  isActive(): boolean {
    return context.getStore()?.active === true;
  },
  run<T>(operation: () => T): T {
    if (this.isActive()) return operation();
    const token = { active: true };
    return context.run(token, () => {
      try {
        const result = operation();
        if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).then(
            () => {
              token.active = false;
            },
            () => {
              token.active = false;
            }
          );
        } else {
          token.active = false;
        }
        return result;
      } catch (error) {
        token.active = false;
        throw error;
      }
    });
  },
};
