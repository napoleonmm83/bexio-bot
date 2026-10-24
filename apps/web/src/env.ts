import { defineEnvVars } from '@sveltejs/kit/env';

// Runtime env read via $app/env/private. Missing vars become '' — every caller
// treats '' as unset (fail-closed checks in /callback and /auth/bexio).
// INTENTIONAL-UNTESTED: declaration only; exercised by build + the routes' own guards.
export const variables = defineEnvVars({
	BEXIO_CLIENT_ID: { schema: (input) => input ?? '' },
	BEXIO_CLIENT_SECRET: { schema: (input) => input ?? '' },
	BEXIO_REDIRECT_URI: { schema: (input) => input ?? '' },
	BEXIO_ALLOWED_COMPANY: { schema: (input) => input ?? '' },
	NODE_ENV: { schema: (input) => input ?? '' }
});
