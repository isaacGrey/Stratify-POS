import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, BarChart3, Check, CreditCard, Layers3, Menu, ShoppingCart, Store, Users, WifiOff, X } from 'lucide-react';
import { apiOrigin, appUrl } from './site-routing';
import './marketing.css';

interface Plan {
    id: string;
    title: string;
    price_cents: number;
    promotional_price_cents?: number | null;
    promotion_name?: string;
    max_branches: number;
    max_staff: number;
    trial_days: number;
    module_access?: Record<string, boolean>;
}

const currency = (cents: number) => new Intl.NumberFormat('en-PH', {
    style:'currency',currency:'PHP',maximumFractionDigits:cents % 100 ? 2 : 0
}).format(cents/100);
const navigation = [['product','Product'],['pricing','Pricing'],['faq','FAQ'],['contact','Contact']];
const features = [
    [ShoppingCart,'Point of sale','Set up sizes, add-ons, promotions, taxes, and receipts in one checkout.'],
    [WifiOff,'Offline cash checkout','Prepare a branch catalog, save cash sales offline, and reconcile them when you reconnect.'],
    [Layers3,'Stock and recipes','Track ingredients, finished products, and supplies. Recipe quantities flow into stock movements when you sell.'],
    [Store,'Branch and table management','Set operating hours, allocate stock by branch, and see which tables are reserved or occupied.'],
    [Users,'Team and attendance','Create staff accounts, assign branches and schedules, and record shifts, breaks, and late starts.'],
    [BarChart3,'Reporting','Review sales, discounts, stock movement, and product performance. Export filtered reports to Excel or PDF.']
] as const;
const comparisons = [
    ['pos','Point of sale and offline cash checkout'],['inventory','Inventory and transfers'],
    ['attendance','Team attendance'],['reports','Reports and exports'],['promotions','Promotions and loyalty']
];

async function getPublic(path: string, signal: AbortSignal) {
    const response = await fetch(apiOrigin + '/api/' + path,{ signal });
    if (!response.ok) throw new Error('Live information is temporarily unavailable.');
    return response.json();
}

function ContactForm() {
    const [busy,setBusy] = useState(false);
    const [sent,setSent] = useState(false);
    const [error,setError] = useState('');
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        setError(''); setSent(false); setBusy(true);
        try {
            const response = await fetch(apiOrigin + '/api/public/inquiries',{
                method:'POST',headers:{ 'Content-Type':'application/json' },
                body:JSON.stringify(Object.fromEntries(new FormData(form)))
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.received) throw new Error(result.error || 'Could not send your inquiry. Try again shortly.');
            form.reset();
            setSent(true);
        } catch (error) { setError(error instanceof Error ? error.message : 'Could not send your inquiry.'); }
        finally { setBusy(false); }
    }
    return <form className="marketing-contact-form" onSubmit={submit}>
        <div className="marketing-form-row">
            <label>Name<input name="name" autoComplete="name" required maxLength={120} /></label>
            <label>Work email<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        </div>
        <label>Business name <span>(optional)</span><input name="business" autoComplete="organization" maxLength={120} /></label>
        <label>How can we help?<textarea name="message" rows={4} required minLength={10} maxLength={4000} /></label>
        <div hidden><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <button className="marketing-button" disabled={busy}>{busy ? 'Sending…' : 'Send inquiry'} <ArrowRight size={17}/></button>
        {sent && <p className="marketing-success" role="status"><Check size={17}/> We received your inquiry.</p>}
        {error && <p className="marketing-error" role="alert">{error}</p>}
    </form>;
}

