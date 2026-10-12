import { config } from "dotenv";
import { expect } from "vitest";
import { createSevdeskClient, type SevdeskClient } from "../src/client.js";

// Load .env file
config();

const API_TOKEN = process.env.SEVDESK_API_TOKEN;

if (!API_TOKEN) {
  console.error("Hinweis: SEVDESK_API_TOKEN nicht gesetzt in .env Datei");
  console.error("   Tests werden übersprungen.");
}

export const hasApiToken = !!API_TOKEN;

export function getClient(): SevdeskClient {
  if (!API_TOKEN) {
    throw new Error("SEVDESK_API_TOKEN nicht gesetzt");
  }
  return createSevdeskClient(API_TOKEN);
}

export function skipIfNoToken() {
  if (!hasApiToken) {
    console.log("Test übersprungen: kein API-Token");
    return true;
  }
  return false;
}

/**
 * Asserts that an API result is present and narrows its type, since
 * openapi-fetch types every response body as possibly undefined.
 */
export function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
