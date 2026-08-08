import { studionet } from "genlayer-js/chains";
import { isAddress, zeroAddress, type Address } from "viem";

export const FOODGUARD_CHAIN = studionet;

export type FoodGuardPublicAppOriginConfiguration =
  | {
      status: "READY";
      origin: string;
      createOrderSourceUrl: string;
      writesEnabled: true;
    }
  | {
      status: "PUBLIC_APP_ORIGIN_REQUIRED";
      origin: null;
      createOrderSourceUrl: null;
      writesEnabled: false;
      reason:
        | "MISSING"
        | "INVALID_URL"
        | "HTTPS_REQUIRED"
        | "ORIGIN_ONLY_REQUIRED"
        | "PLACEHOLDER_HOST";
      message: string;
    };

export type FoodGuardConfiguration =
  | {
      status: "READY";
      chain: typeof studionet;
      address: Address;
      writesEnabled: true;
    }
  | {
      status: "DEPLOYMENT_REQUIRED";
      chain: typeof studionet;
      address: null;
      writesEnabled: false;
      message: string;
    };

export class FoodGuardDeploymentRequiredError extends Error {
  constructor(message = "FoodGuard deployment required: configure a verified StudioNet address") {
    super(message);
    this.name = "FoodGuardDeploymentRequiredError";
  }
}

function publicAppOriginRequired(
  reason: Extract<
    FoodGuardPublicAppOriginConfiguration,
    { status: "PUBLIC_APP_ORIGIN_REQUIRED" }
  >["reason"],
  detail: string,
): FoodGuardPublicAppOriginConfiguration {
  return {
    status: "PUBLIC_APP_ORIGIN_REQUIRED",
    origin: null,
    createOrderSourceUrl: null,
    writesEnabled: false,
    reason,
    message: `Public app origin required: ${detail}`,
  };
}

function isPlaceholderHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const reservedDomains = ["example.com", "example.net", "example.org"];
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".example") ||
    host.endsWith(".invalid") ||
    host.endsWith(".test") ||
    reservedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

export function getFoodGuardPublicAppOriginConfiguration(
  rawOrigin = process.env.NEXT_PUBLIC_FOODGUARD_APP_ORIGIN,
): FoodGuardPublicAppOriginConfiguration {
  const value = rawOrigin?.trim();
  if (!value) {
    return publicAppOriginRequired(
      "MISSING",
      "configure NEXT_PUBLIC_FOODGUARD_APP_ORIGIN before enabling payable orders",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return publicAppOriginRequired("INVALID_URL", "configure a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    return publicAppOriginRequired("HTTPS_REQUIRED", "configure an HTTPS URL");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return publicAppOriginRequired(
      "ORIGIN_ONLY_REQUIRED",
      "configure only the canonical origin without credentials, path, query, or fragment",
    );
  }
  if (isPlaceholderHostname(url.hostname)) {
    return publicAppOriginRequired(
      "PLACEHOLDER_HOST",
      "configure a real public host instead of a placeholder or local host",
    );
  }

  return {
    status: "READY",
    origin: url.origin,
    createOrderSourceUrl: `${url.origin}/create`,
    writesEnabled: true,
  };
}

export function getFoodGuardConfiguration(
  rawAddress = process.env.NEXT_PUBLIC_FOODGUARD_ADDRESS,
): FoodGuardConfiguration {
  const address = rawAddress?.trim();
  if (
    !address ||
    !isAddress(address, { strict: false }) ||
    address.toLowerCase() === zeroAddress
  ) {
    return {
      status: "DEPLOYMENT_REQUIRED",
      chain: FOODGUARD_CHAIN,
      address: null,
      writesEnabled: false,
      message:
        "FoodGuard has not been deployed on StudioNet. Configure a verified contract address to enable contract access.",
    };
  }

  return {
    status: "READY",
    chain: FOODGUARD_CHAIN,
    address,
    writesEnabled: true,
  };
}

export function requireFoodGuardConfiguration(): Extract<
  FoodGuardConfiguration,
  { status: "READY" }
> {
  const configuration = getFoodGuardConfiguration();
  if (configuration.status !== "READY") {
    throw new FoodGuardDeploymentRequiredError(configuration.message);
  }
  return configuration;
}
