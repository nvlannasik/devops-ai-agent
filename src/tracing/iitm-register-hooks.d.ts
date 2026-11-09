// import-in-the-middle 3.5.3 ships its types for `register-hooks.mjs` as `register-hooks.d.ts`, which
// NodeNext never pairs with an `.mjs` file (it wants `.d.mts`; 3.6.0 renamed it). This restates the
// one call preload.ts makes. Delete it after upgrading to import-in-the-middle >= 3.6.0.
declare module "import-in-the-middle/register-hooks.mjs" {
  export function register(options?: {
    include?: Array<string | RegExp>;
    exclude?: Array<string | RegExp>;
    disableCjsSourceStripping?: boolean;
  }): void;
  export function supportsSyncHooks(): boolean;
}
