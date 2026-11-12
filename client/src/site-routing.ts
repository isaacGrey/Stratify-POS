function configuredOrigin(value?: string) {
    if (!value) return '';
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) ? url.origin : '';
    } catch { return ''; }
}

export const apiOrigin = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '')).replace(/\/$/,'');
export const applicationOrigin = configuredOrigin(import.meta.env.VITE_APP_ORIGIN);
export const marketingOrigin = configuredOrigin(import.meta.env.VITE_MARKETING_ORIGIN);
export const appUrl = (path: string) => applicationOrigin + path;
export const publicUrl = (path: string) => marketingOrigin + path;
