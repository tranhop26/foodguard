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

export type FoodGuardDeploymentProofInput = {
  address?: string;
  deploymentAddress?: string;
  deploymentChainId?: string;
  sourceHash?: string;
  transactionHash?: string;
  finality?: string;
  execution?: string;
  readback?: string;
  sourceHashMatch?: string;
};

type FoodGuardDeploymentProofRecord = {
  chain: typeof studionet;
  chainId: number;
  address: Address;
  sourceHash: `0x${string}`;
  transactionHash: `0x${string}`;
  finality: "FINALIZED";
  execution: "EXECUTION_SUCCESS";
  readback: "READBACK_CONFIRMED";
  sourceHashMatch: true;
};

export type FoodGuardReviewedDeploymentProof = FoodGuardDeploymentProofRecord & {
  // Public environment values are review metadata, not live chain proof. A
  // browser-side RPC verification is required before rendering VERIFIED.
  status: "REVIEWED";
  runtimeVerification:
    | { status: "NOT_CHECKED" }
    | { status: "FAILED"; reason: string; message: string };
};

export type FoodGuardVerifiedDeploymentProof = FoodGuardDeploymentProofRecord & {
  status: "VERIFIED";
  runtimeVerification: { status: "VERIFIED" };
};

export type FoodGuardDeploymentProofConfiguration =
  | FoodGuardReviewedDeploymentProof
  | {
      status: "UNAVAILABLE";
      chain: typeof studionet;
      address: Address | null;
      reason:
        | "DEPLOYMENT_REQUIRED"
        | "DEPLOYMENT_CHAIN_MISSING"
        | "DEPLOYMENT_CHAIN_MISMATCH"
        | "DEPLOYMENT_ADDRESS_MISSING"
        | "DEPLOYMENT_ADDRESS_INVALID"
        | "DEPLOYMENT_ADDRESS_MISMATCH"
        | "SOURCE_HASH_MISSING"
        | "SOURCE_HASH_INVALID"
        | "TRANSACTION_HASH_MISSING"
        | "TRANSACTION_HASH_INVALID"
        | "SOURCE_HASH_UNVERIFIED"
        | "LIFECYCLE_UNVERIFIED";
      message: string;
    };

export type FoodGuardDeploymentProof =
  | {
      status: "UNAVAILABLE";
      chain: typeof studionet;
      address: Address | null;
      reason: Extract<FoodGuardDeploymentProofConfiguration, { status: "UNAVAILABLE" }>["reason"];
      message: string;
    }
  | FoodGuardReviewedDeploymentProof
  | FoodGuardVerifiedDeploymentProof;

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

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;

function normalizeHash(raw: string | undefined): `0x${string}` | null {
  const value = raw?.trim();
  if (!value || !HASH_PATTERN.test(value) || value.toLowerCase() === ZERO_HASH) return null;
  return value.toLowerCase() as `0x${string}`;
}

function isNonzeroAddress(value: unknown): value is Address {
  return (
    typeof value === "string" &&
    isAddress(value, { strict: false }) &&
    value.toLowerCase() !== zeroAddress
  );
}

function isCanonicalHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && normalizeHash(value) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deploymentProofUnavailable(
  configuration: FoodGuardConfiguration,
  reason: Extract<FoodGuardDeploymentProofConfiguration, { status: "UNAVAILABLE" }>["reason"],
  message: string,
): Extract<FoodGuardDeploymentProofConfiguration, { status: "UNAVAILABLE" }> {
  return {
    status: "UNAVAILABLE",
    chain: FOODGUARD_CHAIN,
    address: configuration.address,
    reason,
    message,
  };
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
    !isNonzeroAddress(address)
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

export function getFoodGuardDeploymentProofConfiguration(
  raw: FoodGuardDeploymentProofInput = {
    address: process.env.NEXT_PUBLIC_FOODGUARD_ADDRESS,
    deploymentAddress: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_ADDRESS,
    deploymentChainId: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_CHAIN_ID,
    sourceHash: process.env.NEXT_PUBLIC_FOODGUARD_SOURCE_SHA256,
    transactionHash: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_TRANSACTION_HASH,
    finality: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_FINALITY,
    execution: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_EXECUTION,
    readback: process.env.NEXT_PUBLIC_FOODGUARD_DEPLOYMENT_READBACK,
    sourceHashMatch: process.env.NEXT_PUBLIC_FOODGUARD_SOURCE_HASH_MATCH,
  },
): FoodGuardDeploymentProofConfiguration {
  const configuration = getFoodGuardConfiguration(raw.address);
  if (configuration.status !== "READY") {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_REQUIRED",
      "Deployment provenance is unavailable until a verified StudioNet contract address is configured.",
    );
  }

  const deploymentChainId = raw.deploymentChainId?.trim();
  if (!deploymentChainId) {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_CHAIN_MISSING",
      "Deployment provenance is unavailable because the reviewed deployment record has no chain ID.",
    );
  }
  if (deploymentChainId !== String(FOODGUARD_CHAIN.id)) {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_CHAIN_MISMATCH",
      "Deployment provenance is unavailable because the deployment record is not bound to GenLayer StudioNet.",
    );
  }

  const deploymentAddress = raw.deploymentAddress?.trim();
  if (!deploymentAddress) {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_ADDRESS_MISSING",
      "Deployment provenance is unavailable because the reviewed deployment record has no contract address.",
    );
  }
  if (!isNonzeroAddress(deploymentAddress)) {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_ADDRESS_INVALID",
      "Deployment provenance is unavailable because the deployment record contract address is invalid.",
    );
  }
  if (deploymentAddress.toLowerCase() !== configuration.address.toLowerCase()) {
    return deploymentProofUnavailable(
      configuration,
      "DEPLOYMENT_ADDRESS_MISMATCH",
      "Deployment provenance is unavailable because the deployment record does not match the configured contract address.",
    );
  }

  const sourceRaw = raw.sourceHash?.trim();
  if (!sourceRaw) {
    return deploymentProofUnavailable(
      configuration,
      "SOURCE_HASH_MISSING",
      "Deployment provenance is unavailable because no verified contract source hash is configured.",
    );
  }
  const sourceHash = normalizeHash(sourceRaw);
  if (!sourceHash) {
    return deploymentProofUnavailable(
      configuration,
      "SOURCE_HASH_INVALID",
      "Deployment provenance is unavailable because the contract source hash is not a nonzero SHA-256 digest.",
    );
  }

  const transactionRaw = raw.transactionHash?.trim();
  if (!transactionRaw) {
    return deploymentProofUnavailable(
      configuration,
      "TRANSACTION_HASH_MISSING",
      "Deployment provenance is unavailable because no deployment transaction hash is configured.",
    );
  }
  const transactionHash = normalizeHash(transactionRaw);
  if (!transactionHash) {
    return deploymentProofUnavailable(
      configuration,
      "TRANSACTION_HASH_INVALID",
      "Deployment provenance is unavailable because the deployment transaction hash is malformed.",
    );
  }

  if (raw.sourceHashMatch?.trim() !== "true") {
    return deploymentProofUnavailable(
      configuration,
      "SOURCE_HASH_UNVERIFIED",
      "Deployment provenance is unavailable because source-hash matching has not been independently verified.",
    );
  }
  if (
    raw.finality?.trim() !== "FINALIZED" ||
    raw.execution?.trim() !== "EXECUTION_SUCCESS" ||
    raw.readback?.trim() !== "READBACK_CONFIRMED"
  ) {
    return deploymentProofUnavailable(
      configuration,
      "LIFECYCLE_UNVERIFIED",
      "Deployment provenance is unavailable until finality, execution success, and authoritative readback are independently verified.",
    );
  }

  return {
    status: "REVIEWED",
    chain: FOODGUARD_CHAIN,
    chainId: FOODGUARD_CHAIN.id,
    address: configuration.address,
    sourceHash,
    transactionHash,
    finality: "FINALIZED",
    execution: "EXECUTION_SUCCESS",
    readback: "READBACK_CONFIRMED",
    sourceHashMatch: true,
    runtimeVerification: { status: "NOT_CHECKED" },
  };
}

export function isFoodGuardReviewedDeploymentProofForContract(
  proof: unknown,
  contractAddress: string,
): proof is FoodGuardReviewedDeploymentProof {
  if (!isRecord(proof) || proof.status !== "REVIEWED") return false;
  if (!isNonzeroAddress(contractAddress) || !isNonzeroAddress(proof.address)) return false;
  if (proof.address.toLowerCase() !== contractAddress.toLowerCase()) return false;
  if (proof.chainId !== FOODGUARD_CHAIN.id || !isRecord(proof.chain) || proof.chain.id !== FOODGUARD_CHAIN.id) return false;
  return (
    isCanonicalHash(proof.sourceHash) &&
    isCanonicalHash(proof.transactionHash) &&
    proof.finality === "FINALIZED" &&
    proof.execution === "EXECUTION_SUCCESS" &&
    proof.readback === "READBACK_CONFIRMED" &&
    proof.sourceHashMatch === true
  );
}

export function isFoodGuardVerifiedDeploymentProofForContract(
  proof: unknown,
  contractAddress: string,
): proof is FoodGuardVerifiedDeploymentProof {
  if (!isRecord(proof) || proof.status !== "VERIFIED") return false;
  if (!isNonzeroAddress(contractAddress) || !isNonzeroAddress(proof.address)) return false;
  if (proof.address.toLowerCase() !== contractAddress.toLowerCase()) return false;
  if (proof.chainId !== FOODGUARD_CHAIN.id || !isRecord(proof.chain) || proof.chain.id !== FOODGUARD_CHAIN.id) return false;
  if (!isRecord(proof.runtimeVerification) || proof.runtimeVerification.status !== "VERIFIED") return false;
  return (
    isCanonicalHash(proof.sourceHash) &&
    isCanonicalHash(proof.transactionHash) &&
    proof.finality === "FINALIZED" &&
    proof.execution === "EXECUTION_SUCCESS" &&
    proof.readback === "READBACK_CONFIRMED" &&
    proof.sourceHashMatch === true
  );
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
