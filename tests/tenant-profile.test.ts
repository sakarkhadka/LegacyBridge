import { describe, expect, it } from "vitest";
import { loadCapabilityArtifactFromPath } from "../src/artifact/loader.js";
import { capabilityPathForTenant, loadTenantProfile } from "../src/tenant/profile.js";

describe("tenant profiles", () => {
  it("loads Heritage origin, auth defaults, and capability mappings", async () => {
    const profile = await loadTenantProfile("heritage-demo");

    expect(profile).toMatchObject({
      tenantId: "heritage-demo",
      displayName: "Heritage Core Servicing Demo",
      application: {
        appFamily: "legacy-core-servicing",
        defaultOrigin: "http://127.0.0.1:3000"
      },
      auth: {
        provider: "demo-form",
        defaultRuntimeUser: "readwrite",
        defaultRuntimePassword: "rw123"
      },
      demoDefaults: {
        memberId: "54321"
      }
    });
    expect(capabilityPathForTenant(profile, "member.get-account-balances")).toBe("capabilities/member-get-account-balances.v1.yaml");
    expect(capabilityPathForTenant(profile, "member.deposit-to-account")).toBe("capabilities/member-deposit-to-account.v1.yaml");
    expect(capabilityPathForTenant(profile, "member.withdraw-from-account")).toBe("capabilities/member-withdraw-from-account.v1.yaml");
    expect(capabilityPathForTenant(profile, "member.get-transaction-history")).toBe("capabilities/member-get-transaction-history.v1.yaml");
  });

  it("loads Riverside as a second tenant with a different app shape", async () => {
    const profile = await loadTenantProfile("riverside-demo");

    expect(profile).toMatchObject({
      tenantId: "riverside-demo",
      displayName: "Riverside Member Console Demo",
      application: {
        appFamily: "riverside-member-console",
        defaultOrigin: "http://127.0.0.1:3010"
      },
      auth: {
        provider: "demo-form",
        loginPath: "/signin",
        usernameLabel: "Operator ID",
        passwordLabel: "Passcode",
        submitLabel: "Enter Console",
        defaultRuntimeUser: "analyst",
        defaultRuntimePassword: "a123"
      },
      demoDefaults: {
        memberId: "24680"
      }
    });
    expect(Object.keys(profile.capabilities)).toEqual(["member.get-account-balances"]);
    expect(capabilityPathForTenant(profile, "member.get-account-balances")).toBe("capabilities/riverside-member-get-account-balances.v1.yaml");
  });

  it("points to schema-valid capability artifacts", async () => {
    for (const tenantId of ["heritage-demo", "riverside-demo"]) {
      const profile = await loadTenantProfile(tenantId);

      for (const [capabilityId, mapping] of Object.entries(profile.capabilities)) {
        const artifact = await loadCapabilityArtifactFromPath(mapping.path);

        expect(artifact.capability.id).toBe(capabilityId);
      }
    }
  });
});
