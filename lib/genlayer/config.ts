import { studionet } from "genlayer-js/chains";
import { isAddress, zeroAddress, type Address } from "viem";

export const FOODGUARD_CHAIN = studionet;

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
