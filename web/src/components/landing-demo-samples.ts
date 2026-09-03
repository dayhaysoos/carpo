export interface DemoMoment {
  title: string;
  start: number;
  end: number;
  quote?: string;
}

export interface DemoSample {
  id: string;
  category: string;
  title: string;
  description: string;
  media:
    | { kind: "local"; source: string; poster: string; clips: string[] }
    | { kind: "youtube"; videoId: string };
  moments: DemoMoment[];
}

// Authored demonstration cuts. Podcast excerpts are from the official episode's
// English captions; source links and selection provenance live in demo/README.md.
export const demoSamples: DemoSample[] = [
  {
    id: "next-token",
    category: "Podcast",
    title: "The Next Token",
    description: "Episode 02 · A closer look at Dillon’s coding workflow.",
    media: { kind: "youtube", videoId: "-DKSg1-v1Gg" },
    moments: [
      {
        title: "Give the plan feedback",
        start: 3033,
        end: 3066,
        quote: "Can you be more clear?",
      },
      {
        title: "When a file gets too big",
        start: 3583,
        end: 3596,
        quote: "This file is getting too big.",
      },
      {
        title: "Review before you push",
        start: 3910,
        end: 3941,
        quote: "I did not want to push code",
      },
    ],
  },
  {
    id: "charge",
    category: "Action film",
    title: "Charge",
    description: "One action sequence. Three cuts with their own energy.",
    media: {
      kind: "local",
      source: "/demo/charge.mp4",
      poster: "/demo/charge.jpg",
      clips: ["/demo/charge-1.mp4", "/demo/charge-2.mp4", "/demo/charge-3.mp4"],
    },
    moments: [
      { title: "The first strike", start: 0, end: 6 },
      { title: "The power surge", start: 6, end: 12 },
      { title: "The counterattack", start: 12, end: 18 },
    ],
  },
];

export function demoTime(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
