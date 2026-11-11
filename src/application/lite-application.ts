import type {
  LiteApplicationFacade,
  LiteApplicationOptions,
} from "../contracts/facade.js";
import { createLiteFacadeApplication } from "../facade/lite-application-facade.js";
import { validateLiteApplicationOptions } from "./options.js";

/**
 * Creates the public facade.
 *
 * The facade is in-process and persists wherever the kernel runtime does; the
 * scaffold-era fail-closed operations are replaced by the compatible queue and
 * event envelope.
 */
export async function createLiteApplication(
  options: LiteApplicationOptions,
): Promise<LiteApplicationFacade> {
  validateLiteApplicationOptions(options);
  return createLiteFacadeApplication(options);
}
