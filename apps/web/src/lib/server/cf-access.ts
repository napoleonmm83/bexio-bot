// Cloudflare Access JWT verification.
//
// Every request that passes CF Access (user OTP login OR service-token auth)
// arrives at the origin carrying a `Cf-Access-Jwt-Assertion` header. The JWT
// is signed by Cloudflare with rotating RS256 keys exposed at:
//   https://{team}.cloudflareaccess.com/cdn-cgi/access/certs
//
// We verify origin-side (defense-in-depth): even if someone bypasses CF and
// hits the origin directly, requests without a valid CF-signed JWT are 401.
// Once the Hetzner firewall locks origin to CF IPs only, this becomes
// belt-and-suspenders.
//
// Env vars (set in Coolify):
//   CF_ACCESS_TEAM_DOMAIN  e.g. "martini" (no .cloudflareaccess.com suffix)
//   CF_ACCESS_AUD          the AUD tag of the bexio-bot CF Access app
//
// Both are required for verification. If either is missing the verifier
// refuses every request — fail-closed, never silently allow.

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';

const JWT_HEADER = 'cf-access-jwt-assertion';

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeamDomain: string | null = null;

function getJwks(teamDomain: string) {
  if (jwksCache && jwksTeamDomain === teamDomain) return jwksCache;
  jwksTeamDomain = teamDomain;
  jwksCache = createRemoteJWKSet(
    new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`),
    {
      cacheMaxAge: 6 * 60 * 60 * 1000, // 6h — CF rotates keys ~daily
      cooldownDuration: 30 * 1000,
    },
  );
  return jwksCache;
}

export type CfAccessIdentity = {
  /** "service-token" for machine-to-machine, otherwise user email */
  subject: string;
  /** sub claim — service-token ID or user UUID */
  sub: string;
  /** present for user-auth, undefined for service tokens */
  email?: string;
  /** the AUD tag of the CF Access app */
  aud: string;
  raw: JWTPayload;
};

/**
 * Verify the `Cf-Access-Jwt-Assertion` header. Throws on any failure.
 * Returns the identity claims so callers can log who triggered the action.
 */
export async function verifyCfAccess(request: Request): Promise<CfAccessIdentity> {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = process.env.CF_ACCESS_AUD;

  if (!teamDomain || !expectedAud) {
    throw new CfAccessError(
      'server-misconfigured',
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set',
    );
  }

  const token = request.headers.get(JWT_HEADER);
  if (!token) {
    throw new CfAccessError('missing-header', `${JWT_HEADER} header not present`);
  }

  const jwks = getJwks(teamDomain);
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: `https://${teamDomain}.cloudflareaccess.com`,
      audience: expectedAud,
    });
    payload = result.payload;
  } catch (err) {
    throw new CfAccessError(
      'verify-failed',
      err instanceof Error ? err.message : String(err),
    );
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const subject = email ?? (typeof payload.common_name === 'string' ? `service:${payload.common_name}` : `service:${sub}`);

  return {
    subject,
    sub,
    email,
    aud: expectedAud,
    raw: payload,
  };
}

export class CfAccessError extends Error {
  constructor(public readonly code: 'missing-header' | 'verify-failed' | 'server-misconfigured', message: string) {
    super(message);
    this.name = 'CfAccessError';
  }
}
