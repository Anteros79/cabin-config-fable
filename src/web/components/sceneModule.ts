import type * as SceneModule from "../scene/CabinScene.ts";

let loading: Promise<typeof SceneModule> | null = null;

/**
 * The scene chunk (CabinScene and three.js), loaded once and shared. A visit route asks for it as soon as it opens, so the
 * chunk downloads while the visit is fetched instead of after it (Task 6.5); Cabin3D then finds it loaded or loading.
 * Vite's preload helper wraps the import and adds a `<link rel="modulepreload">` for each chunk it depends on. A failed load
 * is forgotten, so the next call tries again.
 */
export function loadSceneModule(): Promise<typeof SceneModule> {
  loading ??= import("../scene/CabinScene.ts").catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
