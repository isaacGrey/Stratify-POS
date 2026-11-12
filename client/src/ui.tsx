import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ShoppingBag, X } from 'lucide-react';

export const money = v => '₱' + (Number(v || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const pesos = v => Math.round(Number(v || 0) * 100);
export const fmt = d => d ? new Date(d).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function Heading({ eyebrow, title, sub, action }: {
    eyebrow?: string;
    title: string;
    sub?: string;
    action?: React.ReactNode;
}) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow || 'YOUR WORKSPACE'}</div><h1>{title}</h1><p>{sub}</p></div>{action}</div>; }
export function Button({ children, onClick, secondary = false, disabled = false, ...props }: {
    children: React.ReactNode;
    onClick?: (...args: any[]) => void;
    secondary?: boolean;
    disabled?: boolean;
    [key: string]: any;
}) { return <button className={'btn ' + (secondary ? 'btn-outline' : 'btn-primary')} onClick={onClick} disabled={disabled} {...props}>{children}</button>; }
export function Panel({ title, right, children, className = '' }: {
    title: string;
    right?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}) { return <section className={'panel ' + className}><div className="panel-head"><h3>{title}</h3>{right}</div>{children}</section>; }
export function Load() { return <div className="loading">Loading live shop data…</div>; }
export function useLoad(request, path, deps = []) {
    const [state, setState] = useState(null);
    const generation = useRef(0);
    const load = useCallback(() => {
        if (!path) return;
        const current = ++generation.current;
        request(path).then(data => {
            if (generation.current === current) setState({ request, path, data, err: '' });
        }).catch(error => {
            if (generation.current === current) setState({ request, path, data: null, err: error.message });
        });
    }, [request, path, ...deps]);
    useEffect(() => {
        load();
        return () => { generation.current++; };
    }, [load]);
    const current = state?.path === path && state?.request === request ? state : null;
    return { data: current?.data ?? null, err: current?.err || '', load };
}
export function Empty({ text = 'Nothing here yet.' }) { return <div className="empty"><ShoppingBag size={28}/><p>{text}</p></div>; }

export function Table({ columns, items = [] }) {
    return (
        <div className="table-scroll">
            <table>
                <thead>
                    <tr>
                        {columns.map(([key, label], index) => (
                            <th key={`${String(key)}-${index}`}>
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>

                <tbody>
                    {items.length > 0 ? (
                        items.map((item, rowIndex) => (
                            <tr key={item.id ?? rowIndex}>
                                {columns.map(
                                    ([key, _label, formatter], columnIndex) => (
                                        <td
                                            key={`${String(key)}-${columnIndex}`}
                                        >
                                            {formatter
                                                ? formatter(item[key], item)
                                                : item[key] ?? '—'}
                                        </td>
                                    )
                                )}
                            </tr>
                        ))
                    ) : (
                        <tr>
                            <td
                                className="muted"
                                colSpan={columns.length}
                            >
                                No records found.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export function Modal({ title, onClose, children }) {
    const heading = useId();
    const panel = useRef<HTMLElement>(null);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const previous = document.activeElement;
        panel.current?.focus();
        return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
    }, []);
    function handleKey(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close.current();
        }
        if (event.key !== 'Tab') return;
        const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
        ) ?? [])].filter(element => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }
    return <div className="modal-backdrop" onMouseDown={onClose}>
        <section ref={panel} className="modal" role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1}
            onKeyDown={handleKey} onMouseDown={event => event.stopPropagation()}>
            <div className="modal-head"><h2 id={heading}>{title}</h2>
                <button aria-label="Close dialog" className="icon-btn" onClick={onClose}><X size={20} /></button>
            </div>
            {children}
        </section>
    </div>;
}
export function Field({ label, children }: {
    label: string;
    children: React.ReactNode;
    key?: React.Key;
}) { return <label className="field"><span>{label}</span>{children}</label>; }