function Marketing() {
    const [plans,setPlans] = useState<Plan[]>([]);
    const [status,setStatus] = useState<'loading'|'ready'|'error'>('loading');
    const [brand,setBrand] = useState({ public_name:'StratifyPOS',support_email:'' });
    const [preview,setPreview] = useState<'pos'|'dashboard'>('pos');
    const [menu,setMenu] = useState(false);
    const trial = plans.find(plan => plan.id==='free' && plan.trial_days>0);
    const cta = trial ? 'Start ' + trial.trial_days + '-day free trial' : 'Create a workspace';
    useEffect(() => {
        const controller = new AbortController();
        void getPublic('plans',controller.signal).then(items => {
            setPlans(items);
            setStatus('ready');
        }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
        void getPublic('public/site',controller.signal).then(settings => {
            if (settings?.public_name) {
                setBrand(settings);
                document.title = settings.public_name + ' | Café point of sale and back office';
            }
        }).catch(() => {});
        return () => controller.abort();
    },[]);
    useEffect(() => {
        const paths = { '/product':'product','/features':'product','/pricing':'pricing','/faq':'faq','/contact':'contact' };
        const section = window.location.hash.slice(1) || paths[window.location.pathname];
        if (section) document.getElementById(section)?.scrollIntoView();
    },[]);
    const faq = [
        ['Can we use it during an internet outage?', 'Yes. Prepare the catalog and offline access for your branch while connected. Cash sales can then be saved locally and synchronized when the connection returns. Pricing, stock, and table conflicts stay visible for review.'],
        ['Can I manage more than one branch?', 'Yes. Plans have different branch and team limits. You can allocate stock to each location and restrict a team member to assigned branches.'],
        ['How does subscription payment work?', 'Choose a plan and a payment method, follow the merchant instructions, and submit your transaction reference and screenshot. Your subscription updates after a platform administrator verifies the payment.'],
        ['What is included in the free trial?', trial
            ? 'The current trial lasts ' + trial.trial_days + ' days and includes ' + trial.max_branches + ' branch' +
                (trial.max_branches===1 ? '' : 'es') + ' and ' + trial.max_staff + ' team accounts. Select the free trial during registration.'
            : 'Trial availability and limits are listed with the live plans.'],
        ['Can I export sales and inventory data?', 'Yes. Reports can be filtered by date and branch and downloaded in Excel or PDF.']
    ];

    return <div className="marketing">
        <a className="marketing-skip" href="#main-content">Skip to content</a>
        <header className="marketing-header">
            <div className="marketing-frame marketing-header-row">
                <a href="/" className="marketing-brand" aria-label={brand.public_name + ' home'}>
                    <img src="/stratify-logo.png" alt="" width="34" height="34"/><span>{brand.public_name}</span>
                </a>
                <nav className={'marketing-nav ' + (menu ? 'is-open' : '')} aria-label="Product navigation">
                    {navigation.map(([id,label]) => <a key={id} href={'#'+id} onClick={() => setMenu(false)}>{label}</a>)}
                </nav>
                <div className="marketing-header-actions">
                    <a className="marketing-login" href={appUrl('/login')}>Sign in</a>
                    <a className="marketing-button compact" href={appUrl('/register')}>Get started <ArrowRight size={15}/></a>
                    <button className="marketing-menu" aria-label={menu ? 'Close navigation' : 'Open navigation'}
                        aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X size={23}/> : <Menu size={23}/>}</button>
                </div>
            </div>
        </header>
        <main id="main-content">
            <section className="marketing-hero">
                <div className="marketing-frame marketing-hero-grid">
                    <div className="marketing-hero-copy">
                        <p className="marketing-kicker">For cafés and food businesses</p>
                        <h1>Point of sale<br/>and back office,<br/><em>in one workspace.</em></h1>
                        <p className="marketing-intro">Take orders at the counter, track recipe stock by branch, and see how the business is doing from the same app.</p>
                        <div className="marketing-cta-row">
                            <a className="marketing-button" href={appUrl('/register')}>{cta} <ArrowRight size={17}/></a>
                            <a className="marketing-text-link" href="#product">Explore the product</a>
                        </div>
                    </div>
                    <figure className="marketing-preview">
                        <div className="marketing-preview-bar">
                            <div className="marketing-preview-tabs" aria-label="Choose a preview">
                                <button aria-pressed={preview==='pos'} onClick={() => setPreview('pos')}><ShoppingCart size={15}/> Checkout</button>
                                <button aria-pressed={preview==='dashboard'} onClick={() => setPreview('dashboard')}><BarChart3 size={15}/> Dashboard</button>
                            </div>
                            <span>Demo workspace</span>
                        </div>
                        <img src={'/previews/'+preview+'.png'} alt={preview==='pos' ?
                            'StratifyPOS checkout showing products and the order cart' :
                            'StratifyPOS dashboard showing sales, transactions, and stock alerts'} width="1440" height="900" />
                    </figure>
                </div>
            </section>
            <section id="product" className="marketing-section marketing-frame">
                <div className="marketing-section-heading">
                    <h2>From the counter to the back office</h2>
                    <p>Workflows for selling, managing locations, and closing the day.</p>
                </div>
                <div className="marketing-features">
                    {features.map(([Icon,title,body]) => <article key={title}>
                        <Icon size={24} strokeWidth={1.7}/><h3>{title}</h3><p>{body}</p>
                    </article>)}
                </div>
            </section>
            <section id="pricing" className="marketing-section marketing-pricing">
                <div className="marketing-frame">
                    <div className="marketing-section-heading"><h2>Plans and pricing</h2>
                        <p>Compare branch limits, team accounts, and included modules.</p></div>
                    {status==='loading' && <p role="status">Loading live plans…</p>}
                    {status==='error' && <p className="marketing-error" role="alert">Live pricing is temporarily unavailable.</p>}
                    {status==='ready' && !plans.length && <p>No plans are available for new workspaces right now.</p>}
                    {!!plans.length && <>
                        <div className="marketing-plans">
                            {plans.map(plan => <article key={plan.id} className={plan.id==='free' ? 'marketing-plan trial' : 'marketing-plan'}>
                                <h3>{plan.title}</h3>
                                <p className="marketing-price">{currency(plan.promotional_price_cents ?? plan.price_cents)}
                                    <small>{plan.id==='free' ? ' / ' + plan.trial_days + ' days' : ' / month'}</small></p>
                                {plan.promotional_price_cents != null && <p className="marketing-promo"><s>{currency(plan.price_cents)}</s> · {plan.promotion_name || 'Promotional price'}</p>}
                                <ul>
                                    <li><Check size={16}/>{plan.max_branches} branch{plan.max_branches===1 ? '' : 'es'}</li>
                                    <li><Check size={16}/>{plan.max_staff} team accounts</li>
                                </ul>
                                <a className="marketing-button secondary" href={appUrl('/register?plan='+encodeURIComponent(plan.id))}>
                                    {plan.id==='free' ? 'Start free trial' : 'Choose ' + plan.title} <ArrowRight size={16}/>
                                </a>
                            </article>)}
                        </div>
                        <div className="marketing-comparison">
                            <table>
                                <caption>Compare included features</caption>
                                <thead><tr><th scope="col">Feature</th>{plans.map(plan => <th scope="col" key={plan.id}>{plan.title}</th>)}</tr></thead>
                                <tbody>
                                    <tr><th scope="row">Branches</th>{plans.map(plan => <td key={plan.id}>{plan.max_branches}</td>)}</tr>
                                    <tr><th scope="row">Team accounts</th>{plans.map(plan => <td key={plan.id}>{plan.max_staff}</td>)}</tr>
                                    {comparisons.map(([key,label]) => <tr key={key}><th scope="row">{label}</th>
                                        {plans.map(plan => <td key={plan.id}>{plan.module_access?.[key]===false ? '—' : 'Included'}</td>)}
                                    </tr>)}
                                </tbody>
                            </table>
                        </div>
                    </>}
                    <p className="marketing-payment-note"><CreditCard size={18}/> Subscription payments are verified by the platform team after receipt submission.</p>
                </div>
            </section>
            <section id="faq" className="marketing-frame marketing-section marketing-faq">
                <div className="marketing-section-heading"><h2>Common questions</h2></div>
                <div>{faq.map(([question,answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
            </section>
            <section id="contact" className="marketing-contact">
                <div className="marketing-frame marketing-contact-grid">
                    <div><h2>Talk to us about your business</h2>
                        <p>Ask about setting up a branch, choosing a plan, or moving your café to {brand.public_name}.</p>
                        {brand.support_email && <a href={'mailto:'+brand.support_email}>{brand.support_email}</a>}
                    </div>
                    <ContactForm/>
                </div>
            </section>
        </main>
        <footer className="marketing-frame marketing-footer">
            <a className="marketing-brand" href="/"><img src="/stratify-logo.png" alt="" width="30" height="30"/>{brand.public_name}</a>
            <a href={appUrl('/login')}>Sign in to your workspace <ArrowRight size={15}/></a>
        </footer>
    </div>;
}

createRoot(document.getElementById('root')!).render(<Marketing />);
