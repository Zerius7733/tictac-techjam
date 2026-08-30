import type { AuthStore } from "./auth-store.js";
import type {
  AuthContext,
  AuthorizationDecision,
  Authorizer,
} from "./orchestration-contracts.js";

type AuthResourceType =
  | "agent"
  | "run"
  | "orchestration"
  | "system"
  | "data_asset";

/**
 * Composition-root adapter for the shared authorization contract. Unknown
 * resource families still fail closed; the protected data-asset family is
 * handled by AuthStore after migration 008.
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
  return (
    value === "agent" ||
    value === "run" ||
    value === "orchestration" ||
    value === "system" ||
    value === "data_asset"
  );
}
