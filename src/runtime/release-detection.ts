import { ColabRequestError } from '../colab/client.js';

export type RuntimeReleasedHandler = (error: ColabRequestError) => void | Promise<void>;

export function isRuntimeReleasedError(error: unknown): error is ColabRequestError {
  return error instanceof ColabRequestError && error.status === 404;
}

export function formatRuntimeReleasedMessage(endpoint: string): string {
  return `Runtime ${endpoint} is no longer assigned by the Colab backend (404 NOT_FOUND). Local daemon state has been cleaned up; create a new runtime if you need another session.`;
}
