/**
 * What to offer at startup (br-CONN-000006-sJpO9KMY) and a new Sump's details
 * (br-CONN-000003-sJpO9KMY), REQ-000014-sJpO9KMY Requirements 1 and 2.
 */
import type { Catalog } from "../catalog/catalog.js";
import type { Runner } from "./runner.js";

/** What the Add Sump flow can offer. */
export type Offer = "local" | "remote" | "skip";

/** The startup plan. */
export interface StartupPlan {
  /** No live Sump in the catalog. */
  firstRun: boolean;
  /** Docker answers on this machine. */
  docker: boolean;
  offers: Offer[];
}

/** Whether Docker answers here (`docker version`, within 10 s). */
export async function dockerAvailable(run: Runner): Promise<boolean> {
  const result = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 10_000,
  });
  return result.code === 0 && result.stdout.trim() !== "";
}

/**
 * What to offer: a local Sump only with Docker; a remote Sump always; Skip
 * only on a first run with Docker (br-CONN-000006).
 */
export async function startupPlan(catalog: Catalog | undefined, run: Runner): Promise<StartupPlan> {
  const firstRun = (catalog?.list() ?? []).length === 0;
  const docker = await dockerAvailable(run);
  const offers: Offer[] = [];
  if (docker) offers.push("local");
  offers.push("remote");
  if (firstRun && docker) offers.push("skip");
  return { firstRun, docker, offers };
}

/** A new remote Sump's details, checked. */
export interface RemoteDetails {
  name?: string;
  /** `host` or `user@host`. */
  sshTarget: string;
  sshPort: number;
  sumpPort: number;
}

/** Details the Add Sump flow refuses, with the reason. */
export class DetailsError extends Error {
  override readonly name = "DetailsError";
}

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

function portOf(value: unknown, fallback: number, what: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new DetailsError(`${what} must be a whole number from 1 to 65535.`);
  }
  return n;
}

/**
 * Check a new remote Sump's details before anything runs
 * (br-CONN-000003): the SSH target is `host` or `user@host` of plain
 * characters (an IPv6 address in brackets), ports are 1-65535 (SSH 22 and
 * Sump 8765 by default).
 */
export function checkRemoteDetails(input: unknown): RemoteDetails {
  const raw = (input ?? {}) as Record<string, unknown>;
  const target = typeof raw.sshTarget === "string" ? raw.sshTarget.trim() : "";
  const at = target.lastIndexOf("@");
  const user = at === -1 ? undefined : target.slice(0, at);
  const host = at === -1 ? target : target.slice(at + 1);
  if (!target || !HOST.test(host) || (user !== undefined && !USER.test(user))) {
    throw new DetailsError(
      'The SSH target must be "host" or "user@host", with letters, digits, dots and dashes only.',
    );
  }
  const details: RemoteDetails = {
    sshTarget: target,
    sshPort: portOf(raw.sshPort, 22, "The SSH port"),
    sumpPort: portOf(raw.sumpPort, 8765, "The Sump port"),
  };
  if (typeof raw.name === "string" && raw.name.trim()) details.name = raw.name.trim().slice(0, 100);
  return details;
}
