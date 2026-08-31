import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("PR browser review UI contract", () => {
  it("uses the Creator form's stable accessible heading name across layouts", async () => {
    const [creatorForm, browserReview] = await Promise.all([
      readFile(new URL("../web/src/components/CreatorForm.tsx", import.meta.url), "utf8"),
      readFile(new URL("./pr-browser-review.mjs", import.meta.url), "utf8"),
    ]);
    const headingLevel = creatorForm.match(
      /<h([1-6])[^>]*>New clip<\/h\1>/,
    )?.[1];

    assert.ok(headingLevel, "Creator form New clip heading is missing");
    assert.ok(
      browserReview.includes(
        'getByRole("heading", { name: "New clip" })',
      ),
      "Browser review must locate New clip without coupling base/head capture to its heading level",
    );
  });

  it("reveals the redesigned jobs disclosure before checking API settlement", async () => {
    const [creatorPage, browserReview] = await Promise.all([
      readFile(new URL("../web/src/pages/CreatorPage.tsx", import.meta.url), "utf8"),
      readFile(new URL("./pr-browser-review.mjs", import.meta.url), "utf8"),
    ]);

    assert.ok(
      creatorPage.includes('<details className="creator-other-jobs">'),
      "Creator page jobs disclosure is missing",
    );
    assert.ok(
      browserReview.includes('page.locator("details.creator-other-jobs")'),
      "Browser review must account for the collapsed jobs disclosure",
    );
  });

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
