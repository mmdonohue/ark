'use strict';

// CinemaRenderActions — drives the headless-capture render page
// (/render/cinema/[id].tsx) with Playwright, encodes the resulting frame
// sequence into an Instagram Reel-sized MP4 via ffmpeg, and attaches it to
// the Ark as artifact_media. See PipelineResolver/ChainExecutor for how
// this gets invoked as a pipeline stage (pipelines/cinema-reel).
//
// Cuts are hard between slides, not the UI's 0.6s crossfade — this
// captures one settled screenshot per slide and holds it for that slide's
// own duration (window.__cinemaDurations, same AUTO_ADVANCE_MS the live
// Cinema view uses). A smoother version would need to capture the
// transition itself frame-by-frame; not built here, v1 only needs a valid
// ad-length reel, not a frame-perfect match of the live crossfade.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const Artifact       = require('../domain/Artifact');
const ArtifactMedia  = require('../domain/ArtifactMedia');
const { getManifest } = require('../core/bootstrap');

const REEL_WIDTH  = 1080;
const REEL_HEIGHT = 1920;
const FPS         = 30;
// Defensive fallback only — window.__cinemaDurations (Cinematic.tsx) always
// supplies a real per-slide value now (MAX_AD_DURATION_MS / slide count, so
// the reel stays within its ad-length ceiling), this never fires in
// practice unless that array is somehow shorter than the slide count.
const DEFAULT_SLIDE_DURATION_MS = 4000;

async function renderReel(ctx, payload, packet) {
  const { ark_id } = payload;
  if (!ark_id) throw new Error('ark_id is required');

  const ark = await Artifact.findById(ark_id, ctx);
  if (!ark) throw Object.assign(new Error('Ark not found'), { status: 404 });

  // playwright/chromium are meaningful runtime dependencies (native browser
  // binary) — required lazily so every other action in this registry keeps
  // working even in an environment where they haven't been installed.
  const { chromium } = require('playwright');

  const baseUrl   = process.env.RENDER_BASE_URL || 'http://localhost:3000';
  const renderUrl = `${baseUrl}/render/cinema/${ark_id}`;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinema-render-'));
  const browser = await chromium.launch();

  const framePaths = [];
  const durations  = [];

  try {
    const page = await browser.newPage({ viewport: { width: REEL_WIDTH, height: REEL_HEIGHT } });
    await page.goto(renderUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.__cinemaSlideCount === 'number');

    const slideCount     = await page.evaluate(() => window.__cinemaSlideCount);
    const slideDurations = await page.evaluate(() => window.__cinemaDurations);
    if (!slideCount) throw new Error('Ark has no visible slides to render');

    for (let i = 0; i < slideCount; i++) {
      await page.evaluate(index => window.__cinemaGoTo(index), i);
      await page.waitForFunction(() => window.__cinemaTransitioning === false);
      // A short settle delay past the flag flip — image swaps can lag one
      // paint behind the transitioning flag itself.
      await page.waitForTimeout(150);

      const framePath = path.join(workDir, `frame_${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: framePath });
      framePaths.push(framePath);
      durations.push((slideDurations?.[i] || DEFAULT_SLIDE_DURATION_MS) / 1000);
    }
  } finally {
    await browser.close();
  }

  const outputPath = path.join(workDir, 'reel.mp4');
  await _encodeReel(framePaths, durations, outputPath, { width: REEL_WIDTH, height: REEL_HEIGHT, fps: FPS });

  const buffer  = fs.readFileSync(outputPath);
  const storage = getManifest().get('storage');
  const { url } = await storage.upload({
    file: { buffer, filename: `${ark_id}-${Date.now()}.mp4`, contentType: 'video/mp4' },
    folder: 'cinema-renders',
  });

  fs.rmSync(workDir, { recursive: true, force: true });

  const media = new ArtifactMedia({
    artifact_id: ark_id,
    media_type: 'video',
    url,
    file_size: buffer.length,
    mime_type: 'video/mp4',
    title: 'Cinema reel',
    metadata: {
      render_type: 'cinema_reel',
      width: REEL_WIDTH,
      height: REEL_HEIGHT,
      fps: FPS,
      slide_count: framePaths.length,
    },
  }, { context: ctx });
  await media.save();

  packet.log.push(`cinema.render_reel → ark:${ark_id} (${framePaths.length} slides) → media:${media.id}`);
  return { data: { media: media.data, url } };
}

// Builds an ffmpeg concat-demuxer list (one entry per slide, held for its
// own duration) and encodes a single H.264 MP4 from the frame sequence.
async function _encodeReel(framePaths, durations, outputPath, { width, height, fps }) {
  if (!framePaths.length) throw new Error('No frames to encode');

  const listPath = outputPath.replace(/\.mp4$/, '.concat.txt');
  const lines = [];
  for (let i = 0; i < framePaths.length; i++) {
    lines.push(`file '${framePaths[i]}'`);
    lines.push(`duration ${durations[i]}`);
  }
  // ffmpeg's concat demuxer drops the final duration unless the last file
  // is also repeated without one — a documented quirk, not a bug here. But
  // empirically that workaround doesn't produce a ~0-length phantom
  // segment the way the docs imply — it holds the repeated last frame for
  // roughly one more full slide duration, so the encoded output runs
  // longer than sum(durations) by about that much (measured: 7 slides ×
  // ~4.57s each = 32.0s intended, actual output 36.6s — the gap matches
  // one slide almost exactly). -t below clips the ENCODED output to the
  // intended total directly rather than trusting the demuxer's internal
  // timing to land there on its own — load-bearing for the reel's 32s ad
  // ceiling (see Cinematic.tsx's MAX_AD_DURATION_MS), not just cosmetic.
  lines.push(`file '${framePaths[framePaths.length - 1]}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  const totalSeconds = durations.reduce((sum, d) => sum + d, 0);

  // Video-only output was getting rejected by Facebook's Reels upload —
  // the H.264/yuv420p video track itself is already exactly what Meta
  // requires (confirmed via ffprobe: High profile, level 4.0), but the file
  // had zero audio streams at all, which their upload validator rejects
  // outright regardless of video codec correctness. A silent AAC track
  // (lavfi's anullsrc, same duration as the video via the shared -t) fixes
  // that without changing anything the viewer perceives. +faststart moves
  // the moov atom to the front of the file — standard for anything meant
  // to be uploaded to a social platform rather than played from local disk.
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', String(totalSeconds),
    '-vf', `scale=${width}:${height},fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ]);

  fs.unlinkSync(listPath);
}

module.exports = { renderReel };
module.exports._internals = { _encodeReel };
