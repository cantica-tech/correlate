/**
 * Logging in to a Sump (br-CONN-000007-sJpO9KMY, br-CONN-000004-sJpO9KMY,
 * REQ-000011-sJpO9KMY Requirement 4): ask for a challenge, sign it with the
 * identity key, and keep the token the Sump issues, in memory.
 */
import type { KeyObject } from "node:crypto";
import { LOGIN_NAMESPACE, signSshsig } from "../identity/sshkey.js";
import { type Logger, request } from "./client.js";
import type { Sump } from "./errors.js";
import type { SessionTokens } from "./tokens.js";

/** What a successful login returns. */
export interface LoginResult {
  user: string;
  owner: boolean;
}

/** Log in to `sump` as `user` with `key`, keeping the token in `tokens`. */
export async function login(
  sump: Sump,
  user: string,
  key: KeyObject,
  tokens: SessionTokens,
  logger?: Logger,
): Promise<LoginResult> {
  const plain = { name: sump.name, baseUrl: sump.baseUrl };
  const { challenge, namespace } = await request<{ challenge: string; namespace: string }>(
    plain,
    "POST",
    "/session/challenge",
    { body: { user }, logger },
  );
  if (namespace !== LOGIN_NAMESPACE) {
    throw new Error(`Sump "${sump.name}" asked for a signature in namespace "${namespace}"`);
  }
  const signature = signSshsig(key, challenge, LOGIN_NAMESPACE);
  const result = await request<{ token: string; user: string; owner: boolean }>(
    plain,
    "POST",
    "/session/login",
    { body: { user, challenge, signature }, logger },
  );
  tokens.set(sump.name, result.token);
  return { user: result.user, owner: result.owner };
}
