/**
 * `odc` is the client-only entry to a remote OpenDesign daemon. It shares the
 * `od` implementation but never inherits daemon-start behavior or guesses a
 * local daemon.
 */

export type OdcPlan =
  | { ok: true; argv: string[]; env: NodeJS.ProcessEnv }
  | { ok: false; message: string };

function hasDaemonUrlFlag(argv: string[]): boolean {
  return argv.some((arg, index) =>
    (arg === '--daemon-url' && Boolean(argv[index + 1]?.trim()))
    || (arg.startsWith('--daemon-url=') && arg.length > '--daemon-url='.length));
}

function isHelpFlag(arg: string): boolean {
  return arg === '-h' || arg === '--help';
}

export function planOdcInvocation(argv: string[], env: NodeJS.ProcessEnv = process.env): OdcPlan {
  // Bare `odc` is help, not a daemon start.
  if (argv.length === 0) return { ok: true, argv: ['--help'], env };

  const first = argv[0] ?? '';
  if (first.startsWith('-') && !isHelpFlag(first)) {
    return {
      ok: false,
      message: `odc is client-only and does not start a daemon (unsupported option: ${first}). Run "odc --help".`,
    };
  }

  const wantsHelp = first === 'help' || argv.some(isHelpFlag);
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const configured = env.ODC_DAEMON_URL?.trim();
  if (configured) nextEnv.OD_DAEMON_URL = configured;

  if (!wantsHelp && !hasDaemonUrlFlag(argv) && !nextEnv.OD_DAEMON_URL?.trim()) {
    return {
      ok: false,
      message: 'odc needs an explicit daemon: set ODC_DAEMON_URL (or OD_DAEMON_URL) or pass --daemon-url <https-url>.',
    };
  }
  return { ok: true, argv, env: nextEnv };
}
