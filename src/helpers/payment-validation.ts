/**
 * Validated payment fields from X-Cashu-Channel header or close request body
 */
export interface ValidatedPaymentFields {
  channelId: string;
  balance: number;
  signature: string;
}

/**
 * Result of payment field validation
 */
export type PaymentFieldsValidationResult =
  | { valid: true; fields: ValidatedPaymentFields }
  | { valid: false; error: string };

/**
 * Validates the basic payment fields from a parsed JSON object.
 *
 * Checks:
 * - channel_id: must be a non-empty string
 * - balance: must be a non-negative integer
 * - signature: must be a non-empty string
 *
 * @param obj - The parsed payment object (from X-Cashu-Channel header or request body)
 * @returns Validation result with either validated fields or an error message
 */
export function validatePaymentFields(obj: any): PaymentFieldsValidationResult {
  if (typeof obj.channel_id !== "string" || !obj.channel_id) {
    return { valid: false, error: "invalid or missing channel_id" };
  }

  if (
    typeof obj.balance !== "number" ||
    Number.isNaN(obj.balance) ||
    obj.balance < 0 ||
    !Number.isInteger(obj.balance)
  ) {
    return { valid: false, error: "invalid or missing balance" };
  }

  if (typeof obj.signature !== "string" || !obj.signature) {
    return { valid: false, error: "invalid or missing signature" };
  }

  return {
    valid: true,
    fields: {
      channelId: obj.channel_id,
      balance: obj.balance,
      signature: obj.signature,
    },
  };
}
