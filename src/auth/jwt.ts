/**
 * Shared JWT authentication — used by both gateway and commander server.
 * Uses jose for HS256 JWT creation and verification.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "spacemolt-commander-jwt-secret-2026"
);

const ISSUER = "spacemolt-gateway";
const EXPIRY = "24h";

export interface TokenPayload extends JWTPayload {
  sub: string;       // userId
  username: string;
  role: string;       // "owner" | "operator" | "viewer"
  tier: string;       // "free" | "byok" | "pro"
  tenantId?: string;  // tenant ID for scoping
}

/**
 * Create a signed JWT token.
 */
export async function createToken(payload: Omit<TokenPayload, "iss" | "iat" | "exp">): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(EXPIRY)
    .sign(JWT_SECRET);
}

/**
 * Verify and decode a JWT token. Returns null if invalid/expired.
 */
export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: ISSUER });
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Extract bearer token from Authorization header value.
 * Accepts "Bearer <token>" or raw "<token>".
 */
export function extractToken(authHeader?: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7);
  return authHeader;
}

/**
 * Hash a password using Bun's built-in bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });
}

/**
 * Verify a password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
