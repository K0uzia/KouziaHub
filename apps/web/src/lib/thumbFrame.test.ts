import { describe, expect, it } from "vitest";
import { THUMBNAIL_FOCUS } from "@hub/contract";
import { FOCUS_LABEL, FOCUS_POSITION, siteFrame, softwareFrame } from "@/lib/thumbFrame";

describe("cadrage des vignettes", () => {
  it("logiciel : logo entier sur fond neutre ou sa couleur, capture qui remplit le cadre, image d'avant telle quelle", () => {
    const s = { thumbnailFit: "logo" as const, thumbnailColor: "#073028" };
    expect(softwareFrame(s)).toEqual({ fit: "contain", position: "center", background: null });
    expect(softwareFrame(s, "logo-couleur")).toEqual({ fit: "contain", position: "center", background: "#073028" });
    expect(softwareFrame(s, "capture")).toMatchObject({ fit: "cover", position: "center top" });
    expect(softwareFrame({ thumbnailFit: null, thumbnailColor: null })).toMatchObject({ fit: "cover" });
  });

  it("site : remplit le cadre autour du point d'intérêt ; neuf positions nommées", () => {
    expect(siteFrame({ thumbnailFocus: "haut" })).toEqual({ fit: "cover", position: "center top", background: null });
    expect(siteFrame({ thumbnailFocus: "haut" }, "bas-droite").position).toBe("right bottom");
    for (const f of THUMBNAIL_FOCUS) expect([FOCUS_POSITION[f], FOCUS_LABEL[f]].every(Boolean)).toBe(true);
  });
});
