import { useState, type FormEvent } from 'react';

export interface PaymentMethod {
    id: string;
    name: string;
    instructions?: string;
    customer_enabled?: boolean;
}

export async function fetchPaymentMethods(api: string): Promise<PaymentMethod[]> {
    const response = await fetch(api + '/api/billing/methods', { cache: 'no-store' });
    if (!response.ok) throw new Error('Payment methods could not be loaded.');
    return response.json();
}

export const paymentStageLabel = {
    awaiting_receipt: 'Awaiting receipt',
    under_review: 'Under review',
    paid: 'Verified',
    failed: 'Rejected',
    refunded: 'Refunded'
};

export function ReceiptSubmission({ url, token, tenant, onSubmitted }: {
    url: string;
    token: string;
    tenant?: string;
    onSubmitted: (result: { status: string; stage: string; submitted_at: string }) => void;
}) {
    const [reference, setReference] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!file || busy) return;
        setError('');
        if (file.size > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(file.type)) {
            setError('Choose a PNG or JPEG image up to 5 MB.');
            return;
        }
        setBusy(true);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': file.type,
                    'X-Payment-Reference': reference.trim(),
                    ...(tenant ? { 'X-Tenant-Id': tenant } : {})
                },
                body: file
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'The receipt could not be submitted.');
            onSubmitted(data);
        } catch (error) {
            setError(error instanceof Error ? error.message : 'The receipt could not be submitted.');
        } finally {
            setBusy(false);
        }
    }

    return <form className="settings-form" onSubmit={submit}>
        <label className="field"><span>Transaction reference</span>
            <input required minLength={4} maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9\-]{3,79}"
                value={reference} onChange={event => setReference(event.target.value)} />
        </label>
        <label className="field"><span>Payment screenshot (PNG or JPEG, up to 5 MB)</span>
            <input required type="file" accept="image/png,image/jpeg" onChange={event => setFile(event.target.files?.[0] ?? null)} />
        </label>
        {error && <p className="flash error" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !file || !token}>
            {busy ? 'Submitting…' : 'Submit receipt for review'}
        </button>
    </form>;
}
