import { Line } from "../../scene-graph/shapes/line";
import { Scribble } from "../../scene-graph/shapes/scribble";
import { Highlight } from "../../scene-graph/shapes/highlight";
import { Pattern } from "../../scene-graph/shapes/pattern";

export interface StagingContainer {
    scribbles: Scribble[];
    highlights: Highlight[];
    lines: Line[];
    patterns: Pattern[];
  }