export const HANDLE_INPUT_PATTERN = "[a-z0-9][a-z0-9_\\-]*";

export const HANDLE_FORMAT_HELP =
  "Use lowercase letters, numbers, hyphens, or underscores. Start with a letter or number.";

export function handleFormatError(label = "Handle"): string {
  return `${label} can use lowercase letters, numbers, hyphens, or underscores, and must start with a letter or number.`;
}

export function handleValidityMessage(validity: ValidityState, label = "Handle"): string {
  if (validity.valueMissing) return `${label} is required.`;
  return handleFormatError(label);
}

export function friendlyHandleValidationError(message: string, label = "Handle"): string {
  return /expected kebab-case|lowercase kebab-case|URL-safe handle/i.test(message)
    ? handleFormatError(label)
    : message;
}
