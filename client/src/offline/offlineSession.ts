
const PUBLIC_KEY =
    import.meta.env.VITE_OFFLINE_PUBLIC_KEY_B64 || '';

const DEVICE_KEY = 'stratifypos-device-id';
const GRANT_PREFIX = 'stratifypos-offline-grant:';

const MAX_OFFLINE_MS = 12 * 60 * 60 * 1000;

export interface OfflineGrant {
    version: number;
    purpose: string;

    userId: string;
    userName: string;
    userEmail: string;

    tenantId: string;
    tenantName: string;

    branchId: string;
    branchName: string;

    deviceId: string;
    role: 'owner' | 'manager' | 'cashier';

    permissions: string[];
    taxBasisPoints?: number;
    serviceBasisPoints?: number;
    receiptFooter?: string;

    issuedAt: number;
    expiresAt: number;
}

function decodeBase64(value: string): Uint8Array {
    const normalized = value
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const padded = normalized.padEnd(
        Math.ceil(normalized.length / 4) * 4,
        '='
    );

    return Uint8Array.from(
        atob(padded),
        char => char.charCodeAt(0)
    );
}

export function getOfflineDeviceId(): string {
    let id = localStorage.getItem(DEVICE_KEY);

    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DEVICE_KEY, id);
    }

    return id;
}

export function saveOfflineGrant(
    tenantId: string,
    signedGrant: string
): void {
    if (!tenantId || !signedGrant) {
        throw new Error('Invalid offline grant.');
    }

    localStorage.setItem(
        GRANT_PREFIX + tenantId,
        signedGrant
    );
}

export function clearOfflineGrant(
    tenantId: string
): void {
    if (!tenantId) return;

    localStorage.removeItem(
        GRANT_PREFIX + tenantId
    );
}

export function getStoredOfflineGrant(
    tenantId: string
): string | null {
    if (!tenantId) return null;

    return localStorage.getItem(
        GRANT_PREFIX + tenantId
    );
}

// ==========================================
// VERIFY SIGNED OFFLINE GRANT
// Does not modify local storage.
// ==========================================

export async function verifyOfflineGrant(
    signed: string,
    tenantId: string,
    now: number = Date.now(),
    expectedDeviceId: string = getOfflineDeviceId()
): Promise<OfflineGrant | null> {
    try {
        if (
            !signed ||
            !tenantId ||
            !PUBLIC_KEY ||
            !Number.isFinite(now)
        ) {
            return null;
        }

        const parts = signed.split('.');

        if (parts.length !== 2) return null;

        const [payloadB64, signatureB64] = parts;

        if (!payloadB64 || !signatureB64) {
            return null;
        }

        const publicKey =
            await crypto.subtle.importKey(
                'spki',
                decodeBase64(PUBLIC_KEY) as BufferSource,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256'
                },
                false,
                ['verify']
            );

        const verified =
            await crypto.subtle.verify(
                {
                    name: 'ECDSA',
                    hash: 'SHA-256'
                },
                publicKey,
                decodeBase64(
                    signatureB64
                ) as BufferSource,
                new TextEncoder().encode(
                    payloadB64
                ) as BufferSource
            );

        if (!verified) return null;

        const payload = JSON.parse(
            new TextDecoder().decode(
                decodeBase64(payloadB64)
            )
        ) as OfflineGrant;

        const catalogOnly = payload.version === 1 &&
            payload.purpose === 'stratifypos-offline-view' &&
            payload.permissions?.length === 1 &&
            payload.permissions[0] === 'catalog:read';
        const cashAccess = payload.version === 2 &&
            payload.purpose === 'stratifypos-offline-cash' &&
            payload.permissions?.length === 2 &&
            payload.permissions[0] === 'catalog:read' &&
            payload.permissions[1] === 'checkout:cash' &&
            [payload.taxBasisPoints, payload.serviceBasisPoints].every(rate =>
                Number.isInteger(rate) && rate! >= 0 && rate! <= 10000);
        if (
            !(catalogOnly || cashAccess) ||
            payload.tenantId !== tenantId ||
            payload.deviceId !== expectedDeviceId ||
            !payload.userId ||
            !payload.userName ||
            !payload.userEmail ||
            !payload.tenantName ||
            !payload.branchId ||
            !payload.branchName ||
            !['owner', 'manager', 'cashier'].includes(
                payload.role
            ) ||
            !Number.isFinite(payload.issuedAt) ||
            !Number.isFinite(payload.expiresAt) ||
            payload.issuedAt > now ||
            payload.expiresAt <= now ||
            payload.expiresAt <= payload.issuedAt ||
            payload.expiresAt - payload.issuedAt >
                MAX_OFFLINE_MS
        ) {
            return null;
        }

        return payload;

    } catch {
        return null;
    }
}

// ==========================================
// RESTORE ONLY VERIFIED LOCAL ACCESS
// ==========================================

export async function restoreOfflineGrant(
    tenantId: string
): Promise<OfflineGrant | null> {
    const stored = getStoredOfflineGrant(tenantId);

    if (!stored) return null;

    return verifyOfflineGrant(
        stored,
        tenantId
    );
}

// ==========================================
// SECURITY TESTS
// All tests use temporary copies.
// ==========================================

export async function testOfflineGrantSecurity(
    tenantId: string
) {
    const signed = getStoredOfflineGrant(
        tenantId
    );

    if (!signed) {
        throw new Error(
            'No offline grant found. Prepare the offline catalog while online.'
        );
    }

    const valid = await verifyOfflineGrant(
        signed,
        tenantId
    );

    if (!valid) {
        throw new Error(
            'Stored offline grant is invalid or expired.'
        );
    }

    const [payload, signature] = signed.split('.');

    // Change the signature without changing
    // the original saved permission.
    const last = signature.slice(-1);

    const modifiedSignature =
        signature.slice(0, -1) +
        (last === 'A' ? 'B' : 'A');

    // Use a guaranteed different signature byte.
    const signatureBytes = decodeBase64(signature);
    signatureBytes[0] ^= 0x01;

    const tamperedSignature =
        btoa(String.fromCharCode(...signatureBytes))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');

    const tampered = await verifyOfflineGrant(
        `${payload}.${tamperedSignature}`,
        tenantId
    );

    const expired = await verifyOfflineGrant(
        signed,
        tenantId,
        valid.expiresAt + 1000
    );

    const otherTenant = await verifyOfflineGrant(
        signed,
        crypto.randomUUID()
    );

    const otherDevice = await verifyOfflineGrant(
        signed,
        tenantId,
        Date.now(),
        crypto.randomUUID()
    );

    const results = {
        validGrantAccepted: Boolean(valid),
        tamperedGrantRejected: tampered === null,
        expiredGrantRejected: expired === null,
        otherTenantRejected: otherTenant === null,
        otherDeviceRejected: otherDevice === null
    };

    // Do not allow a partial success to pass.
    const passed = Object.values(results)
        .every(Boolean);

    console.table(results);

    if (!passed) {
        throw new Error(
            'Offline security test FAILED.'
        );
    }

    console.log(
        'STRATIFYPOS OFFLINE SECURITY: PASSED'
    );

    return {
        passed,
        results,
        expiresAt: new Date(
            valid.expiresAt
        ).toISOString()
    };
}
