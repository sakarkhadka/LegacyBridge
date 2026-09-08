export type TenantAuthProvider = "demo-form";

export type TenantProfile = {
  tenantId: string;
  displayName: string;
  application: {
    appFamily: string;
    defaultOrigin: string;
    fingerprint: {
      expectedTitle?: string;
      requiredText?: string[];
    };
  };
  auth?: {
    provider: TenantAuthProvider;
    loginPath?: string;
    usernameLabel?: string;
    passwordLabel?: string;
    submitLabel?: string;
    postLoginPath?: string;
    defaultRuntimeUser?: string;
    defaultRuntimePassword?: string;
    roleByUsername?: Record<string, string>;
  };
  policy?: {
    allowedOrigins?: string[];
    allowedRoutes?: string[];
    evidenceRetention?: string;
  };
  demoDefaults?: {
    memberId?: string;
    accountNumber?: string;
    amount?: string;
  };
  capabilities: Record<string, {
    path: string;
    status?: "draft" | "validated" | "approved" | "active" | "deprecated";
  }>;
};
