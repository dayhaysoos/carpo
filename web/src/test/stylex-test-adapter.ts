type StyleDefinition = Record<string, Record<string, unknown>>;

export function defineVars<Tokens extends Record<string, string>>(
  tokens: Tokens,
): Tokens {
  return tokens;
}

export function create<Styles extends StyleDefinition>(styles: Styles): Styles {
  return styles;
}

export function props(...styles: unknown[]): { className?: string } {
  const className = styles
    .filter(Boolean)
    .map((_, index) => `stylex-test-${index}`)
    .join(" ");

  return className ? { className } : {};
}
