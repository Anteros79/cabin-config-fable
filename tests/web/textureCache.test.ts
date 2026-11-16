import * as THREE from "three";
import { afterEach, describe, expect, test } from "vitest";
import { disposeTextureCache, getTexture, type TextureSize, textureKey } from "../../src/web/scene/textures.ts";

const square = (side: number): TextureSize => ({ width: side, height: side });

afterEach(() => {
  disposeTextureCache();
});

describe("texture cache", () => {
  test("a key names the kind, the palette and the size", () => {
    expect(textureKey("carpet", "concept-gray", square(1024))).not.toBe(textureKey("carpet", "photo-navy-band", square(1024)));
    expect(textureKey("carpet", "concept-gray", square(1024))).not.toBe(textureKey("carpet", "concept-gray", square(512)));
    expect(textureKey("carpet", "concept-gray", square(1024))).not.toBe(textureKey("backFront", "concept-gray", square(1024)));
    expect(textureKey("carpet", "concept-gray", square(1024))).toBe(textureKey("carpet", "concept-gray", square(1024)));
  });

  test("the same key returns the same texture and makes it once", () => {
    let made = 0;
    const make = () => {
      made += 1;
      return new THREE.Texture();
    };
    const key = textureKey("carpet", "concept-gray", square(1024));
    const first = getTexture(key, make);
    expect(getTexture(key, make)).toBe(first);
    expect(made).toBe(1);
    const other = getTexture(textureKey("carpet", "photo-navy-band", square(1024)), make);
    expect(other).not.toBe(first);
    expect(made).toBe(2);
  });

  test("switching A, B, A makes each texture once", () => {
    const made: string[] = [];
    const get = (palette: string) =>
      getTexture(textureKey("backFront", palette, square(256)), () => {
        made.push(palette);
        return new THREE.Texture();
      });
    const a = get("A");
    get("B");
    expect(get("A")).toBe(a);
    expect(made).toEqual(["A", "B"]);
  });

  test("disposeTextureCache disposes each texture once and empties the cache", () => {
    const disposed: string[] = [];
    const tracked = (name: string) => {
      const t = new THREE.Texture();
      t.addEventListener("dispose", () => disposed.push(name));
      return t;
    };
    const a = getTexture("a", () => tracked("a"));
    getTexture("b", () => tracked("b"));
    disposeTextureCache();
    expect(disposed.sort()).toEqual(["a", "b"]);
    disposeTextureCache();
    expect(disposed).toHaveLength(2);
    // emptied: the next request makes a new texture
    const again = getTexture("a", () => tracked("a2"));
    expect(again).not.toBe(a);
  });
});
