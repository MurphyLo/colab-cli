export interface RuntimeVersionInfo {
  label: string;
  ubuntu: string;
  python: string;
  numpy: string;
  pytorch: string;
  jax: string;
  tensorflow: string;
  r: string;
  julia: string;
}

/**
 * Hardcoded environment info for each runtime version.
 * Source: https://github.com/googlecolab/backend-info
 */
export const RUNTIME_VERSION_INFO: ReadonlyMap<string, RuntimeVersionInfo> =
  new Map([
    [
      '2026.01',
      {
        label: '2026.01',
        ubuntu: '22.04.5 LTS',
        python: '3.12.12',
        numpy: '2.0.2',
        pytorch: '2.9.0',
        jax: '0.7.2',
        tensorflow: '2.19.0 (not included in TPU runtimes)',
        r: '4.5.2 (2025-10-31) -- "[Not] Part in a Rumble"',
        julia: '1.11.5',
      },
    ],
    [
      '2025.10',
      {
        label: '2025.10',
        ubuntu: '22.04.4 LTS',
        python: '3.12.12',
        numpy: '2.0.2',
        pytorch: '2.8.0',
        jax: '0.5.3',
        tensorflow: '2.19.0 (not included in TPU runtimes)',
        r: '4.5.1 (2025-06-13) -- "Great Square Root"',
        julia: '1.11.5',
      },
    ],
    [
      '2025.07',
      {
        label: '2025.07',
        ubuntu: '22.04.04 LTS',
        python: '3.11.13',
        numpy: '2.0.2',
        pytorch: '2.6.0',
        jax: '0.5.2',
        tensorflow: '2.18.0 (not included in TPU runtimes)',
        r: '4.5.1 (2025-06-13) -- "Great Square Root"',
        julia: '1.10.9',
      },
    ],
  ]);
