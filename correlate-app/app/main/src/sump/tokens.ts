/**
 * Session tokens in the main process (br-CONN-000004-sJpO9KMY,
 * REQ-000010-sJpO9KMY Requirement 4): one per Sump, in memory only, so no
 * token is ever written to disk and quitting the app forgets them all
 * (decided in FEAT-000011-sJpO9KMY). The SSH-key login of Item 12 puts them
 * here; a Sump refusing one (401) takes it out.
 */
export class SessionTokens {
  private readonly tokens = new Map<string, string>();

  /** The token for the Sump named `sump`, if logged in. */
  get(sump: string): string | undefined {
    return this.tokens.get(sump);
  }

  /** Remember the token a Sump issued. */
  set(sump: string, token: string): void {
    this.tokens.set(sump, token);
  }

  /** Forget the token for one Sump. */
  forget(sump: string): void {
    this.tokens.delete(sump);
  }

  /** The Sumps logged in to. */
  sumps(): string[] {
    return [...this.tokens.keys()];
  }
}
