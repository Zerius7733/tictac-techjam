import type { AuthStore } from "./auth-store.js";
import type {
  AuthContext,
  AuthorizationDecision,
  Authorizer,
} from "./orchestration-contracts.js";

type AuthResourceType = "agent" | "run" | "orchestration" | "system";

/**
 * Composition-root adapter while the authorization contributor finalizes the
 * wider resource vocabulary. Unsupported resource types fail closed; the
 * partner-owned AuthStore can later replace this adapter without changing the
 * dispatcher or HTTP layer.
 */
export class AuthStoreAuthorizer implements Authorizer {
  constructor(private readonly authStore: AuthStore) {}

  async authorize(
    context: AuthContext,
    action: string,
    resourceType: string,
    resourceKey: string,
  ): Promise<AuthorizationDecision> {
    if (!isAuthResourceType(resourceType)) {
      return {
        allowed: false,
        reasonCode: "resource_type_not_configured",
        auditLogId: "",
      };
    }
    return this.authStore.authorize(
      context as Parameters<AuthStore["authorize"]>[0],
      action,
      resourceType,
      resourceKey,
    );
  }
}

function isAuthResourceType(value: string): value is AuthResourceType {
  return value === "agent" || value === "run" || value === "orchestration" || value === "system";
}
