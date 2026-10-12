import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

const REALM = "mcp-sevdesk";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header (RFC 6750).
 * Returns undefined if the header is missing or uses another scheme.
 */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer[ ]+([^\s]+)[ ]*$/i.exec(header);
  return match?.[1];
}

/**
 * Express middleware that requires a static bearer token.
 *
 * Both values are hashed before comparison so that timingSafeEqual always
 * compares buffers of equal length and neither content nor length of the
 * expected token leaks through response timing.
 */
export function requireStaticBearerToken(expectedToken: string): RequestHandler {
  const expectedDigest = digest(expectedToken);

  return (req, res, next) => {
    const token = parseBearerToken(req.headers.authorization);

    if (token !== undefined && timingSafeEqual(digest(token), expectedDigest)) {
      next();
      return;
    }

    const challenge =
      token === undefined
        ? `Bearer realm="${REALM}"`
        : `Bearer realm="${REALM}", error="invalid_token"`;

    res
      .status(401)
      .set("WWW-Authenticate", challenge)
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
  };
}
