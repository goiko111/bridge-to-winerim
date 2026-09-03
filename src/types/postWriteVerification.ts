/**
 * Shared post-write verification contract for all POS providers.
 *
 * Each provider that supports writes can implement its own verification logic
 * but must return this common shape so the UI and outbound-task pipeline
 * can handle results uniformly.
 */

export interface PostWriteVerificationResult {
  /** Did the overall verification pass? */
  success: boolean;
  /** Product/entity exists in the POS after write */
  verified_exists: boolean;
  /** All expected prices are > 0 and correctly assigned */
  verified_prices: boolean;
  /** Write scope / permissions are still valid */
  verified_scope: boolean;
  /** Hard failures that should mark the task as FAILED */
  errors: PostWriteIssue[];
  /** Non-blocking issues (e.g. missing optional fields) */
  warnings: PostWriteIssue[];
}

export interface PostWriteIssue {
  code: string;       // e.g. "PRICE_ZERO", "NOT_FOUND", "SCOPE_EXPIRED"
  message: string;    // Human-readable description
  field?: string;     // Optional field reference (e.g. "bottle_sale_price")
  context?: Record<string, unknown>; // Provider-specific metadata
}

/** Helper to build a passing result */
export function passingVerification(warnings?: PostWriteIssue[]): PostWriteVerificationResult {
  return {
    success: true,
    verified_exists: true,
    verified_prices: true,
    verified_scope: true,
    errors: [],
    warnings: warnings ?? [],
  };
}

/** Helper to build a failed result */
export function failedVerification(
  errors: PostWriteIssue[],
  partial?: Partial<Pick<PostWriteVerificationResult, "verified_exists" | "verified_prices" | "verified_scope" | "warnings">>,
): PostWriteVerificationResult {
  return {
    success: false,
    verified_exists: partial?.verified_exists ?? false,
    verified_prices: partial?.verified_prices ?? false,
    verified_scope: partial?.verified_scope ?? true,
    errors,
    warnings: partial?.warnings ?? [],
  };
}

/**
 * Provider-specific verifier interface.
 * Each provider module can export a function matching this signature.
 */
export type PostWriteVerifier = (params: {
  connectionId: string;
  externalId: string;
  provider: string;
  taskType: string;
  payload: Record<string, unknown>;
}) => Promise<PostWriteVerificationResult>;
