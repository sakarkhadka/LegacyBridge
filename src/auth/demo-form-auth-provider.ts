import type { RuntimeAuthContext, RuntimeAuthProvider, RuntimeAuthResult } from "./types.js";

export type DemoFormAuthProviderOptions = {
  username: string;
  password: string;
  loginPath?: string;
  usernameLabel?: string;
  passwordLabel?: string;
  submitLabel?: string;
  postLoginPath?: string;
  roleByUsername?: Record<string, string>;
};

export class DemoFormAuthProvider implements RuntimeAuthProvider {
  readonly name = "demo-form";

  constructor(private readonly options: DemoFormAuthProviderOptions) {}

  async authenticate(context: RuntimeAuthContext): Promise<RuntimeAuthResult> {
    await context.page.goto(`${context.origin}${this.options.loginPath ?? "/login"}`, {
      waitUntil: "domcontentloaded"
    });
    await context.page.getByLabel(this.options.usernameLabel ?? "Username").fill(this.options.username);
    await context.page.getByLabel(this.options.passwordLabel ?? "Password").fill(this.options.password);
    await Promise.all([
      context.page.waitForURL(`**${this.options.postLoginPath ?? "/servicing/search"}`, { timeout: 5000 }),
      context.page.getByRole("button", { name: this.options.submitLabel ?? "Sign In" }).click()
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
      role: this.options.roleByUsername?.[this.options.username] ?? (this.options.username === "readwrite" ? "READ_WRITE" : "READ_ONLY")
    };
  }
}
