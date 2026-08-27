const MULTILINGUAL_PANTS = Object.freeze({
  id: "multilingual-pants",
  changedPath: "review-challenges/multilingual-pants.json",
  steps: Object.freeze([
    Object.freeze({ language: "English", value: "pants" }),
    Object.freeze({ language: "Spanish", value: "pantalones" }),
    Object.freeze({ language: "French", value: "pantalon" }),
    Object.freeze({ language: "Japanese", value: "ズボン" }),
  ]),
});

const PROOF_CHALLENGES = new Map([[MULTILINGUAL_PANTS.id, MULTILINGUAL_PANTS]]);

export function resolveProofChallenge(id) {
  if (id === undefined) return undefined;
  const challenge = PROOF_CHALLENGES.get(id);
  if (!challenge) throw new Error("Unknown PR review proof challenge");
  return challenge;
}

export function selectProofChallenge(files) {
  const changedPaths = new Set(
    files
      .map((file) => (typeof file === "string" ? file : file?.path))
      .filter((file) => typeof file === "string"),
  );
  return changedPaths.has(MULTILINGUAL_PANTS.changedPath)
    ? MULTILINGUAL_PANTS
    : undefined;
}

export const PR_REVIEW_PROOF_CHALLENGES = Object.freeze({
  multilingualPants: MULTILINGUAL_PANTS,
});
