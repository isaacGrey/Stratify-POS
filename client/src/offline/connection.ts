
// ==============================================
// STRATIFYPOS CONNECTION MANAGER
// ==============================================

// Must match the actual API server URL.
// In production, configure VITE_apiOrigin as
// an HTTPS endpoint or use a same-origin API.

import { apiOrigin } from '../site-routing';

export interface ConnectionStatus {
    online: boolean;
    checkedAt: string;
    message: string;
}

// ==============================================
// CHECK ACTUAL BACKEND CONNECTION
// ==============================================

export async function checkServerConnection(
    timeoutMs = 5000
): Promise<ConnectionStatus> {
    const checkedAt = new Date().toISOString();

    if (!navigator.onLine) {
        return {
            online: false,
            checkedAt,
            message: 'Device is offline.'
        };
    }

    const controller = new AbortController();

    const timeout = window.setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetch(
            `${apiOrigin}/api/ready`,
            {
                method: 'GET',
                cache: 'no-store',
                signal: controller.signal
            }
        );

        if (!response.ok) {
            throw new Error(
                `Server returned ${response.status}`
            );
        }

        const result = await response.json();

        if (result.ok !== true) {
            throw new Error(
                'Unexpected server health response.'
            );
        }

        return {
            online: true,
            checkedAt: new Date().toISOString(),
            message: 'Connected to StratifyPOS server.'
        };

    } catch {
        return {
            online: false,
            checkedAt: new Date().toISOString(),
            message: 'StratifyPOS server unavailable.'
        };

    } finally {
        window.clearTimeout(timeout);
    }
}

// ==============================================
// LISTEN FOR CONNECTION CHANGES
//
// This is connectivity information only.
// It does not start transaction synchronization.
// ==============================================

export function watchConnection(
    callback: (status: ConnectionStatus) => void
): () => void {
    let disposed = false;

    const update = async () => {
        const status = await checkServerConnection();

        if (!disposed) {
            callback(status);
        }
    };

    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    void update();

    return () => {
        disposed = true;

        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
    };
}
