import { describe, it, expect } from "vitest";
import { getHotspotColor } from "./SpatialHotspotMapOverlay.js";

describe("SpatialHotspotMapOverlay & GeoJSON Helpers", () => {
  it("determines hotspot color based on fee multiplier", () => {
    expect(getHotspotColor(1.0)).toBe("green");
    expect(getHotspotColor(1.15)).toBe("green");
    expect(getHotspotColor(1.2)).toBe("green");
    expect(getHotspotColor(1.35)).toBe("orange");
    expect(getHotspotColor(1.6)).toBe("orange");
    expect(getHotspotColor(1.75)).toBe("red");
    expect(getHotspotColor(2.0)).toBe("red");
  });
});
