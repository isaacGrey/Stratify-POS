import { applicationOrigin, appUrl, marketingOrigin, publicUrl } from './site-routing';

const { pathname, search, hash, origin } = window.location;
const applicationPath = /^\/(app|login|register|invite|reset)(\/|$)/.test(pathname);
const applicationHost = applicationOrigin && origin===applicationOrigin && origin!==marketingOrigin;
const load = {
    application: () => import('./main'),
    marketing: () => import('./marketing')
};

if (applicationPath && applicationOrigin && origin!==applicationOrigin) {
    window.location.replace(appUrl(pathname + search + hash));
} else if (pathname==='/' && (!applicationOrigin || origin===applicationOrigin) && localStorage.getItem('crema-token')) {
    window.location.replace(appUrl('/app'));
} else if (!applicationPath && pathname!=='/' && applicationHost && marketingOrigin) {
    window.location.replace(publicUrl(pathname + search + hash));
} else {
    void load[applicationPath || applicationHost ? 'application' : 'marketing']();
}
