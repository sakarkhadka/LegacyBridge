import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { TenantProfile } from "./types.js";

const capabilityStatusSchema = z.enum(["draft", "validated", "approved", "active", "deprecated"]);

const tenantProfileSchema = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  application: z.object({
    appFamily: z.string().min(1),
    defaultOrigin: z.string().url(),
    fingerprint: z.object({
      expectedTitle: z.string().optional(),
      requiredText: z.array(z.string()).optional()
    }).default({})
  }),
  auth: z.object({
    provider: z.literal("demo-form"),
    loginPath: z.string().default("/login"),
    usernameLabel: z.string().default("Username"),
    passwordLabel: z.string().default("Password"),
    submitLabel: z.string().default("Sign In"),
    postLoginPath: z.string().default("/servicing/search"),
    defaultRuntimeUser: z.string().optional(),
    defaultRuntimePassword: z.string().optional(),
    roleByUsername: z.record(z.string(), z.string()).optional()
  }).optional(),
  policy: z.object({
    allowedOrigins: z.array(z.string()).optional(),
    allowedRoutes: z.array(z.string()).optional(),
    evidenceRetention: z.string().optional()
  }).optional(),
  demoDefaults: z.object({
    memberId: z.string().optional(),
    accountNumber: z.string().optional(),
    amount: z.string().optional()
  }).optional(),
  capabilities: z.record(z.string(), z.object({
    path: z.string().min(1),
    status: capabilityStatusSchema.optional()
  })).refine((capabilities) => Object.keys(capabilities).length > 0, {
    message: "Tenant profile must map at least one capability"
  })
});

export async function loadTenantProfile(tenantIdOrPath: string): Promise<TenantProfile> {
  const profilePath = tenantIdOrPath.endsWith(".yaml") || tenantIdOrPath.endsWith(".yml")
    ? tenantIdOrPath
    : join("tenants", `${tenantIdOrPath}.yaml`);
  const raw = await readFile(profilePath, "utf8");
  return tenantProfileSchema.parse(parse(raw));
}

export function capabilityPathForTenant(profile: TenantProfile | undefined, capabilityId: string): string | undefined {
  return profile?.capabilities[capabilityId]?.path;
}
