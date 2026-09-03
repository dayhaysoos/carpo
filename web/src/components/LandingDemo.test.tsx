import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadYoutubeApi, type YTPlayer } from "../youtube-api";
import { LandingDemo } from "./LandingDemo";

vi.mock("../youtube-api", () => ({ loadYoutubeApi: vi.fn() }));

type PlayerOptions = ConstructorParameters<
  NonNullable<typeof window.YT>["Player"]
>[1];
const players: FakeYoutubePlayer[] = [];

class FakeYoutubePlayer implements YTPlayer {
  muted = false;
  volume = 100;
  cueVideoById = vi.fn();
  loadVideoById = vi.fn();
  seekTo = vi.fn();
  getCurrentTime = () => 0;
  getDuration = () => 4347;
  getVideoData = () => ({ title: "The Next Token" });
  pauseVideo = vi.fn();
  playVideo = vi.fn();
  destroy = vi.fn();
  mute = () => {
    this.muted = true;
  };
  unMute = () => {
    this.muted = false;
  };
  isMuted = () => this.muted;
  getVolume = () => this.volume;
  setVolume = (volume: number) => {
    this.volume = volume;
  };

  constructor(
    _id: string,
    readonly options: PlayerOptions,
  ) {
    players.push(this);
  }

  ready() {
    this.options.events?.onReady?.({ target: this });
  }
}

async function openPodcast() {
  fireEvent.click(screen.getByRole("button", { name: "Podcast" }));
  await waitFor(() => expect(players).toHaveLength(1));
  act(() => players[0].ready());
  return players[0];
}

describe("landing sample carousel", () => {
  beforeEach(() => {
    players.length = 0;
    vi.mocked(loadYoutubeApi).mockResolvedValue();
    window.YT = {
      Player: FakeYoutubePlayer,
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
    };
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    delete window.YT;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("retains sound while replaying local cuts", async () => {
    render(<LandingDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Action film" }));
    const video = screen.getByLabelText<HTMLVideoElement>(
      "Charge sample video",
    );
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn sound on" }));
    const cut = screen.getByRole("button", { name: /The power surge/ });
    fireEvent.click(cut);
    await waitFor(() => expect(video.play).toHaveBeenCalledTimes(1));
    expect(video.getAttribute("src")).toBe("/demo/charge-2.mp4");
    expect(video.muted).toBe(false);
    video.currentTime = 4;
    fireEvent.click(cut);
    await waitFor(() => expect(video.play).toHaveBeenCalledTimes(2));
    expect(video.currentTime).toBe(0);
    expect(screen.getByLabelText("The power surge sample clip")).toBe(video);
    video.muted = true;
    fireEvent.volumeChange(video);
    expect(screen.getByRole("button", { name: "Turn sound on" })).toBeTruthy();
  });

  it("cues the official podcast, plays bounded moments, and resets the old player on carousel navigation", async () => {
    render(<LandingDemo />);
    expect(
      screen
        .getByRole("button", { name: "Podcast" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Turn sound on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn sound on" }));
    const podcast = await openPodcast();
    expect(podcast.muted).toBe(false);
    expect(podcast.cueVideoById).toHaveBeenCalledWith({
      videoId: "-DKSg1-v1Gg",
      startSeconds: 3033,
      endSeconds: 3066,
    });
    expect(podcast.loadVideoById).not.toHaveBeenCalled();
    expect(screen.getByText("“Can you be more clear?”")).toBeTruthy();
    const moment = screen.getByRole("button", {
      name: /When a file gets too big/,
    });
    fireEvent.click(moment);
    expect(podcast.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "-DKSg1-v1Gg",
      startSeconds: 3583,
      endSeconds: 3596,
    });
    fireEvent.click(moment);
    expect(podcast.loadVideoById).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Mute sound" }));
    expect(podcast.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next sample" }));
    expect(podcast.destroy).toHaveBeenCalledTimes(1);
    expect(
      screen.getByLabelText<HTMLVideoElement>("Charge sample video").muted,
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Action film" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Previous sample" }));
    expect(
      screen
        .getByRole("button", { name: /Give the plan feedback/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("uses the latest moment and sound choice when the remote player becomes ready", async () => {
    render(
      <StrictMode>
        <LandingDemo />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Podcast" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Review before you push/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn sound on" }));
    await waitFor(() => expect(players).toHaveLength(1));
    act(() => players[0].ready());
    expect(players[0].loadVideoById).toHaveBeenCalledWith({
      videoId: "-DKSg1-v1Gg",
      startSeconds: 3910,
      endSeconds: 3941,
    });
    expect(players[0].muted).toBe(false);
  });

  it("offers a timestamped source link when YouTube fails and recovers on source change", async () => {
    render(<LandingDemo />);
    const podcast = await openPodcast();
    fireEvent.click(
      screen.getByRole("button", { name: /Review before you push/ }),
    );
    act(() =>
      podcast.options.events?.onError?.({ target: podcast, data: 101 }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Preview unavailable",
    );
    expect(
      screen
        .getByRole("link", { name: /Watch at the source/ })
        .getAttribute("href"),
    ).toBe("https://www.youtube.com/watch?v=-DKSg1-v1Gg&t=3910s");
    fireEvent.click(screen.getByRole("button", { name: "Previous sample" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Your source stays intact",
    );
  });

  it("keeps recovery available when the remote API fails before it is ready", async () => {
    vi.mocked(loadYoutubeApi).mockRejectedValueOnce(
      new Error("Network unavailable"),
    );
    render(<LandingDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Podcast" }));
    await screen.findByRole("link", { name: /Watch at the source/ });
    fireEvent.click(
      screen.getByRole("button", { name: /Review before you push/ }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Preview unavailable",
    );
    expect(
      screen
        .getByRole("link", { name: /Watch at the source/ })
        .getAttribute("href"),
    ).toBe("https://www.youtube.com/watch?v=-DKSg1-v1Gg&t=3910s");
  });
});
