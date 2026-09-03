import { LandingDemo } from "../components/LandingDemo";
import { useWebMcpGettingStarted } from "../hooks/useWebMcpClipTools";
import "../styles/landing.css";

export function LandingPage() {
  useWebMcpGettingStarted();
  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="landing-header">
        <a className="public-wordmark" href="/" aria-label="Carpo home">
          Carpo<span>.</span>
        </a>
        <nav aria-label="Main">
          <a href="#how-it-works">How it works</a>
          <a href="/sign-in">Sign in</a>
        </nav>
      </header>
      <main id="main">
        <section className="landing-intro" aria-labelledby="landing-title">
          <h1 id="landing-title">
            Your video. <br />
            <span>More moments.</span>
          </h1>
          <div className="landing-pitch">
            <p>
              Turn the best parts of your videos into clips worth sharing. Find
              the moment, make it yours, and keep every cut in one private
              library.
            </p>
            <a className="landing-cta" href="/sign-in">
              Start clipping{" "}
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 12h15M12 5l7 7-7 7" />
              </svg>
            </a>
            <p className="landing-availability">
              Early access · Sign in with Google
            </p>
          </div>
        </section>
        <LandingDemo />
        <section
          className="landing-workflow"
          id="how-it-works"
          aria-labelledby="workflow-title"
        >
          <div className="workflow-intro">
            <h2 id="workflow-title">
              Meet your <br />
              <em>workspace.</em>
            </h2>
            <p>
              Keep your video, your timing, and your clips together. Preview the
              source, shape a cut, and see what you’ve made in one place.
            </p>
          </div>
          <figure className="workflow-overview">
            <picture>
              <source
                media="(max-width: 600px)"
                srcSet="/screenshots/workspace-mobile.webp 430w, /screenshots/workspace-mobile@2x.webp 860w, /screenshots/workspace-mobile@3x.webp 1290w"
                sizes="calc(100vw - 48px)"
                width="430"
                height="948"
              />
              <img
                src="/screenshots/workspace.webp"
                srcSet="/screenshots/workspace.webp 1440w, /screenshots/workspace@2x.webp 2880w, /screenshots/workspace@3x.webp 4320w"
                sizes="(max-width: 900px) calc(100vw - 48px), (max-width: 1376px) calc(100vw - 96px), 1280px"
                alt="The Carpo editor with Charge footage, a selected timeline range, clip settings, and three completed clips."
                width="1440"
                height="900"
                loading="lazy"
                decoding="async"
              />
            </picture>
            <figcaption>
              The real Carpo workspace, with clips made from Charge.
            </figcaption>
          </figure>
          <div className="workflow-detail">
            <div className="workflow-copy">
              <h3>Find the moment.</h3>
              <p>
                A quick move. A reaction. The part worth watching again. Drag
                the handles to choose your range, then fine-tune the start and
                end.
              </p>
              <p>Make the cut exactly where you want it.</p>
            </div>
            <figure className="workflow-image">
              <picture>
                <source
                  media="(max-width: 600px)"
                  srcSet="/screenshots/moment-mobile.webp 366w, /screenshots/moment-mobile@2x.webp 732w, /screenshots/moment-mobile@3x.webp 1098w"
                  sizes="calc(100vw - 48px)"
                  width="366"
                  height="572"
                />
                <img
                  src="/screenshots/moment.webp"
                  srcSet="/screenshots/moment.webp 774w, /screenshots/moment@2x.webp 1548w, /screenshots/moment@3x.webp 2322w"
                  sizes="(max-width: 900px) calc(100vw - 48px), (max-width: 1376px) calc(62.27vw - 100px), 758px"
                  alt="Carpo’s trim controls selecting a six-second moment, with timeline zoom and precise start and end times."
                  width="774"
                  height="466"
                  loading="lazy"
                  decoding="async"
                />
              </picture>
            </figure>
          </div>
          <div className="workflow-detail workflow-delivery">
            <div className="workflow-copy">
              <h3>Your clips, ready to share.</h3>
              <p>
                Every cut stays with its source in your private library. Preview
                the result, download it, or share a link you can revoke later.
              </p>
              <p>Come back for the next moment whenever you’re ready.</p>
            </div>
            <figure className="workflow-image">
              <picture>
                <source
                  media="(max-width: 600px)"
                  srcSet="/screenshots/clips-mobile.webp 402w, /screenshots/clips-mobile@2x.webp 804w, /screenshots/clips-mobile@3x.webp 1206w"
                  sizes="calc(100vw - 48px)"
                  width="402"
                  height="172"
                />
                <img
                  src="/screenshots/clips.webp"
                  srcSet="/screenshots/clips.webp 848w, /screenshots/clips@2x.webp 1696w, /screenshots/clips@3x.webp 2544w"
                  sizes="(max-width: 900px) calc(100vw - 48px), (max-width: 1376px) calc(62.27vw - 100px), 758px"
                  alt="Completed Charge clips in Carpo, with preview, share and export, and download controls."
                  width="848"
                  height="412"
                  loading="lazy"
                  decoding="async"
                />
              </picture>
            </figure>
          </div>
          <p className="workflow-credit">
            Interface screenshots use{" "}
            <a href="https://studio.blender.org/projects/charge/">Charge</a>, ©
            Blender Foundation,{" "}
            <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
            . Footage shortened for this walkthrough.
          </p>
        </section>
        <section className="landing-finish" aria-labelledby="finish-title">
          <div>
            <h2 id="finish-title">Keep the good parts.</h2>
            <p>Your sources, your decisions, your library.</p>
          </div>
          <a className="landing-cta" href="/sign-in">
            Open Carpo{" "}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12h15M12 5l7 7-7 7" />
            </svg>
          </a>
        </section>
      </main>
      <footer className="landing-footer">
        <a className="public-wordmark" href="/">
          Carpo<span>.</span>
        </a>
        <p>Seize the moment.</p>
        <a href="/sign-in">Sign in</a>
      </footer>
    </div>
  );
}
