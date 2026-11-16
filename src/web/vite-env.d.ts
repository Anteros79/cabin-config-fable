/// <reference types="vite/client" />

declare module "*.css";

interface ImportMetaEnv {
  /** "1" in the e2e build only: exposes window.__cabinKit and the scene test hooks. */
  readonly VITE_TEST_HOOKS?: string;
}
