import { createApiClient } from "@figtest/contracts";

/** Origin of the api (NestJS). Called directly from the browser with the session cookie. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export const api = createApiClient(API_URL);
