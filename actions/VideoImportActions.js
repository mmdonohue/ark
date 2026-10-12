'use strict';

// VideoImportActions — media.detect_scenes, the one new capability
// pipelines/youtube-scenes needs beyond what MediaImportActions.js already
// provides. Replaces each discovered video file with the scene thumbnails
// PySceneDetect finds inside it: one representative JPG per detected
// scene, shaped exactly like a source.discover entry so every downstream
// stage (fingerprint, resolve_duplicate, preserve, partition) runs
// unchanged on it.
//
// Shells out to the scenedetect CLI directly (installed in
// backend/scripts/venv) rather than a custom Python wrapper — no
// "executor resolution" system exists in this codebase yet (CHARTER.md
// describes one, aspirationally; nothing implements it), so this follows
// the same plain-fs posture the rest of MediaImportActions.js already
// uses. A missing binary throws a clear error rather than attempting to
// install one (CHARTER.md: "a missing executor does not authorize ARK to
// install one").

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCENEDETECT_BIN = process.env.SCENEDETECT_BIN
  || path.resolve(__dirname, '../../scripts/venv/bin/scenedetect');

// One combined invocation — list-scenes (CSV) and save-images (one JPG per
// scene) both write into the same outDir, and content-detection only runs
// once for both outputs (confirmed: chaining them costs nothing extra
// over running just one).
function _runSceneDetect(videoPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(SCENEDETECT_BIN, [
    '-i', videoPath,
    'detect-content',
    'list-scenes', '-o', outDir,
    'save-images', '-o', outDir, '-n', '1',
  ], { stdio: 'pipe' });
}

// Row shape (confirmed live): first line is a "Timecode List:,..." summary,
// second line is the header, then one row per scene:
//   Scene Number,Start Frame,Start Timecode,Start Time (seconds),
//   End Frame,End Timecode,End Time (seconds),
//   Length (frames),Length (timecode),Length (seconds)
function _parseSceneCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  return lines.slice(2).map(line => {
    const cols = line.split(',');
    return {
      scene_number: Number(cols[0]),
      start_time:   Number(cols[3]),
      end_time:     Number(cols[6]),
      duration:     Number(cols[9]),
    };
  });
}

async function detectScenes(ctx, payload, packet) {
  const { files = [] } = payload;
  const results = [];
  let sceneCount = 0;
  const videoCount = files.filter(f => f.media_type === 'video').length;

  if (videoCount && !fs.existsSync(SCENEDETECT_BIN)) {
    throw new Error(`scenedetect not found at ${SCENEDETECT_BIN} — pip install "scenedetect[opencv]" in backend/scripts/venv`);
  }

  for (const f of files) {
    if (f.media_type !== 'video') { results.push(f); continue; }

    const videoBase = path.basename(f.source_path, path.extname(f.source_path));
    const outDir = path.join(path.dirname(f.source_path), `${videoBase}-scenes`);
    _runSceneDetect(f.source_path, outDir);

    const csvPath = path.join(outDir, `${videoBase}-Scenes.csv`);
    if (!fs.existsSync(csvPath)) throw new Error(`scenedetect produced no scene list at ${csvPath}`);

    for (const scene of _parseSceneCsv(csvPath)) {
      const imgPath = path.join(outDir, `${videoBase}-Scene-${String(scene.scene_number).padStart(3, '0')}-01.jpg`);
      // scenedetect can skip an image for a degenerate (near-zero-length)
      // scene — never abort the whole video for one missing thumbnail.
      if (!fs.existsSync(imgPath)) continue;
      const stat = fs.statSync(imgPath);
      // preserveMedia uses basename verbatim as the artifact's title — this
      // is what actually shows in the gallery, so it carries the scene
      // number (zero-padded so it also sorts correctly as plain text) and
      // duration directly, rather than a generic filename-derived title.
      const sceneNum = String(scene.scene_number).padStart(2, '0');
      results.push({
        source_path: imgPath,
        basename:    `Scene ${sceneNum} — ${scene.duration.toFixed(1)}s`,
        ext:         'jpg',
        media_type:  'image',
        file_size:   stat.size,
        mtime:       stat.mtime.toISOString(),
        metadata: {
          scene_number: scene.scene_number,
          start_time:   scene.start_time,
          end_time:     scene.end_time,
          duration:     scene.duration,
          source_video: f.source_path,
        },
      });
      sceneCount++;
    }
  }

  packet.log.push(`media.detect_scenes → ${sceneCount} scene(s) across ${videoCount} video(s)`);
  return { data: { files: results } };
}

module.exports = { detectScenes };
