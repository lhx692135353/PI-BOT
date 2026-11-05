export function realPath(input: string): Promise<string>;
export function resolvePath(root: string, input?: string, approved?: string[]): Promise<string>;
export function command(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{ exit_code: number | null; timed_out: boolean; cancelled: boolean; output: string }>;
