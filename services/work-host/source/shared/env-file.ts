/** Whether a name fits the ASCII identifier grammar used for environment variables. */
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function canStartEnvironmentName(code: number): boolean {
  return code === 95 || isAsciiLetter(code);
}

function canContinueEnvironmentName(code: number): boolean {
  return canStartEnvironmentName(code) || (code >= 48 && code <= 57);
}

export function isEnvironmentName(value: string): boolean {
  if (value.length === 0 || !canStartEnvironmentName(value.charCodeAt(0))) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (!canContinueEnvironmentName(value.charCodeAt(index))) return false;
  }
  return true;
}
