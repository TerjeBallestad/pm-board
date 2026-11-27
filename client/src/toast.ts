import { createToastManager } from '@terjeballestad/bob';

/** The dashboard's one toast manager (Bob 1.0, DD-036). main.tsx hands it to ToastStack. */
export const toast = createToastManager();

/** BoardProvider's toast(text, error): a success closes after ToastStack's timeout, an error stays until closed. */
export const notify = (text: string, error?: boolean) => toast.add({ title: text, type: error ? 'error' : 'success' });
