'use strict';

// Runtime configuration for both dashboards, loaded before the other shared scripts.
// The builder backend serves this default: same-origin API, live progress over SSE with a
// polling fallback, local copy. The Vercel build (vercel-frontend/build.js) overwrites this
// file in its output with transport 'poll' and hosted true; it never edits the dashboards.
window.ATECH_CONFIG = {apiBase: '', transport: 'auto', hosted: false, pollMs: 2000};
