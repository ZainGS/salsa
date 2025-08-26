type CharacterInfo = {
  // atlas-space (texels)
  atlasX: number;
  atlasY: number;
  texWidth: number;
  texHeight: number;

  // display-space (screen px)
  width: number;
  height: number;
  advance: number;
  bearingX: number;
  bearingY: number;
};