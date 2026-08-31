import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("PR browser review UI contract", () => {
  it("uses the Creator form's current accessible overlay-text label", async () => {
    const [creatorForm, browserReview] = await Promise.all([
      readFile(new URL("../web/src/components/CreatorForm.tsx", import.meta.url), "utf8"),
      readFile(new URL("./pr-browser-review.mjs", import.meta.url), "utf8"),
    ]);
    const captionValueIndex = creatorForm.indexOf("value={caption}");
    assert.notEqual(captionValueIndex, -1, "Creator form caption input is missing");
    const fieldStart = creatorForm.lastIndexOf("<label", captionValueIndex);
    const fieldMarkup = creatorForm.slice(fieldStart, captionValueIndex);
    const label = fieldMarkup.match(/<span[^>]*>([^<]+)<\/span>/)?.[1];

    assert.equal(label, "Overlay text (optional)");
    assert.ok(
      browserReview.includes(`.getByLabel(${JSON.stringify(label)})`),
      `Browser review must locate the Creator form overlay field by ${JSON.stringify(label)}`,
    );
    assert.ok(
      browserReview.includes('.getByLabel("Caption (optional)")'),
      "Browser review must retain the prior label for exact-base visual capture",
    );
  });
});
