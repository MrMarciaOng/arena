import type { Appearance } from "./domain";
import { hashString } from "./format";

export type Palette = { skin: string; hair: string; shirt: string; pants: string };

const SKIN = ["#f6d5b8", "#e9b98f", "#c98c5f", "#9a6240", "#6b4229"];
const HAIR = ["#2b1d14", "#5a3a1e", "#a0522d", "#d9a441", "#ece4d0", "#3d3b63", "#b83b5e", "#2f7f83"];
const SHIRT = ["#4f7cff", "#ff7a59", "#3fbf7f", "#b06bff", "#ffb400", "#ff5c8a", "#2ec4b6", "#e2dcff"];
const PANTS = ["#2d2a45", "#34466b", "#4b3b2a", "#1f3d3a", "#4a2f4f"];

/** Colors for an agent's sprite: picked from a hash of its key (or appearance.seed), overridable per part. */
export function paletteFor(key: string, appearance: Appearance | null): Palette {
  const h = hashString(appearance?.seed ?? key);
  const pick = (list: string[], shift: number) => list[(h >>> shift) % list.length];
  return {
    skin: appearance?.palette?.skin ?? pick(SKIN, 0),
    hair: appearance?.palette?.hair ?? pick(HAIR, 5),
    shirt: appearance?.palette?.shirt ?? pick(SHIRT, 11),
    pants: appearance?.palette?.pants ?? pick(PANTS, 17),
  };
}
