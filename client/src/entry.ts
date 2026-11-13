// Public portfolio deployment: never mount the production auth/API application.
if (import.meta.env.VITE_PORTFOLIO_DEMO === 'true') {
    void import('./demo');
} else {
    void import('./production-entry');
}
