import type { RuntimeAuthContext, RuntimeAuthProvider, RuntimeAuthResult } from "./types.js";

export type DemoFormAuthProviderOptions = {
  username: string;
  password: string;
};

export class DemoFormAuthProvider implements RuntimeAuthProvider {
  readonly name = "demo-form";

  constructor(private readonly options: DemoFormAuthProviderOptions) {}

  async authenticate(context: RuntimeAuthContext): Promise<RuntimeAuthResult> {
    await context.page.goto(`${context.origin}/login`, {
      waitUntil: "domcontentloaded"
    });
    await context.page.getByLabel("Username").fill(this.options.username);
    await context.page.getByLabel("Password").fill(this.options.password);
    await Promise.all([
      context.page.waitForURL("**/servicing/search", { timeout: 5000 }),
      context.page.getByRole("button", { name: "Sign In" }).click()
    ]);

    await context.evidence?.record("authentication_completed", {
      payload: {
        provider: this.name,
        principal: this.options.username
      }
    });

    return {
      authenticated: true,
      principal: this.options.username,
      role: this.options.username === "readwrite" ? "READ_WRITE" : "READ_ONLY"
    };
  }
}
