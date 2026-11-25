const MAX_ISSUE_NUMBERS = 100;

/** The single refusal for an invalid explicit issue-number selector. */
export const ISSUE_NUMBER_ERROR =
  "issueNumbers must be positive integers, at most 100, without duplicates";

/**
 * A bounded, sorted list of distinct positive issue numbers, or undefined when raw is not one.
 */
export function orderedIssueNumbers(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ISSUE_NUMBERS)
    return undefined;
  if (
    !raw.every(
      (number) =>
        typeof number === "number" && Number.isInteger(number) && number > 0,
    )
  )
    return undefined;

  const numbers = [...(raw as number[])].sort((a, b) => a - b);
  return numbers.some(
    (number, index) => index > 0 && number === numbers[index - 1],
  )
    ? undefined
    : numbers;
}
