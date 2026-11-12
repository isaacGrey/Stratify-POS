
import React, {
    useEffect,
    useState
} from 'react';

import {
    ShieldAlert,
    LockKeyhole
} from 'lucide-react';

import {
    restoreOfflineGrant
} from './offlineSession';

import {
    getCatalogStatus
} from './catalog';

interface Props {
    tenantId: string;
    online: boolean | null;
    children: React.ReactNode;
}

export default function OfflineSessionGuard({
    tenantId,
    online,
    children
}: Props) {
    const [authorization, setAuthorization] =
        useState<{
            tenantId: string;
            allowed: boolean;
            checked: boolean;
        }>({
            tenantId,
            allowed: false,
            checked: false
        });

    useEffect(() => {
        let disposed = false;
        let checking = false;

        setAuthorization({
            tenantId,
            allowed: false,
            checked: false
        });

        async function verify() {
            if (checking || disposed) return;

            if (online === true) {
                setAuthorization({
                    tenantId,
                    allowed: true,
                    checked: true
                });
                return;
            }

            if (online === null) return;

            checking = true;

            try {
                const grant = await restoreOfflineGrant(
                    tenantId
                );

                let allowed = false;

                if (grant) {
                    const catalog =
                        await getCatalogStatus(
                            tenantId,
                            grant.branchId
                        );

                    allowed = catalog.ready;
                }

                if (!disposed) {
                    setAuthorization({
                        tenantId,
                        allowed,
                        checked: true
                    });
                }

            } catch {
                if (!disposed) {
                    setAuthorization({
                        tenantId,
                        allowed: false,
                        checked: true
                    });
                }

            } finally {
                checking = false;
            }
        }

        const onVisibilityChange = () => {
            if (!document.hidden) {
                void verify();
            }
        };

        const onStorageChange = () => {
            void verify();
        };

        const interval = window.setInterval(
            () => void verify(),
            5000
        );

        window.addEventListener(
            'focus',
            onStorageChange
        );

        window.addEventListener(
            'storage',
            onStorageChange
        );

        document.addEventListener(
            'visibilitychange',
            onVisibilityChange
        );

        void verify();

        return () => {
            disposed = true;
            window.clearInterval(interval);

            window.removeEventListener(
                'focus',
                onStorageChange
            );

            window.removeEventListener(
                'storage',
                onStorageChange
            );

            document.removeEventListener(
                'visibilitychange',
                onVisibilityChange
            );
        };
    }, [tenantId, online]);

    // Online mode still uses the existing
    // server authentication and permissions.
    if (online === true) {
        return <>{children}</>;
    }

    if (
        online === null ||
        !authorization.checked ||
        authorization.tenantId !== tenantId
    ) {
        return (
            <div className="panel" style={{
                padding: 28,
                textAlign: 'center'
            }}>
                Checking offline authorization...
            </div>
        );
    }

    if (!authorization.allowed) {
        return (
            <section className="panel" style={{
                padding: 32,
                textAlign: 'center'
            }}>
                <LockKeyhole
                    size={42}
                    color="#D97706"
                />

                <h2 style={{ marginTop: 16 }}>
                    Offline POS Locked
                </h2>

                <p style={{ marginTop: 12 }}>
                    Your offline permission is
                    missing, expired, or invalid.
                </p>

                <p style={{
                    marginTop: 12,
                    color: '#64748b',
                    fontSize: 13
                }}>
                    Connect to the server and sign in
                    to renew your offline access.
                </p>

                <div style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 20
                }}>
                    <ShieldAlert size={16} />

                    <strong>
                        Checkout unavailable
                    </strong>
                </div>
            </section>
        );
    }

    return <>{children}</>;
}
