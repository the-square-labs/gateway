interface ComposeRevisionResumeInput {
  projectName: string;
  yaml: string;
  variables: Record<string, string>;
  secretKeys: string[];
}

export function composeRevisionResumeSignature(input: ComposeRevisionResumeInput): string {
  return JSON.stringify({
    projectName: input.projectName,
    yaml: input.yaml,
    variables: Object.fromEntries(
      Object.entries(input.variables).sort(([a], [b]) => a.localeCompare(b))
    ),
    secretKeys: [...input.secretKeys].sort(),
  });
}
