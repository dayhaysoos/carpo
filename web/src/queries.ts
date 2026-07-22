export const CLIPS_QUERY_KEY = ["clips"] as const;
export const SOURCE_VIDEOS_QUERY_KEY = ["source-videos"] as const;
export const sourceVideosQueryKey = (archived: boolean) =>
  ["source-videos", { archived }] as const;
export const sourceVideoQueryKey = (id: string) =>
  ["source-video", id] as const;
