/**
 * safe-spawn — single chokepoint for child_process.
 *
 * Codex adversarial review (2026-05-04, rounds 1-5) found 11 spawn/exec
 * sites that leaked process.env into subprocesses. The fixes converged
 * on three env shapes:
 *
 *   - `sdk`         scrubbed env via getScrubbedSdkEnv, caller may
 *                   pass auth secrets via `extraEnv` (forwarded as the
 *                   authSecrets re-injection slot). For LLM-facing
 *                   subprocesses where agent-controlled input could
 *                   attempt exfil.
 *
 *   - `shell-task`  buildShellTaskEnv() — minimal locale/path env, no
 *                   inherited secrets. For scheduled silent shell tasks
 *                   where the command string is argv-controlled.
 *
 *   - `system-tool` { PATH } only, plus filtered extras. For OS tools
 *                   (ffmpeg, pgrep, python import probes) with
 *                   non-agent-controlled args.
 *
 * This module is the ONLY allowed importer of node:child_process across
 * the codebase. The lint guard at scripts/check-no-raw-spawn.mjs flags
 * any other importer; new sites must be migrated through one of the
 * three wrappers (or carry an explicit eslint-disable-style justification
 * comment recognised by the guard).
 *
 * Codex round-4 hard rule: every fix must address the root cause AND
 * sweep every instance of the class. This wrapper is the central helper
 * that #4 of the operating principles demands; the lint guard is the
 * "did you converge every caller" enforcement layer.
 */

import {
  spawn as rawSpawn,
  spawnSync as rawSpawnSync,
  exec as rawExec,
  execFile as rawExecFile,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  type ExecOptions,
  type ExecFileOptions,
} from 'node:child_process';
import { getScrubbedSdkEnv, isLikelySecretEnvName } from './security.js';
import { buildShellTaskEnv } from './shell-task.js';

export type EnvClass = 'sdk' | 'shell-task' | 'system-tool';

interface BaseSafeOpts {
  /** Required: which env shape this subprocess gets. No default. */
  envClass: EnvClass;
  /**
   * Extra env vars to merge in.
   *   - sdk: forwarded as the `authSecrets` re-injection slot.
   *   - shell-task / system-tool: merged after the base env. Any key
   *     that looks secret-shaped (per isLikelySecretEnvName) throws
   *     unless explicitly listed in `allowSecretNames`.
   */
  extraEnv?: Record<string, string | undefined>;
  /**
   * Allow specific secret-shaped key names through extraEnv for
   * shell-task / system-tool. Use sparingly with a justification.
   * Ignored for envClass: 'sdk'.
   */
  allowSecretNames?: readonly string[];
}

export type SafeSpawnOptions = BaseSafeOpts & Omit<SpawnOptions, 'env'>;
export type SafeSpawnSyncOptions = BaseSafeOpts & Omit<SpawnSyncOptions, 'env'>;
export type SafeExecOptions = BaseSafeOpts & Omit<ExecOptions, 'env'>;
export type SafeExecFileOptions = BaseSafeOpts & Omit<ExecFileOptions, 'env'>;

/**
 * Build the env dict for the requested class. Pure function, exported
 * so tests can assert env shape without spawning a real subprocess.
 */
export function buildEnv(
  envClass: EnvClass,
  extraEnv: Record<string, string | undefined> = {},
  allowSecretNames: readonly string[] = [],
): Record<string, string | undefined> {
  if (envClass === 'sdk') {
    // For SDK, extraEnv IS the auth slot — getScrubbedSdkEnv re-injects
    // it after the secret sweep. No filter applied.
    return getScrubbedSdkEnv(extraEnv);
  }

  // shell-task / system-tool: scan extras for secret-shaped keys.
  for (const key of Object.keys(extraEnv)) {
    if (isLikelySecretEnvName(key) && !allowSecretNames.includes(key)) {
      throw new Error(
        `safe-spawn: extraEnv key "${key}" looks secret-shaped for envClass="${envClass}". ` +
          `Pass it through allowSecretNames with a justification, or pick envClass="sdk".`,
      );
    }
  }

  const base: Record<string, string | undefined> =
    envClass === 'shell-task'
      ? { ...buildShellTaskEnv() }
      : { PATH: process.env.PATH };

  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof v === 'string' && v.length > 0) base[k] = v;
  }
  return base;
}

function splitOpts<T extends BaseSafeOpts>(
  opts: T,
): { envClass: EnvClass; extraEnv?: Record<string, string | undefined>; allowSecretNames?: readonly string[]; rest: Omit<T, keyof BaseSafeOpts> } {
  const { envClass, extraEnv, allowSecretNames, ...rest } = opts;
  return { envClass, extraEnv, allowSecretNames, rest: rest as Omit<T, keyof BaseSafeOpts> };
}

export function safeSpawn(
  cmd: string,
  args: readonly string[],
  opts: SafeSpawnOptions,
): ChildProcess {
  const { envClass, extraEnv, allowSecretNames, rest } = splitOpts(opts);
  const env = buildEnv(envClass, extraEnv, allowSecretNames);
  return rawSpawn(cmd, args as string[], { ...(rest as SpawnOptions), env });
}

export function safeSpawnSync(
  cmd: string,
  args: readonly string[],
  opts: SafeSpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
  const { envClass, extraEnv, allowSecretNames, rest } = splitOpts(opts);
  const env = buildEnv(envClass, extraEnv, allowSecretNames);
  return rawSpawnSync(cmd, args as string[], { ...(rest as SpawnSyncOptions), env });
}

export function safeExec(
  cmd: string,
  opts: SafeExecOptions,
): ChildProcess {
  const { envClass, extraEnv, allowSecretNames, rest } = splitOpts(opts);
  const env = buildEnv(envClass, extraEnv, allowSecretNames);
  return rawExec(cmd, { ...(rest as ExecOptions), env });
}

export function safeExecFile(
  cmd: string,
  args: readonly string[],
  opts: SafeExecFileOptions,
): ChildProcess {
  const { envClass, extraEnv, allowSecretNames, rest } = splitOpts(opts);
  const env = buildEnv(envClass, extraEnv, allowSecretNames);
  // Node's execFile(file, args, options) without callback returns
  // ChildProcess; the TS overloads don't expose this exact shape, so
  // call through a typed alias.
  const execFileNoCb = rawExecFile as unknown as (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
  ) => ChildProcess;
  return execFileNoCb(cmd, args, { ...(rest as ExecFileOptions), env });
}

/**
 * Promise-based execFile wrapper, equivalent to
 * `promisify(execFile)(cmd, args, opts)` with a forced env shape.
 */
export function safeExecFileAsync(
  cmd: string,
  args: readonly string[],
  opts: SafeExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { envClass, extraEnv, allowSecretNames, rest } = splitOpts(opts);
  const env = buildEnv(envClass, extraEnv, allowSecretNames);
  const fullOpts: ExecFileOptions = { ...(rest as ExecFileOptions), env };
  return new Promise((resolve, reject) => {
    rawExecFile(cmd, args as string[], fullOpts, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
      });
    });
  });
}
