import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const privateKeyPath = process.env.OFFLINE_PRIVATE_KEY_FILE;
const privateKey = privateKeyPath ? createPrivateKey(readFileSync(privateKeyPath)) : null;
const publicKey = privateKey && createPublicKey(privateKey);
if (privateKey && (privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1')) {
    throw new Error('Offline signing key must use P-256');
}

export function issueSignedOfflineGrant(payload) {
    if (!privateKey) {
        throw Object.assign(new Error('Offline checkout is not configured'), { status: 503 });
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = sign('sha256', Buffer.from(encoded), {
        key: privateKey, dsaEncoding: 'ieee-p1363'
    });
    return encoded + '.' + signature.toString('base64url');
}

export function verifyOfflineSaleGrant(signed, scope, createdAt, now = Date.now()) {
    if (!publicKey || typeof signed !== 'string' || signed.length > 8192) return null;
    try {
        const parts = signed.split('.');
        if (parts.length !== 2 || !verify('sha256', Buffer.from(parts[0]), {
            key: publicKey, dsaEncoding: 'ieee-p1363'
        }, Buffer.from(parts[1], 'base64url'))) return null;
        const grant = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        const soldAt = Date.parse(createdAt);
        if (grant.version !== 2 || grant.purpose !== 'stratifypos-offline-cash' ||
            !grant.permissions?.includes('checkout:cash') ||
            !Number.isFinite(soldAt) || soldAt > now + 60_000 ||
            soldAt < grant.issuedAt || soldAt >= grant.expiresAt ||
            !Object.entries(scope).every(([key, value]) => grant[key] === value)) return null;
        return grant;
    } catch {
        return null;
    }
}
