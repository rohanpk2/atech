// Vercel Routing Middleware: HTTP Basic sign-in for every path of the hosted dashboards,
// pages and /api/* alike. Credentials come from the Vercel environment variables
// ATECH_DASHBOARD_USER and ATECH_DASHBOARD_PASSWORD; when either is missing the site answers
// 503 for everything rather than opening up. The backend key is never involved here: Vercel
// adds it to the proxied /api request through the route transform in vercel.json.
import {next} from '@vercel/functions';
import {authorize} from './lib/basic-auth.js';

const REALM = 'Basic realm="Atech dashboard", charset="UTF-8"';
const TEXT = {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'};

export default function middleware(request) {
  const decision = authorize(request.headers.get('authorization'), {
    user: process.env.ATECH_DASHBOARD_USER,
    password: process.env.ATECH_DASHBOARD_PASSWORD,
  });
  if (decision.status === 'unconfigured') {
    return new Response('This dashboard has no sign-in configured. Set ATECH_DASHBOARD_USER and ATECH_DASHBOARD_PASSWORD in the Vercel project and redeploy.',
                        {status: 503, headers: TEXT});
  }
  if (decision.status === 'denied') {
    return new Response('Sign in to use the Atech dashboard.', {status: 401, headers: {...TEXT, 'www-authenticate': REALM}});
  }
  return next();
}
