#!/usr/bin/env node
/**
 * Celandia: Xirtoth — Procedural Audio & Sound Effects Pipeline
 *
 * Synthesizes 16-bit PCM WAV files (stereo music & ambience loops, mono 3D spatial SFX,
 * combat swings/impacts, footsteps, spell kits, creature voices, and UI chimes) inspired by
 * Celandia's five kingdoms and the procedural WebAudio engines in `reincarnation` and
 * `valleygirlofdeath`, copies real voice audition recordings where available, and writes
 * all 22 audio DBCs to `WoW/Data/DBFilesClient/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// 1. DSP & 16-Bit PCM WAV Synthesis Engine
// ---------------------------------------------------------------------------

function clampSample(x) {
  // Soft-clipping tanh limiter to keep multi-layered mixes warm and distortion-free
  const limited = Math.tanh(x * 0.95);
  return Math.max(-32767, Math.min(32767, Math.round(limited * 32767)));
}

/**
 * Encode mono (Float32Array) or stereo ([Float32Array, Float32Array]) buffers into a
 * standard 44-byte RIFF WAVE 16-bit signed PCM Buffer.
 */
function encodeWav(channels, sampleRate = SAMPLE_RATE) {
  const isStereo = Array.isArray(channels);
  const numChannels = isStereo ? 2 : 1;
  const left = isStereo ? channels[0] : channels;
  const right = isStereo ? channels[1] : channels;
  const numFrames = left.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // AudioFormat = 1 (PCM)
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // BitsPerSample = 16
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  if (isStereo) {
    for (let i = 0; i < numFrames; i++) {
      buf.writeInt16LE(clampSample(left[i]), offset);
      buf.writeInt16LE(clampSample(right[i]), offset + 2);
      offset += 4;
    }
  } else {
    for (let i = 0; i < numFrames; i++) {
      buf.writeInt16LE(clampSample(left[i]), offset);
      offset += 2;
    }
  }
  return buf;
}

// Deterministic PRNG so generated WAV files are 100% reproducible across builds
let rngState = 0xCE1A4D1A;
function rand() {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return (rngState / 0x100000000) * 2 - 1;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Apply a multi-tap stereo Schroeder-style reverb tail + crossfade loop smoothing
 */
function applyStereoReverbAndLoop(left, right, wet = 0.25, loopCrossfadeSec = 0.25, maxPeak = 0.34) {
  const n = left.length;
  const tapsL = [Math.floor(0.029 * SAMPLE_RATE), Math.floor(0.061 * SAMPLE_RATE), Math.floor(0.113 * SAMPLE_RATE)];
  const tapsR = [Math.floor(0.037 * SAMPLE_RATE), Math.floor(0.073 * SAMPLE_RATE), Math.floor(0.127 * SAMPLE_RATE)];
  const gains = [0.45, 0.30, 0.18];

  for (let t = 0; t < tapsL.length; t++) {
    const dL = tapsL[t];
    const dR = tapsR[t];
    const g = gains[t] * wet;
    for (let i = dL; i < n; i++) left[i] += right[(i - dL) % n] * g;
    for (let i = dR; i < n; i++) right[i] += left[(i - dR) % n] * g;
  }

  // Seamless loop boundary crossfade so music & ambience loops never click on wrap
  const fadeSamples = Math.min(Math.floor(loopCrossfadeSec * SAMPLE_RATE), Math.floor(n / 4));
  if (fadeSamples > 0) {
    for (let i = 0; i < fadeSamples; i++) {
      const alpha = i / fadeSamples; // 0 -> 1 at start
      const tailIdx = n - fadeSamples + i;
      const startL = left[i];
      const startR = right[i];
      const endL = left[tailIdx];
      const endR = right[tailIdx];
      left[i] = startL * alpha + endL * (1 - alpha);
      right[i] = startR * alpha + endR * (1 - alpha);
      left[tailIdx] = endL * alpha + startL * (1 - alpha) * 0.5;
      right[tailIdx] = endR * alpha + startR * (1 - alpha) * 0.5;
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const aL = Math.abs(left[i]);
    const aR = Math.abs(right[i]);
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
  }
  const scale = peak > 0.001 ? Math.min(maxPeak / peak, maxPeak) : maxPeak;
  for (let i = 0; i < n; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }
  return [left, right];
}

// ---------------------------------------------------------------------------
// 2. Music Track Synthesizers (6 Celandia Themes)
// ---------------------------------------------------------------------------

function addNoteStereo(left, right, startSec, durSec, freq, amp, pan, timbre) {
  const start = Math.floor(startSec * SAMPLE_RATE);
  const len = Math.floor(durSec * SAMPLE_RATE);
  const n = left.length;
  const gainL = amp * Math.cos(((pan + 1) * Math.PI) / 4);
  const gainR = amp * Math.sin(((pan + 1) * Math.PI) / 4);
  let phase = 0;

  for (let i = 0; i < len; i++) {
    const idx = (start + i) % n;
    const t = i / SAMPLE_RATE;
    const u = i / len;
    phase += (TWO_PI * freq) / SAMPLE_RATE;

    let sample = 0;
    if (timbre === 'celesta') {
      // Music-box celesta: fundamental + 2x + inharmonic 4.2x chime with crisp exponential decay
      const env = Math.min(1, t / 0.006) * Math.exp(-t * 4.2);
      sample = (
        Math.sin(phase) * 0.65 +
        Math.sin(phase * 2) * 0.22 * Math.exp(-t * 7) +
        Math.sin(phase * 4.2) * 0.13 * Math.exp(-t * 14)
      ) * env;
    } else if (timbre === 'harp') {
      // Plucked chamber harp: Karplus-like warm harmonic series
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 2.6);
      sample = (
        Math.sin(phase) * 0.6 +
        Math.sin(phase * 2) * 0.25 * Math.exp(-t * 4) +
        Math.sin(phase * 3) * 0.12 * Math.exp(-t * 6) +
        Math.sin(phase * 4) * 0.05 * Math.exp(-t * 9)
      ) * env;
    } else if (timbre === 'icebell') {
      // Crystalline FM ice bell
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 3.0);
      const mod = Math.sin(phase * 3.5) * 1.8 * Math.exp(-t * 5.0);
      sample = (Math.sin(phase + mod) * 0.7 + Math.sin(phase * 2.003) * 0.3) * env;
    } else if (timbre === 'choir') {
      // Warm breathing choir pad with slow attack/release and chorus detune
      const env = Math.sin(Math.PI * u) * Math.sin(Math.PI * u);
      const vib = Math.sin(TWO_PI * 4.8 * t) * 0.003;
      sample = (
        Math.sin(phase * (1 + vib)) * 0.45 +
        Math.sin(phase * (1 - vib * 0.9)) * 0.35 +
        Math.sin(phase * 2.0) * 0.15 +
        Math.sin(phase * 3.0) * 0.05
      ) * env;
    } else if (timbre === 'flute') {
      // Breathy bamboo shakuhachi flute with delayed vibrato and air chiff
      const env = Math.min(1, t / 0.08) * Math.max(0, 1 - Math.max(0, u - 0.75) * 4);
      const vib = t > 0.15 ? Math.sin(TWO_PI * 5.2 * t) * 0.006 : 0;
      const breath = rand() * 0.08 * Math.exp(-t * 8);
      sample = (
        Math.sin(phase * (1 + vib)) * 0.68 +
        Math.sin(phase * 2 * (1 + vib)) * 0.18 +
        Math.sin(phase * 3 * (1 + vib)) * 0.08 +
        breath
      ) * env;
    } else if (timbre === 'marimba') {
      // Wooden marimba bar: fundamental + 4th harmonic (2 octaves up) + mallet click
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 9.5);
      sample = (
        Math.sin(phase) * 0.78 +
        Math.sin(phase * 4.0) * 0.22 * Math.exp(-t * 25)
      ) * env;
    } else if (timbre === 'horn') {
      // Noble French horn: warm brass harmonic series with gentle swell
      const env = Math.min(1, t / 0.14) * Math.exp(-t * 0.8) * (1 - u * 0.3);
      sample = (
        Math.sin(phase) * 0.40 +
        Math.sin(phase * 2) * 0.32 +
        Math.sin(phase * 3) * 0.16 +
        Math.sin(phase * 4) * 0.08 +
        Math.sin(phase * 5) * 0.04
      ) * env;
    } else if (timbre === 'cello') {
      // Dark fairy solo cello: bowed odd/even harmonics with expressive vibrato
      const env = Math.min(1, t / 0.12) * (1 - Math.pow(u, 3) * 0.5);
      const vib = Math.sin(TWO_PI * 5.5 * t) * 0.005;
      const p = phase * (1 + vib);
      sample = (
        Math.sin(p) * 0.45 +
        Math.sin(p * 2) * 0.25 +
        Math.sin(p * 3) * 0.15 +
        Math.sin(p * 4) * 0.08 +
        Math.sin(p * 5) * 0.05
      ) * env;
    }

    left[idx] += sample * gainL;
    right[idx] += sample * gainR;
  }
}

function synthPorcelainWakeMusic() {
  // 8-second loop: D major / B minor music-box celesta & chamber harp arpeggios
  const dur = 8.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const arpNotes = [
    74, 78, 81, 83, 78, 74, 76, 69,
    71, 74, 78, 81, 78, 74, 73, 69,
    67, 71, 74, 78, 74, 71, 69, 73,
    74, 78, 81, 86, 85, 81, 78, 74,
  ];
  for (let i = 0; i < arpNotes.length; i++) {
    const pan = ((i % 4) - 1.5) * 0.35;
    addNoteStereo(left, right, i * 0.25, 0.9, midiToFreq(arpNotes[i]), 0.28, pan, 'celesta');
  }
  const bassNotes = [50, 57, 47, 54, 43, 50, 45, 52];
  for (let i = 0; i < bassNotes.length; i++) {
    addNoteStereo(left, right, i * 1.0, 1.8, midiToFreq(bassNotes[i]), 0.26, -0.2, 'harp');
    addNoteStereo(left, right, i * 1.0 + 0.5, 1.4, midiToFreq(bassNotes[i] + 12), 0.20, 0.2, 'harp');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.35, 0.3));
}

function synthFrostbellLagoonMusic() {
  // 8-second loop: E Lydian crystalline ice bells & warm breathing choir pad
  const dur = 8.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const chords = [
    [52, 59, 64, 68, 71], // E maj7
    [54, 61, 66, 69, 73], // F#7 / E
    [49, 56, 61, 64, 68], // C#m7
    [52, 59, 66, 68, 75], // E maj9(#11)
  ];
  for (let c = 0; c < chords.length; c++) {
    for (let k = 0; k < chords[c].length; k++) {
      const pan = (k - 2) * 0.25;
      addNoteStereo(left, right, c * 2.0, 2.6, midiToFreq(chords[c][k]), 0.14, pan, 'choir');
    }
  }
  const bellMelody = [76, 80, 83, 78, 76, 75, 71, 73, 76, 83, 85, 80, 78, 76, 73, 71];
  for (let i = 0; i < bellMelody.length; i++) {
    const pan = (i % 2 === 0 ? -0.45 : 0.45);
    addNoteStereo(left, right, i * 0.5, 1.4, midiToFreq(bellMelody[i]), 0.24, pan, 'icebell');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.42, 0.35));
}

function synthGlasswakeMesasMusic() {
  // 8-second loop: A Dorian breathy bamboo flute & wooden marimba ostinato
  const dur = 8.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const marimbaPattern = [57, 64, 67, 69, 64, 67, 55, 62, 66, 69, 62, 66];
  for (let bar = 0; bar < 4; bar++) {
    for (let step = 0; step < 8; step++) {
      const note = marimbaPattern[(bar * 3 + step) % marimbaPattern.length];
      const pan = ((step % 3) - 1) * 0.35;
      addNoteStereo(left, right, bar * 2.0 + step * 0.25, 0.35, midiToFreq(note), 0.28, pan, 'marimba');
    }
  }
  const flutePhrases = [
    { start: 0.25, dur: 1.5, midi: 69 },
    { start: 1.75, dur: 0.75, midi: 72 },
    { start: 2.50, dur: 1.25, midi: 74 },
    { start: 4.00, dur: 1.25, midi: 78 },
    { start: 5.25, dur: 0.75, midi: 76 },
    { start: 6.00, dur: 1.75, midi: 74 },
  ];
  for (const p of flutePhrases) {
    addNoteStereo(left, right, p.start, p.dur, midiToFreq(p.midi), 0.30, 0.1, 'flute');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.28, 0.3));
}

function synthAureateReachMusic() {
  // 8-second loop: Noble French horn fifths & golden strings in C Major / F Lydian
  const dur = 8.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const hornCalls = [
    { start: 0.0, dur: 1.8, notes: [48, 55, 60, 64] },
    { start: 2.0, dur: 1.8, notes: [53, 60, 65, 69] },
    { start: 4.0, dur: 1.8, notes: [55, 62, 67, 71] },
    { start: 6.0, dur: 1.9, notes: [48, 55, 64, 72] },
  ];
  for (const call of hornCalls) {
    for (let i = 0; i < call.notes.length; i++) {
      const pan = (i - 1.5) * 0.25;
      addNoteStereo(left, right, call.start, call.dur, midiToFreq(call.notes[i]), 0.20, pan, 'horn');
    }
  }
  const harpCounter = [72, 76, 79, 84, 79, 76, 77, 81, 84, 88, 84, 81, 79, 83, 86, 79];
  for (let i = 0; i < harpCounter.length; i++) {
    addNoteStereo(left, right, i * 0.5, 0.9, midiToFreq(harpCounter[i]), 0.18, (i % 2 ? 0.4 : -0.4), 'harp');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.36, 0.35));
}

function synthNocturnumIsleMusic() {
  // 8-second loop: Dark fairy solo cello & obsidian chimes in C# Harmonic Minor
  const dur = 8.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const celloLine = [
    { start: 0.0, dur: 1.9, midi: 49, bass: 37 },
    { start: 2.0, dur: 1.9, midi: 52, bass: 40 },
    { start: 4.0, dur: 1.9, midi: 56, bass: 44 },
    { start: 6.0, dur: 1.9, midi: 55, bass: 37 },
  ];
  for (const c of celloLine) {
    addNoteStereo(left, right, c.start, c.dur, midiToFreq(c.bass), 0.24, -0.25, 'cello');
    addNoteStereo(left, right, c.start, c.dur, midiToFreq(c.midi), 0.26, 0.15, 'cello');
  }
  const obsidianChimes = [73, 76, 80, 84, 80, 76, 75, 73, 76, 80, 85, 84, 80, 75, 73, 68];
  for (let i = 0; i < obsidianChimes.length; i++) {
    const pan = ((i % 4) - 1.5) * 0.35;
    addNoteStereo(left, right, i * 0.5, 1.1, midiToFreq(obsidianChimes[i]), 0.20, pan, 'icebell');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.40, 0.35));
}

function synthCelandiaTitleTheme() {
  // 10-second grand symphonic overture combining Porcelain celesta, Aureate horns, Frostbell choir & Nocturnum cello
  const dur = 10.0;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const progression = [
    { start: 0.0, dur: 2.5, bass: 38, chord: [50, 57, 62, 66] }, // D maj
    { start: 2.5, dur: 2.5, bass: 47, chord: [47, 54, 59, 62] }, // B min
    { start: 5.0, dur: 2.5, bass: 43, chord: [43, 50, 55, 62] }, // G maj
    { start: 7.5, dur: 2.5, bass: 45, chord: [45, 52, 57, 61] }, // A maj
  ];
  for (const p of progression) {
    addNoteStereo(left, right, p.start, p.dur, midiToFreq(p.bass), 0.26, -0.15, 'cello');
    for (let i = 0; i < p.chord.length; i++) {
      addNoteStereo(left, right, p.start, p.dur, midiToFreq(p.chord[i]), 0.15, (i - 1.5) * 0.25, 'horn');
      addNoteStereo(left, right, p.start, p.dur, midiToFreq(p.chord[i] + 12), 0.10, (1.5 - i) * 0.25, 'choir');
    }
  }
  const motif = [
    74, 78, 81, 86, 85, 81, 78, 74,
    71, 74, 78, 83, 81, 78, 74, 71,
    67, 71, 74, 79, 78, 74, 71, 69,
    73, 76, 81, 85, 86, 81, 78, 76,
  ];
  for (let i = 0; i < motif.length; i++) {
    const t = (i / motif.length) * dur;
    addNoteStereo(left, right, t, 0.85, midiToFreq(motif[i]), 0.24, ((i % 3) - 1) * 0.35, 'celesta');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.38, 0.4));
}

// ---------------------------------------------------------------------------
// 3. Kingdom Ambience & Liquid Loop Synthesizers
// ---------------------------------------------------------------------------

function synthAmbienceLoop(mode) {
  const dur = 4.5;
  const n = Math.floor(dur * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  let lpL = 0, lpR = 0, bpL = 0, bpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const wL = rand();
    const wR = rand();

    if (mode === 'porcelain') {
      // Gentle coastal breeze + delicate high wind chimes
      const cutoff = 0.04 + 0.02 * Math.sin(TWO_PI * (t / dur));
      lpL += cutoff * (wL - lpL);
      lpR += cutoff * (wR - lpR);
      left[i] = lpL * 0.30;
      right[i] = lpR * 0.30;
    } else if (mode === 'frostbell') {
      // Rhythmic lagoon wave wash + crystalline shimmer
      const waveEnv = 0.5 + 0.45 * Math.sin(TWO_PI * (t / dur));
      lpL += 0.06 * (wL - lpL);
      lpR += 0.06 * (wR - lpR);
      const shimmer = Math.sin(TWO_PI * 1760 * t) * Math.sin(TWO_PI * 0.5 * t) * 0.03;
      left[i] = lpL * 0.35 * waveEnv + shimmer;
      right[i] = lpR * 0.35 * waveEnv - shimmer;
    } else if (mode === 'glasswake') {
      // Resonant canyon desert wind whistling across glass mesas
      const lfo = 0.08 + 0.04 * Math.sin(TWO_PI * 2 * (t / dur));
      lpL += lfo * (wL - lpL);
      bpL += 0.03 * (lpL - bpL);
      lpR += lfo * (wR - lpR);
      bpR += 0.03 * (lpR - bpR);
      const whistle = Math.sin(TWO_PI * (520 + 40 * Math.sin(TWO_PI * (t / dur))) * t) * 0.04;
      left[i] = (lpL - bpL) * 0.40 + whistle;
      right[i] = (lpR - bpR) * 0.40 + whistle * 0.8;
    } else if (mode === 'aureate') {
      // Warm sunlit temple harmonic resonance (110 + 165 + 220 Hz) + soft air
      lpL += 0.03 * (wL - lpL);
      lpR += 0.03 * (wR - lpR);
      const drone = (
        Math.sin(TWO_PI * 110 * t) * 0.12 +
        Math.sin(TWO_PI * 165 * t) * 0.09 +
        Math.sin(TWO_PI * 220 * t) * 0.06
      );
      left[i] = lpL * 0.18 + drone;
      right[i] = lpR * 0.18 + drone;
    } else if (mode === 'nocturnum') {
      // Nocturnal cricket chorus (AM-modulated 3.8 kHz chirps) + twilight wind
      lpL += 0.025 * (wL - lpL);
      lpR += 0.025 * (wR - lpR);
      const pulse = Math.max(0, Math.sin(TWO_PI * 4.0 * t)) * Math.max(0, Math.sin(TWO_PI * 28.0 * t));
      const cricketL = Math.sin(TWO_PI * 3820 * t) * pulse * 0.09;
      const cricketR = Math.sin(TWO_PI * 3940 * (t + 0.12)) * pulse * 0.09;
      left[i] = lpL * 0.25 + cricketL;
      right[i] = lpR * 0.25 + cricketR;
    } else if (mode === 'ghost') {
      // Ethereal spirit-world spectral whisper & hollow choir drone
      lpL += 0.02 * (wL - lpL);
      lpR += 0.02 * (wR - lpR);
      const spectral = (
        Math.sin(TWO_PI * 146.83 * t + Math.sin(TWO_PI * 1.5 * t)) * 0.14 +
        Math.sin(TWO_PI * 220.0 * t - Math.sin(TWO_PI * 1.2 * t)) * 0.10
      );
      left[i] = lpL * 0.22 + spectral;
      right[i] = lpR * 0.22 - spectral * 0.8;
    } else if (mode === 'underwater') {
      // Deep muffled sub-aquatic current with bubble modulation
      lpL += 0.012 * (wL - lpL);
      lpR += 0.012 * (wR - lpR);
      const bubble = Math.sin(TWO_PI * (280 + 120 * Math.sin(TWO_PI * 6 * t)) * t) * 0.05;
      left[i] = lpL * 0.45 + bubble;
      right[i] = lpR * 0.45 + bubble;
    } else {
      // Water / River / Ocean / Lava / Slime loops
      const rate = mode === 'river_fast' ? 0.14 : mode === 'ocean' ? 0.07 : mode === 'lava' ? 0.02 : 0.05;
      lpL += rate * (wL - lpL);
      lpR += rate * (wR - lpR);
      const mod = 0.65 + 0.35 * Math.sin(TWO_PI * (t / dur));
      left[i] = lpL * 0.35 * mod;
      right[i] = lpR * 0.35 * mod;
    }
  }

  if (mode === 'porcelain') {
    addNoteStereo(left, right, 0.8, 0.9, midiToFreq(86), 0.12, -0.4, 'celesta');
    addNoteStereo(left, right, 2.4, 0.9, midiToFreq(90), 0.10, 0.4, 'celesta');
  }
  return encodeWav(applyStereoReverbAndLoop(left, right, 0.25, 0.35));
}

// ---------------------------------------------------------------------------
// 4. Mono 3D Spatial SFX Synthesizers (Combat, Spells, Footsteps, Creatures, UI)
// ---------------------------------------------------------------------------

/**
 * Synthesize a mono 16-bit PCM WAV buffer using a generator callback `fn(t, u, i, n)`
 * with a clean 3-tap room reflection tail so every SFX has natural body.
 */
function synthMonoSfx(durSec, generatorFn, roomMix = 0.08, masterGain = 0.28) {
  const n = Math.max(64, Math.floor(durSec * SAMPLE_RATE));
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const u = i / n;
    const fadeIn = Math.min(1.0, i / 44);
    const fadeOut = u > 0.85 ? (1 - u) / 0.15 : 1.0;
    buf[i] = generatorFn(t, u, i, n) * fadeIn * fadeOut;
  }
  if (roomMix > 0) {
    const d1 = Math.floor(0.017 * SAMPLE_RATE);
    const d2 = Math.floor(0.039 * SAMPLE_RATE);
    for (let i = d1; i < n; i++) buf[i] += buf[i - d1] * (roomMix * 0.55);
    for (let i = d2; i < n; i++) buf[i] += buf[i - d2] * (roomMix * 0.30);
  }
  // Peak-normalize if hot, then apply gentle masterGain so simultaneous 3D SFX never clip
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const scale = peak > 0.95 ? (0.95 / peak) * masterGain : masterGain;
  for (let i = 0; i < n; i++) buf[i] *= scale;
  return encodeWav(buf);
}

function synthWeaponSwing(size, isCrit) {
  // Acoustic bandpass-filtered air whoosh + porcelain/brass edge shimmer on crits
  const dur = size === 0 ? 0.14 : size === 1 ? 0.18 : 0.22;
  const fStart = size === 0 ? 920 : size === 1 ? 640 : 420;
  const fEnd = size === 0 ? 280 : size === 1 ? 190 : 120;
  let bp = 0;
  let lp = 0;
  let phase = 0;
  let critPhase = 0;
  return synthMonoSfx(dur, (t, u) => {
    const env = Math.sin(Math.PI * Math.pow(u, 0.72));
    const freq = fStart * Math.pow(fEnd / fStart, u);
    phase += (TWO_PI * (freq * 0.35)) / SAMPLE_RATE;
    critPhase += (TWO_PI * (size === 0 ? 1318.5 : 987.77)) / SAMPLE_RATE;

    // 2-pole state-variable bandpass filter on white noise for natural air whoosh
    const fCoeff = Math.min(0.75, (2 * Math.sin((Math.PI * freq) / SAMPLE_RATE)));
    const qCoeff = 0.28;
    const white = rand();
    const hp = white - lp - qCoeff * bp;
    bp += fCoeff * hp;
    lp += fCoeff * bp;

    const critRing = isCrit ? Math.sin(critPhase) * Math.exp(-t * 20) * 0.18 : 0;
    return (bp * 0.72 + Math.sin(phase) * 0.16) * env + critRing;
  }, 0.06, 0.28);
}

function synthWeaponImpact(surface, isCrit) {
  // Surfaces: flesh, chain, plate, shield_metal, shield_wood, parry_metal, parry_wood, wood, stone, ethereal
  const dur = isCrit ? 0.22 : 0.16;
  let lp = 0;
  let thumpPhase = 0;
  let ricPhase = 0;
  return synthMonoSfx(dur, (t) => {
    const thumpEnv = Math.exp(-t * 32);
    const bodyEnv = Math.exp(-t * 18);
    const thumpFreq = 128 * Math.exp(-t * 22) + 52;
    thumpPhase += (TWO_PI * thumpFreq) / SAMPLE_RATE;
    const thump = Math.sin(thumpPhase) * thumpEnv;
    lp += 0.22 * (rand() - lp);

    if (surface === 'flesh') {
      const crunch = lp * Math.exp(-t * 24) * 0.50;
      const critBurst = isCrit
        ? (Math.sin(TWO_PI * 587.33 * t) * 0.22 + Math.sin(TWO_PI * 880.0 * t) * 0.14) * Math.exp(-t * 18)
        : 0;
      return thump * 0.65 + crunch + critBurst;
    }
    if (surface === 'chain' || surface === 'plate' || surface === 'shield_metal' || surface === 'parry_metal') {
      const baseF = surface === 'parry_metal' ? 1046.5 : surface === 'shield_metal' ? 659.25 : surface === 'plate' ? 783.99 : 880.0;
      const clang = (
        Math.sin(TWO_PI * baseF * t) * 0.38 +
        Math.sin(TWO_PI * baseF * 1.498 * t) * 0.24 +
        Math.sin(TWO_PI * baseF * 2.245 * t) * 0.14 * Math.exp(-t * 22)
      ) * bodyEnv;
      return thump * 0.45 + clang + lp * thumpEnv * 0.22;
    }
    if (surface === 'wood' || surface === 'shield_wood' || surface === 'parry_wood') {
      const knock = (
        Math.sin(TWO_PI * 220 * t) * 0.50 +
        Math.sin(TWO_PI * 440 * t) * 0.22 * Math.exp(-t * 26)
      ) * Math.exp(-t * 20);
      return thump * 0.58 + knock + lp * thumpEnv * 0.28;
    }
    if (surface === 'stone') {
      const ricFreq = 880 * Math.exp(-t * 12) + 290;
      ricPhase += (TWO_PI * ricFreq) / SAMPLE_RATE;
      const ricochet = Math.sin(ricPhase) * Math.exp(-t * 18) * 0.28;
      return thump * 0.52 + lp * Math.exp(-t * 18) * 0.50 + ricochet;
    }
    // ethereal / absorb — Celandia porcelain glass harmonic
    return (Math.sin(TWO_PI * 587.33 * t) * 0.45 + Math.sin(TWO_PI * 880.0 * t) * 0.28) * bodyEnv;
  }, 0.08, 0.30);
}

function synthSheathe(type) {
  // metal_sheathe, metal_unsheathe, wood_sheathe, wood_unsheathe, shield
  const dur = 0.20;
  let lp = 0;
  let slidePhase = 0;
  return synthMonoSfx(dur, (t, u) => {
    const env = Math.min(1, t / 0.012) * Math.exp(-t * 13);
    lp += 0.25 * (rand() - lp);
    if (type.includes('metal')) {
      const fSlide = type.includes('unsheathe') ? 780 + u * 620 : 1280 - u * 520;
      slidePhase += (TWO_PI * fSlide) / SAMPLE_RATE;
      const ring = (Math.sin(slidePhase) * 0.35 + Math.sin(TWO_PI * 1760 * t) * 0.18 * Math.exp(-t * 18)) * env;
      return ring + lp * env * 0.32;
    }
    const fWood = type.includes('unsheathe') ? 280 + u * 120 : 390 - u * 110;
    slidePhase += (TWO_PI * fWood) / SAMPLE_RATE;
    return Math.sin(slidePhase) * env * 0.45 + lp * env * 0.38;
  }, 0.08, 0.26);
}

function synthFootstep(terrain) {
  // dirt, metallic, stone, snow, wood, grass, leaves, sand, soggy, splash
  const dur = terrain === 'splash' ? 0.22 : 0.10;
  let lp = 0;
  let bubblePhase = 0;
  return synthMonoSfx(dur, (t) => {
    const env = Math.exp(-t * (terrain === 'splash' ? 16 : 34));
    lp += (terrain === 'snow' || terrain === 'leaves' ? 0.38 : 0.20) * (rand() - lp);
    const heel = Math.sin(TWO_PI * (terrain === 'wood' ? 145 : terrain === 'stone' ? 185 : 105) * t) * Math.exp(-t * 44);
    if (terrain === 'metallic') {
      return heel * 0.50 + (Math.sin(TWO_PI * 660 * t) * 0.25 + Math.sin(TWO_PI * 990 * t) * 0.12) * env;
    }
    if (terrain === 'splash' || terrain === 'soggy') {
      const bFreq = 320 + 95 * Math.sin(TWO_PI * 18 * t);
      bubblePhase += (TWO_PI * bFreq) / SAMPLE_RATE;
      return lp * env * 0.52 + Math.sin(bubblePhase) * env * 0.28;
    }
    return heel * 0.55 + lp * env * 0.48;
  }, 0.05, 0.24);
}

function synthDeathThud(sizeClass, isWater) {
  // sizeClass: 0=Small, 1=Medium, 2=Large, 3=Giant, 4=Colossal
  const dur = 0.20 + sizeClass * 0.05;
  const baseFreq = Math.max(42, 118 - sizeClass * 16);
  let lp = 0;
  let dropPhase = 0;
  let bubblePhase = 0;
  return synthMonoSfx(dur, (t) => {
    const env = Math.exp(-t * (17 - sizeClass * 1.6));
    lp += (isWater ? 0.30 : 0.14) * (rand() - lp);
    const dFreq = baseFreq * Math.exp(-t * 9) + 36;
    dropPhase += (TWO_PI * dFreq) / SAMPLE_RATE;
    const drop = Math.sin(dropPhase) * env;
    let waterBubble = 0;
    if (isWater) {
      bubblePhase += (TWO_PI * (280 + 90 * Math.sin(TWO_PI * 16 * t))) / SAMPLE_RATE;
      waterBubble = Math.sin(bubblePhase) * env * 0.28;
    }
    return drop * 0.68 + lp * env * 0.38 + waterBubble;
  }, 0.10, 0.28);
}

function synthSpellSound(spellType) {
  // Authentic Celandia — The Elsewhere Tide musical spell cues (ported from soundscape.js):
  // Zero phase discontinuities: multi-note arpeggios sum independent note envelopes, and
  // pitch sweeps integrate phase continuously.
  const isImpact = spellType.includes('Impact') || spellType.includes('Shatter');
  const dur = isImpact ? 0.22 : 0.28;
  let lp = 0;
  let sweepPhase = 0;
  let subPhase = 0;

  // Helper to evaluate a plucked/struck Celandia bell/chime partial at note start `t0`
  const bellNote = (t, t0, freq, decay = 12.0) => {
    const dt = t - t0;
    if (dt < 0) return 0;
    const env = Math.min(1, dt / 0.005) * Math.exp(-dt * decay);
    const p = TWO_PI * freq * dt;
    return (
      Math.sin(p) * 0.62 +
      Math.sin(p * 2.0) * 0.24 * Math.exp(-dt * (decay * 1.4)) +
      Math.sin(p * 3.0) * 0.10 * Math.exp(-dt * (decay * 2.0))
    ) * env;
  };

  return synthMonoSfx(dur, (t) => {
    const env = Math.min(1, t / 0.010) * Math.exp(-t * 11.0);
    lp += 0.18 * (rand() - lp);

    switch (spellType) {
      case 'porcelainCast': {
        // Porcelain Wake celesta arpeggio (D5 -> F#5 -> A5 -> D6)
        return (
          bellNote(t, 0.00, 587.33, 12.0) * 0.45 +
          bellNote(t, 0.03, 739.99, 13.0) * 0.40 +
          bellNote(t, 0.06, 880.00, 14.0) * 0.38 +
          bellNote(t, 0.09, 1174.66, 15.0) * 0.35
        );
      }
      case 'porcelainShatter': {
        // Crisp porcelain chord + soft rose-gold shimmer
        return (
          bellNote(t, 0.00, 880.00, 15.0) * 0.42 +
          bellNote(t, 0.01, 1318.51, 16.0) * 0.32 +
          bellNote(t, 0.02, 1760.00, 18.0) * 0.22 +
          lp * Math.exp(-t * 22.0) * 0.25
        );
      }
      case 'frostbellCast': {
        // Frostbell Lagoon shimmering tubular bell triad (E5 + B5 + F#6)
        const mod = Math.sin(TWO_PI * 1318.51 * t) * 0.55 * Math.exp(-t * 13.0);
        return (
          Math.sin(TWO_PI * 659.25 * t + mod) * 0.48 +
          bellNote(t, 0.03, 987.77, 12.0) * 0.35 +
          bellNote(t, 0.06, 1479.98, 13.5) * 0.25
        ) * env;
      }
      case 'frostbellImpact': {
        // Smoothly integrated frost crystallization chime + gentle low thump
        const fSweep = 320 + 640 * Math.exp(-t * 14.0);
        sweepPhase += (TWO_PI * fSweep) / SAMPLE_RATE;
        return (
          Math.sin(sweepPhase) * 0.42 * Math.exp(-t * 13.0) +
          bellNote(t, 0.00, 987.77, 15.0) * 0.38 +
          lp * Math.exp(-t * 18.0) * 0.24
        );
      }
      case 'aureateCast': {
        // Aureate Reach warm brass & sun-harp fifth (D4 + A4 + F#5)
        return (
          bellNote(t, 0.00, 293.66, 10.5) * 0.45 +
          bellNote(t, 0.03, 440.00, 11.5) * 0.40 +
          bellNote(t, 0.06, 739.99, 12.5) * 0.35
        );
      }
      case 'aureateImpact': {
        // Radiant solar gong strike (G3 + D4 + B4)
        return (
          bellNote(t, 0.00, 196.00, 11.0) * 0.50 +
          bellNote(t, 0.00, 293.66, 12.5) * 0.35 +
          bellNote(t, 0.01, 493.88, 14.0) * 0.25
        );
      }
      case 'bambooCast': {
        // Glasswake Mesas breathy flute + wooden marimba double-stop (integrated phase)
        const fFlute = 523.25 * (1.0 + 0.012 * Math.sin(TWO_PI * 5.5 * t));
        sweepPhase += (TWO_PI * fFlute) / SAMPLE_RATE;
        const marimba = bellNote(t, 0.00, 392.00, 14.0) * 0.45 + bellNote(t, 0.04, 587.33, 15.0) * 0.40;
        return Math.sin(sweepPhase) * 0.38 * env + marimba + lp * env * 0.14;
      }
      case 'bambooImpact': {
        // Warm wooden marimba resonator strike (integrated phase)
        const fWood = 180 + 210 * Math.exp(-t * 16.0);
        sweepPhase += (TWO_PI * fWood) / SAMPLE_RATE;
        return (
          Math.sin(sweepPhase) * 0.55 * Math.exp(-t * 15.0) +
          bellNote(t, 0.00, 587.33, 17.0) * 0.32 +
          lp * Math.exp(-t * 22.0) * 0.22
        );
      }
      case 'shadowCast': {
        // Nocturnum Isle dark fairy cello fifth + obsidian chime (integrated phase)
        const fCello = 220.0 * (1.0 + 0.006 * Math.sin(TWO_PI * 5.0 * t));
        sweepPhase += (TWO_PI * fCello) / SAMPLE_RATE;
        subPhase += (TWO_PI * 146.83) / SAMPLE_RATE;
        return (
          (Math.sin(subPhase) * 0.40 + Math.sin(sweepPhase) * 0.35) * env +
          bellNote(t, 0.03, 659.25, 13.0) * 0.28
        );
      }
      case 'shadowImpact': {
        // Smooth velvet void pulse + twilight chime (integrated phase)
        const fPulse = 78 + 180 * Math.exp(-t * 13.0);
        sweepPhase += (TWO_PI * fPulse) / SAMPLE_RATE;
        return (
          Math.sin(sweepPhase) * 0.55 * Math.exp(-t * 12.0) +
          bellNote(t, 0.00, 440.00, 14.0) * 0.30 +
          lp * Math.exp(-t * 18.0) * 0.20
        );
      }
      case 'healCast':
      case 'healImpact':
      default: {
        // Elsewhere Tide luminous chord (D5 + F#5 + A5 + E6)
        return (
          bellNote(t, 0.00, 587.33, 11.0) * 0.35 +
          bellNote(t, 0.02, 739.99, 12.0) * 0.30 +
          bellNote(t, 0.04, 880.00, 13.0) * 0.25 +
          bellNote(t, 0.06, 1318.51, 14.0) * 0.20
        );
      }
    }
  }, 0.10, 0.26);
}

function synthCreatureVoice(archetype, action) {
  // Ported directly from Celandia's `docs/elsewhere-tide/ui/world/soundscape.js` creature calls:
  // Soft, musical, organic Celandia fauna voices instead of harsh synthetic buzzers.
  const isLong = action === 'death' || action === 'aggro' || action === 'greeting';
  const dur = isLong ? 0.24 : 0.14;
  let phase = 0;
  let phase2 = 0;
  let lp = 0;

  return synthMonoSfx(dur, (t, u) => {
    const env = Math.min(1, t / 0.014) * Math.exp(-t * (isLong ? 10.5 : 16.0));
    lp += 0.16 * (rand() - lp);

    if (archetype === 'hound') {
      // Porcelain Hopper (`hopper-chirp` / `hopper-squeak`): gentle bird-like porcelain whistle
      const f = action === 'death'
        ? 580 * (1 - u * 0.35)
        : (t < 0.06 ? 523.25 : 659.25) * (1 + 0.03 * Math.sin(TWO_PI * 12 * t));
      phase += (TWO_PI * f) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.65 + Math.sin(phase * 2) * 0.18) * env;
    }
    if (archetype === 'stag') {
      // Woolly Drifter (`drifter-low`): warm, low, breathy horn/cello call
      const f = (action === 'death' ? 130 * (1 - u * 0.25) : 146.83 + 18 * Math.sin(Math.PI * u));
      phase += (TWO_PI * f) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.62 + Math.sin(phase * 2) * 0.24 + lp * 0.12) * env;
    }
    if (archetype === 'scorpion') {
      // Glass Skimmer (`skimmer-click`): delicate glass-reed marimba pluck
      const f = action === 'death' ? 440 * (1 - u * 0.3) : 659.25;
      phase += (TWO_PI * f) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.68 + Math.sin(phase * 3.0) * 0.22 * Math.exp(-t * 28)) * Math.exp(-t * 18);
    }
    if (archetype === 'griffin') {
      // Sky Manta (`manta-song`): ethereal ocarina/whale harmonic glide
      const f = (action === 'death' ? 392 * (1 - u * 0.3) : 349.23 + 70 * Math.sin(Math.PI * u));
      phase += (TWO_PI * f) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.70 + Math.sin(phase * 2) * 0.20) * env;
    }
    if (archetype === 'wraith') {
      // Nocturnum Jelly / Wraith (`jelly-chime`): luminescent twilight bell harmonic
      phase += (TWO_PI * 523.25) / SAMPLE_RATE;
      phase2 += (TWO_PI * 783.99) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.52 + Math.sin(phase2) * 0.32) * env;
    }
    if (archetype === 'construct' || archetype === 'boss') {
      // Obsidian Colossus: deep resonant bronze/stone gong pulse
      const f = (archetype === 'boss' ? 82.41 : 98.0) * (action === 'death' ? 1 - u * 0.25 : 1.0);
      phase += (TWO_PI * f) / SAMPLE_RATE;
      phase2 += (TWO_PI * f * 1.5) / SAMPLE_RATE;
      return (Math.sin(phase) * 0.60 + Math.sin(phase2) * 0.28 + lp * 0.15) * env;
    }

    // HeroF / HeroM: warm, subtle breathy cadence
    const baseF = archetype === 'hero_f' ? 293.66 : 164.81;
    const f = baseF * (action === 'death' ? 1 - u * 0.22 : 1.0 + 0.04 * Math.sin(Math.PI * u));
    phase += (TWO_PI * f) / SAMPLE_RATE;
    return (Math.sin(phase) * 0.58 + Math.sin(phase * 2) * 0.22 + lp * 0.14) * env;
  }, 0.08, 0.22);
}

function synthUiSound(kind) {
  // Phase-continuous Celandia UI porcelain & brass chimes
  const dur = kind === 'levelup' || kind === 'quest' ? 0.62 : 0.16;
  let sweepPhase = 0;

  const chime = (t, t0, freq, decay = 9.0) => {
    const dt = t - t0;
    if (dt < 0) return 0;
    const env = Math.min(1, dt / 0.004) * Math.exp(-dt * decay);
    return (Math.sin(TWO_PI * freq * dt) * 0.62 + Math.sin(TWO_PI * freq * 2.0 * dt) * 0.22) * env;
  };

  return synthMonoSfx(dur, (t, u) => {
    if (kind === 'levelup') {
      // Triumphant 4-note Celandia arpeggio (D5 -> F#5 -> A5 -> D6) with natural overlapping ring
      return (
        chime(t, 0.00, 587.33, 6.0) * 0.42 +
        chime(t, 0.08, 739.99, 6.0) * 0.42 +
        chime(t, 0.16, 880.00, 6.0) * 0.42 +
        chime(t, 0.24, 1174.66, 5.0) * 0.48
      );
    }
    if (kind === 'quest') {
      // Warm parchment & brass cadence (A4 -> E5 -> A5)
      return (
        chime(t, 0.00, 440.00, 6.5) * 0.45 +
        chime(t, 0.09, 659.25, 6.5) * 0.45 +
        chime(t, 0.18, 880.00, 5.5) * 0.45
      );
    }
    if (kind === 'coin') {
      // Dual gold coin clink with independent envelopes
      return chime(t, 0.00, 1760.0, 18.0) * 0.50 + chime(t, 0.045, 2349.32, 16.0) * 0.48;
    }
    if (kind === 'repair') {
      return chime(t, 0.00, 1174.66, 12.0) * 0.50 + chime(t, 0.06, 1567.98, 12.0) * 0.45;
    }
    if (kind === 'open') {
      const f = 523.25 + u * 196.0;
      sweepPhase += (TWO_PI * f) / SAMPLE_RATE;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 15.0);
      return (Math.sin(sweepPhase) * 0.58 + Math.sin(sweepPhase * 2) * 0.18) * env;
    }
    if (kind === 'close') {
      const f = 719.25 - u * 196.0;
      sweepPhase += (TWO_PI * f) / SAMPLE_RATE;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 15.0);
      return (Math.sin(sweepPhase) * 0.58 + Math.sin(sweepPhase * 2) * 0.18) * env;
    }
    // Delicate porcelain button tap
    return chime(t, 0.00, 880.0, 22.0) * 0.55;
  }, 0.12, 0.40);
}

// ---------------------------------------------------------------------------
// 5. Main Builder: Audio Files + All 22 Audio DBCs
// ---------------------------------------------------------------------------

export function buildCelandiaAudio(writeFile, WdbcBuilder, f32) {
  // reset deterministic PRNG seed per build
  rngState = 0xCE1A4D1A;

  const writtenFiles = new Set();
  function writeAudio(relPath, buffer) {
    const normalized = relPath.replace(/\\/g, '/');
    writeFile(normalized, buffer);
    writtenFiles.add(normalized.toLowerCase());
  }

  // Try to load real Celandia voice audition WAVs if present on disk
  const rookAuditionDir = '/Users/xmacbookm5/Projects/j3games/Celandia/dubbing/auditions/rook';
  const realVoiceBufs = {};
  for (const name of ['samantha.wav', 'invented-1.wav', 'invented-2.wav']) {
    const full = path.join(rookAuditionDir, name);
    if (fs.existsSync(full)) {
      realVoiceBufs[name] = fs.readFileSync(full);
    }
  }

  // -------------------------------------------------------------------------
  // A. Synthesize 6 Celandia Music Tracks + Glue Screen Theme
  // -------------------------------------------------------------------------
  const musicPorcelain = synthPorcelainWakeMusic();
  const musicFrostbell = synthFrostbellLagoonMusic();
  const musicGlasswake = synthGlasswakeMesasMusic();
  const musicAureate = synthAureateReachMusic();
  const musicNocturnum = synthNocturnumIsleMusic();
  const musicTitle = synthCelandiaTitleTheme();

  writeAudio('Sound/Music/Celandia/PorcelainWakeDay.wav', musicPorcelain);
  writeAudio('Sound/Music/Celandia/FrostbellLagoonDay.wav', musicFrostbell);
  writeAudio('Sound/Music/Celandia/GlasswakeMesasDay.wav', musicGlasswake);
  writeAudio('Sound/Music/Celandia/AureateReachDay.wav', musicAureate);
  writeAudio('Sound/Music/Celandia/NocturnumIsleNight.wav', musicNocturnum);
  writeAudio('Sound/Music/Celandia/CelandiaTitleTheme.wav', musicTitle);
  // GlueScreenMusic path requested by `glue.rs` (decoded via symphonia header sniffing)
  writeAudio('Sound/Music/GlueScreenMusic/wow_main_theme.mp3', musicTitle);

  // -------------------------------------------------------------------------
  // B. Synthesize 5 Kingdom Ambience Loops + Forced Beds + Water/Liquid Loops
  // -------------------------------------------------------------------------
  writeAudio('Sound/Ambience/Celandia/PorcelainWakeAmbience.wav', synthAmbienceLoop('porcelain'));
  writeAudio('Sound/Ambience/Celandia/FrostbellLagoonAmbience.wav', synthAmbienceLoop('frostbell'));
  writeAudio('Sound/Ambience/Celandia/GlasswakeMesasAmbience.wav', synthAmbienceLoop('glasswake'));
  writeAudio('Sound/Ambience/Celandia/AureateReachAmbience.wav', synthAmbienceLoop('aureate'));
  writeAudio('Sound/Ambience/Celandia/NocturnumIsleAmbience.wav', synthAmbienceLoop('nocturnum'));
  writeAudio('Sound/Ambience/Celandia/GhostState.wav', synthAmbienceLoop('ghost'));

  const underwaterWav = synthAmbienceLoop('underwater');
  writeAudio('Sound/Ambience/Water/UndwaterLoop.wav', underwaterWav);
  writeAudio('Sound/Ambience/Water/RiverStill.wav', synthAmbienceLoop('river_still'));
  writeAudio('Sound/Ambience/Water/RiverSlow.wav', synthAmbienceLoop('river_slow'));
  writeAudio('Sound/Ambience/Water/RiverFast.wav', synthAmbienceLoop('river_fast'));
  writeAudio('Sound/Ambience/Water/Ocean.wav', synthAmbienceLoop('ocean'));
  writeAudio('Sound/Ambience/Water/LavaPoolLoop.wav', synthAmbienceLoop('lava'));
  writeAudio('Sound/Ambience/Water/LavaFlowLoop.wav', synthAmbienceLoop('lava'));
  writeAudio('Sound/Ambience/Water/SlimeLoop.wav', synthAmbienceLoop('river_slow'));

  // -------------------------------------------------------------------------
  // C. Synthesize Combat Swings, Impacts, Foley, Sheathe, Footsteps, Death Thud
  // -------------------------------------------------------------------------
  writeAudio('Sound/Item/Weapons/Bow/ArrowSwishc.wav', synthWeaponSwing(0, false));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshSmall1.wav', synthWeaponSwing(0, false));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshSmallCrit.wav', synthWeaponSwing(0, true));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshMedium1.wav', synthWeaponSwing(1, false));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshMediumCrit.wav', synthWeaponSwing(1, true));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshLarge1.wav', synthWeaponSwing(2, false));
  writeAudio('Sound/Item/Weapons/WeaponSwings/mWooshLargeCrit.wav', synthWeaponSwing(2, true));

  writeAudio('Sound/Item/Weapons/Impact/FleshHit.wav', synthWeaponImpact('flesh', false));
  writeAudio('Sound/Item/Weapons/Impact/FleshCrit.wav', synthWeaponImpact('flesh', true));
  writeAudio('Sound/Item/Weapons/Impact/ChainHit.wav', synthWeaponImpact('chain', false));
  writeAudio('Sound/Item/Weapons/Impact/ChainCrit.wav', synthWeaponImpact('chain', true));
  writeAudio('Sound/Item/Weapons/Impact/PlateHit.wav', synthWeaponImpact('plate', false));
  writeAudio('Sound/Item/Weapons/Impact/PlateCrit.wav', synthWeaponImpact('plate', true));
  writeAudio('Sound/Item/Weapons/Impact/AxeFleshHit.wav', synthWeaponImpact('flesh', false));
  writeAudio('Sound/Item/Weapons/Impact/AxeFleshCrit.wav', synthWeaponImpact('flesh', true));
  writeAudio('Sound/Item/Weapons/Impact/ShieldWoodImpact.wav', synthWeaponImpact('shield_wood', false));
  writeAudio('Sound/Item/Weapons/Impact/ShieldMetalImpact.wav', synthWeaponImpact('shield_metal', false));
  writeAudio('Sound/Item/Weapons/Impact/ParryWood.wav', synthWeaponImpact('parry_wood', false));
  writeAudio('Sound/Item/Weapons/Impact/ParryMetal.wav', synthWeaponImpact('parry_metal', false));
  writeAudio('Sound/Item/Weapons/Impact/WoodHit.wav', synthWeaponImpact('wood', false));
  writeAudio('Sound/Item/Weapons/Impact/StoneHit.wav', synthWeaponImpact('stone', false));
  writeAudio('Sound/Item/Weapons/Impact/EtherealHit.wav', synthWeaponImpact('ethereal', false));
  writeAudio('Sound/Item/Weapons/Impact/AbsorbGetHit.wav', synthWeaponImpact('ethereal', false));

  writeAudio('Sound/Item/Weapons/Sheathe/ShieldSheathe.wav', synthSheathe('shield_sheathe'));
  writeAudio('Sound/Item/Weapons/Sheathe/WoodSheathe.wav', synthSheathe('wood_sheathe'));
  writeAudio('Sound/Item/Weapons/Sheathe/MetalSheathe.wav', synthSheathe('metal_sheathe'));
  writeAudio('Sound/Item/Weapons/Sheathe/WoodUnsheathe.wav', synthSheathe('wood_unsheathe'));
  writeAudio('Sound/Item/Weapons/Sheathe/MetalUnsheathe.wav', synthSheathe('metal_unsheathe'));
  writeAudio('Sound/Item/Weapons/Sheathe/ShieldUnsheathe.wav', synthSheathe('shield_unsheathe'));

  // Armor Foley & Item Group Sounds
  writeAudio('Sound/Character/Footsteps/LeatherFoley.wav', synthFootstep('dirt'));
  writeAudio('Sound/Character/Footsteps/PlateFoley.wav', synthFootstep('metallic'));
  writeAudio('Sound/Character/Footsteps/ChainFoley.wav', synthFootstep('metallic'));

  // Footsteps across all terrains
  const terrainFiles = [
    ['FootstepDirt.wav', 'dirt'],
    ['FootstepMetallic.wav', 'metallic'],
    ['FootstepStone.wav', 'stone'],
    ['FootstepSnow.wav', 'snow'],
    ['FootstepWood.wav', 'wood'],
    ['FootstepGrass.wav', 'grass'],
    ['FootstepLeaves.wav', 'leaves'],
    ['FootstepSand.wav', 'sand'],
    ['FootstepSoggy.wav', 'soggy'],
    ['FootstepSplash.wav', 'splash'],
  ];
  for (const [fileName, tKind] of terrainFiles) {
    writeAudio(`Sound/Character/Footsteps/${fileName}`, synthFootstep(tKind));
  }

  // Death Thuds (Small..Colossal + Water)
  for (let sc = 0; sc <= 4; sc++) {
    writeAudio(`Sound/Character/Footsteps/DeathThudSize${sc}.wav`, synthDeathThud(sc, false));
  }
  writeAudio('Sound/Character/Footsteps/DeathThudWater.wav', synthDeathThud(1, true));

  // -------------------------------------------------------------------------
  // D. Synthesize Celandia Spells, Creature Voices, Vocal UI & Interface SFX
  // -------------------------------------------------------------------------
  const spellAudioDefs = [
    ['PorcelainLanceCast.wav', 'porcelainCast'],
    ['PorcelainShatterImpact.wav', 'porcelainShatter'],
    ['FrostbellChimeCast.wav', 'frostbellCast'],
    ['FrostbellFreezeImpact.wav', 'frostbellImpact'],
    ['AureateHornCast.wav', 'aureateCast'],
    ['AureateSmiteImpact.wav', 'aureateImpact'],
    ['BambooWhirlCast.wav', 'bambooCast'],
    ['BambooStrikeImpact.wav', 'bambooImpact'],
    ['ShadowCelloCast.wav', 'shadowCast'],
    ['ShadowPulseImpact.wav', 'shadowImpact'],
    ['HealChoirCast.wav', 'healCast'],
    ['HealSparkleImpact.wav', 'healImpact'],
    ['PrecastLow.wav', 'porcelainCast'],
    ['PrecastMedium.wav', 'frostbellCast'],
    ['PrecastHigh.wav', 'aureateCast'],
    ['SpiritWolfDismount.wav', 'bambooCast'],
  ];
  for (const [fileName, spellType] of spellAudioDefs) {
    writeAudio(`Sound/Spells/${fileName}`, synthSpellSound(spellType));
  }

  // Creature & Hero Voice Files (incorporating real Celandia audition WAVs where appropriate)
  const creatureArchetypes = [
    ['HeroF', 'hero_f'],
    ['HeroM', 'hero_m'],
    ['PorcelainHound', 'hound'],
    ['FrostbellStag', 'stag'],
    ['GlasswakeScorpion', 'scorpion'],
    ['AureateGriffin', 'griffin'],
    ['NocturnumWraith', 'wraith'],
    ['Construct', 'construct'],
    ['Boss', 'boss'],
  ];
  const creatureActions = ['Attack', 'Wound', 'WoundCrit', 'Death', 'Aggro', 'Fidget', 'Greeting', 'Farewell', 'Pissed'];
  for (const [prefix, arch] of creatureArchetypes) {
    for (const act of creatureActions) {
      const buf = synthCreatureVoice(arch, act.toLowerCase());
      writeAudio(`Sound/Creature/Celandia/${prefix}_${act}.wav`, buf);
    }
  }

  // UI & Glue & Money & Item SFX
  writeAudio('Sound/Interface/uEscapeScreenOpen.wav', synthUiSound('open'));
  writeAudio('Sound/Interface/uEscapeScreenClose.wav', synthUiSound('close'));
  writeAudio('Sound/Interface/uiClick.wav', synthUiSound('click'));
  writeAudio('Sound/Interface/uiLevelUp.wav', synthUiSound('levelup'));
  writeAudio('Sound/Interface/uiQuestComplete.wav', synthUiSound('quest'));
  writeAudio('Sound/Interface/uiCoinLoot.wav', synthUiSound('coin'));
  writeAudio('Sound/Interface/uiItemRepair.wav', synthUiSound('repair'));

  // -------------------------------------------------------------------------
  // E. Build SoundEntries.dbc (29 columns, stringCols: [2, 3..12, 23])
  // -------------------------------------------------------------------------
  const soundEntriesStringCols = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23];
  const soundEntriesDbc = new WdbcBuilder(29, soundEntriesStringCols);
  const addedSoundEntryIds = new Set();

  function addSoundEntry(id, soundType, name, dirBase, fileName, volume = 0.65, flags = 0, minDist = 8.0, maxDist = 45.0, eaxDef = 0) {
    if (addedSoundEntryIds.has(id)) return id;
    addedSoundEntryIds.add(id);

    const fullRel = `${dirBase.replace(/\\/g, '/')}/${fileName}`;
    if (!writtenFiles.has(fullRel.toLowerCase())) {
      writeAudio(fullRel, synthUiSound('click'));
    }

    // Rule enforced by `sound_entries.rs`: NPC vocal kits (SoundType == 17) must have EAXDef == 0
    const safeEax = soundType === 17 ? 0 : eaxDef;

    soundEntriesDbc.addRow([
      id,
      soundType,
      name,
      fileName, '', '', '', '', '', '', '', '', '',
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      dirBase,
      f32(volume),
      flags,
      f32(minDist),
      f32(maxDist),
      safeEax,
    ]);
    return id;
  }

  // 1. Zone Music kits (SoundType = 28)
  addSoundEntry(6001, 28, 'Zone-PorcelainWakeDay', 'Sound\\Music\\Celandia', 'PorcelainWakeDay.wav', 0.42);
  addSoundEntry(6002, 28, 'Zone-FrostbellLagoonDay', 'Sound\\Music\\Celandia', 'FrostbellLagoonDay.wav', 0.42);
  addSoundEntry(6003, 28, 'Zone-GlasswakeMesasDay', 'Sound\\Music\\Celandia', 'GlasswakeMesasDay.wav', 0.42);
  addSoundEntry(6004, 28, 'Zone-AureateReachDay', 'Sound\\Music\\Celandia', 'AureateReachDay.wav', 0.42);
  addSoundEntry(6005, 28, 'Zone-NocturnumIsleNight', 'Sound\\Music\\Celandia', 'NocturnumIsleNight.wav', 0.42);
  addSoundEntry(6006, 28, 'Zone-CelandiaTitleTheme', 'Sound\\Music\\Celandia', 'CelandiaTitleTheme.wav', 0.46);
  addSoundEntry(2523, 28, 'Zone-DayForest', 'Sound\\Music\\Celandia', 'PorcelainWakeDay.wav', 0.42);

  // 2. Zone Ambience & Forced Bed kits (SoundType = 14)
  addSoundEntry(6101, 14, 'Ambience-PorcelainWake', 'Sound\\Ambience\\Celandia', 'PorcelainWakeAmbience.wav', 0.28);
  addSoundEntry(6102, 14, 'Ambience-FrostbellLagoon', 'Sound\\Ambience\\Celandia', 'FrostbellLagoonAmbience.wav', 0.28);
  addSoundEntry(6103, 14, 'Ambience-GlasswakeMesas', 'Sound\\Ambience\\Celandia', 'GlasswakeMesasAmbience.wav', 0.28);
  addSoundEntry(6104, 14, 'Ambience-AureateReach', 'Sound\\Ambience\\Celandia', 'AureateReachAmbience.wav', 0.28);
  addSoundEntry(6105, 14, 'Ambience-NocturnumIsle', 'Sound\\Ambience\\Celandia', 'NocturnumIsleAmbience.wav', 0.28);
  addSoundEntry(4160, 14, 'Ghost (DONOTRENAME)', 'Sound\\Ambience\\Celandia', 'GhostState.wav', 0.35);
  addSoundEntry(4209, 14, 'Underwater (DONOTRENAME)', 'Sound\\Ambience\\Water', 'UndwaterLoop.wav', 0.35);
  addSoundEntry(4123, 14, 'UnderWaterLoop', 'Sound\\Ambience\\Water', 'UndwaterLoop.wav', 0.35);

  // 3. Water / Liquid Loops & Splash (SoundWaterType.dbc + water.rs)
  addSoundEntry(1096, 1, 'CharacterSplashSoundMedium', 'Sound\\Character\\Footsteps', 'FootstepSplash.wav', 0.65);
  addSoundEntry(1111, 14, 'RiverStill', 'Sound\\Ambience\\Water', 'RiverStill.wav', 0.50);
  addSoundEntry(1112, 14, 'RiverSlow', 'Sound\\Ambience\\Water', 'RiverSlow.wav', 0.55);
  addSoundEntry(1113, 14, 'RiverFast', 'Sound\\Ambience\\Water', 'RiverFast.wav', 0.60);
  addSoundEntry(1114, 14, 'Ocean', 'Sound\\Ambience\\Water', 'Ocean.wav', 0.60);
  addSoundEntry(3072, 14, 'LavaPoolLoop', 'Sound\\Ambience\\Water', 'LavaPoolLoop.wav', 0.55);
  addSoundEntry(3052, 14, 'LavaFlowLoop', 'Sound\\Ambience\\Water', 'LavaFlowLoop.wav', 0.60);
  addSoundEntry(3880, 14, 'SlimeLoop', 'Sound\\Ambience\\Water', 'SlimeLoop.wav', 0.50);

  // 4. Weapon Swings & Combat Stubs (`combat.rs`, `weapon_swing.rs`, `sound_entries.rs`)
  // Note: ID 1 must keep volume 0.60 and flags 0x200 for `sound_entries.rs` unit test!
  addSoundEntry(1, 1, 'ArrowSwish', 'Sound\\Item\\Weapons\\Bow', 'ArrowSwishc.wav', 0.60, 0x200);
  addSoundEntry(233, 4, 'WeaponSwingLight', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshSmall1.wav', 0.58);
  addSoundEntry(234, 4, 'WeaponSwingLightCrit', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshSmallCrit.wav', 0.65);
  addSoundEntry(235, 4, 'WeaponSwingMedium', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshMedium1.wav', 0.60);
  addSoundEntry(236, 4, 'WeaponSwingMediumCrit', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshMediumCrit.wav', 0.68);
  addSoundEntry(237, 4, 'WeaponSwingHeavy', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshLarge1.wav', 0.64);
  addSoundEntry(238, 4, 'WeaponSwingHeavyCrit', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshLargeCrit.wav', 0.70);
  addSoundEntry(7080, 4, '(DONOTRENAME)Combat Miss 1H', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshMedium1.wav', 0.55);
  addSoundEntry(7081, 4, '(DONOTRENAME)Combat Miss 2H', 'Sound\\Item\\Weapons\\WeaponSwings', 'mWooshLarge1.wav', 0.58);

  // 5. Weapon Impacts & Shield Blocks & Parries (`weapon_impact.rs`, `combat.rs`)
  addSoundEntry(143, 4, 'Sword1HFleshHit', 'Sound\\Item\\Weapons\\Impact', 'FleshHit.wav', 0.62);
  addSoundEntry(144, 4, 'Sword1HFleshCrit', 'Sound\\Item\\Weapons\\Impact', 'FleshCrit.wav', 0.70);
  addSoundEntry(145, 4, 'Sword1HChainHit', 'Sound\\Item\\Weapons\\Impact', 'ChainHit.wav', 0.62);
  addSoundEntry(146, 4, 'Sword1HChainCrit', 'Sound\\Item\\Weapons\\Impact', 'ChainCrit.wav', 0.70);
  addSoundEntry(147, 4, 'Sword1HPlateHit', 'Sound\\Item\\Weapons\\Impact', 'PlateHit.wav', 0.62);
  addSoundEntry(148, 4, 'Sword1HPlateCrit', 'Sound\\Item\\Weapons\\Impact', 'PlateCrit.wav', 0.70);
  addSoundEntry(171, 4, 'Axe1HFleshHit', 'Sound\\Item\\Weapons\\Impact', 'AxeFleshHit.wav', 0.62);
  addSoundEntry(172, 4, 'Axe1HFleshCrit', 'Sound\\Item\\Weapons\\Impact', 'AxeFleshCrit.wav', 0.70);
  addSoundEntry(1001, 4, 'ParryWood', 'Sound\\Item\\Weapons\\Impact', 'ParryWood.wav', 0.66);
  addSoundEntry(1002, 4, 'ParryMetal', 'Sound\\Item\\Weapons\\Impact', 'ParryMetal.wav', 0.68);
  addSoundEntry(3205, 4, 'WeaponHitWood', 'Sound\\Item\\Weapons\\Impact', 'WoodHit.wav', 0.62);
  addSoundEntry(3206, 4, 'WeaponHitStone', 'Sound\\Item\\Weapons\\Impact', 'StoneHit.wav', 0.62);
  addSoundEntry(3207, 4, 'WeaponHitEthereal', 'Sound\\Item\\Weapons\\Impact', 'EtherealHit.wav', 0.62);
  addSoundEntry(3262, 4, '(DONOTRENAME)ShieldWoodImpact', 'Sound\\Item\\Weapons\\Impact', 'ShieldWoodImpact.wav', 0.66);
  addSoundEntry(3263, 4, 'ShieldMetalImpact', 'Sound\\Item\\Weapons\\Impact', 'ShieldMetalImpact.wav', 0.68);
  addSoundEntry(3334, 4, '(DONOTRENAME)AbsorbGetHit', 'Sound\\Item\\Weapons\\Impact', 'AbsorbGetHit.wav', 0.62);

  // 6. Armor Foley (`material.rs`) & Sheathe (`sheathe.rs`)
  addSoundEntry(1003, 1, 'FoleyLeather', 'Sound\\Character\\Footsteps', 'LeatherFoley.wav', 0.48);
  addSoundEntry(1004, 1, 'FoleyPlate', 'Sound\\Character\\Footsteps', 'PlateFoley.wav', 0.52);
  addSoundEntry(1005, 1, 'FoleyChain', 'Sound\\Character\\Footsteps', 'ChainFoley.wav', 0.52);
  addSoundEntry(696, 1, 'SheatheShield', 'Sound\\Item\\Weapons\\Sheathe', 'ShieldSheathe.wav', 0.58);
  addSoundEntry(697, 1, 'SheatheWood', 'Sound\\Item\\Weapons\\Sheathe', 'WoodSheathe.wav', 0.58);
  addSoundEntry(698, 1, 'SheatheMetal', 'Sound\\Item\\Weapons\\Sheathe', 'MetalSheathe.wav', 0.60);
  addSoundEntry(699, 1, 'UnsheatheWood', 'Sound\\Item\\Weapons\\Sheathe', 'WoodUnsheathe.wav', 0.58);
  addSoundEntry(700, 1, 'UnsheatheMetal', 'Sound\\Item\\Weapons\\Sheathe', 'MetalUnsheathe.wav', 0.60);
  addSoundEntry(701, 1, 'UnsheatheShield', 'Sound\\Item\\Weapons\\Sheathe', 'ShieldUnsheathe.wav', 0.58);

  // 7. Footsteps (`footsteps.rs`) & Death Thuds (`death_thud.rs`)
  addSoundEntry(560, 19, 'FootstepDirt', 'Sound\\Character\\Footsteps', 'FootstepDirt.wav', 0.50);
  addSoundEntry(561, 19, 'FootstepMetallic', 'Sound\\Character\\Footsteps', 'FootstepMetallic.wav', 0.54);
  addSoundEntry(562, 19, 'FootstepGrass', 'Sound\\Character\\Footsteps', 'FootstepGrass.wav', 0.48);
  addSoundEntry(563, 19, 'FootstepStone', 'Sound\\Character\\Footsteps', 'FootstepStone.wav', 0.54);
  addSoundEntry(564, 19, 'FootstepSnow', 'Sound\\Character\\Footsteps', 'FootstepSnow.wav', 0.50);
  addSoundEntry(565, 19, 'FootstepWood', 'Sound\\Character\\Footsteps', 'FootstepWood.wav', 0.54);
  addSoundEntry(566, 19, 'FootstepLeaves', 'Sound\\Character\\Footsteps', 'FootstepLeaves.wav', 0.48);
  addSoundEntry(567, 19, 'FootstepSand', 'Sound\\Character\\Footsteps', 'FootstepSand.wav', 0.48);
  addSoundEntry(568, 19, 'FootstepSoggy', 'Sound\\Character\\Footsteps', 'FootstepSoggy.wav', 0.54);
  addSoundEntry(650, 19, 'FootstepHeavyMetallic', 'Sound\\Character\\Footsteps', 'FootstepMetallic.wav', 0.58);
  addSoundEntry(1062, 19, 'FootstepWaterSplash', 'Sound\\Character\\Footsteps', 'FootstepSplash.wav', 0.56);
  addSoundEntry(1063, 19, 'FootstepHeavySplash', 'Sound\\Character\\Footsteps', 'FootstepSplash.wav', 0.60);

  addSoundEntry(907, 1, 'DeathThudSmallDirt', 'Sound\\Character\\Footsteps', 'DeathThudSize0.wav', 0.58);
  addSoundEntry(908, 1, 'DeathThudSmallGrass', 'Sound\\Character\\Footsteps', 'DeathThudSize0.wav', 0.58);
  addSoundEntry(910, 1, 'DeathThudSmallStone', 'Sound\\Character\\Footsteps', 'DeathThudSize0.wav', 0.60);
  addSoundEntry(915, 1, 'DeathThudMedium', 'Sound\\Character\\Footsteps', 'DeathThudSize1.wav', 0.62);
  addSoundEntry(920, 1, 'DeathThudLarge', 'Sound\\Character\\Footsteps', 'DeathThudSize2.wav', 0.65);
  addSoundEntry(926, 1, 'DeathThudGiantWood', 'Sound\\Character\\Footsteps', 'DeathThudSize3.wav', 0.68);
  addSoundEntry(928, 1, 'DeathThudColossalGrass', 'Sound\\Character\\Footsteps', 'DeathThudSize4.wav', 0.72);
  addSoundEntry(1266, 1, 'DeathThudWaterSmall', 'Sound\\Character\\Footsteps', 'DeathThudWater.wav', 0.60);
  addSoundEntry(1267, 1, 'DeathThudWaterMedium', 'Sound\\Character\\Footsteps', 'DeathThudWater.wav', 0.62);
  addSoundEntry(1268, 1, 'DeathThudWaterGiant', 'Sound\\Character\\Footsteps', 'DeathThudWater.wav', 0.68);
  addSoundEntry(1269, 1, 'DeathThudWaterColossal', 'Sound\\Character\\Footsteps', 'DeathThudWater.wav', 0.72);

  // 8. Spell Sound Kits (`spell.rs`, `SpellVisualKit.dbc`, `mount.rs`)
  // Register both 5001..5015 AND 6201..6215 (referenced by SpellVisualKit.dbc!)
  const spellKitPairs = [
    [5001, 6201, 'Celandia_PorcelainLanceCast', 'PorcelainLanceCast.wav', 0.42],
    [5002, 6202, 'Celandia_PorcelainShatterImpact', 'PorcelainShatterImpact.wav', 0.44],
    [5003, 6203, 'Celandia_FrostbellChimeCast', 'FrostbellChimeCast.wav', 0.42],
    [5004, 6204, 'Celandia_FrostbellFreezeImpact', 'FrostbellFreezeImpact.wav', 0.44],
    [5005, 6205, 'Celandia_BambooWhirlCast', 'BambooWhirlCast.wav', 0.42],
    [5006, 6206, 'Celandia_BambooStrikeImpact', 'BambooStrikeImpact.wav', 0.44],
    [5007, 6207, 'Celandia_AureateHornCast', 'AureateHornCast.wav', 0.42],
    [5008, 6208, 'Celandia_AureateSmiteImpact', 'AureateSmiteImpact.wav', 0.44],
    [5009, 6209, 'Celandia_ShadowCelloCast', 'ShadowCelloCast.wav', 0.42],
    [5010, 6210, 'Celandia_ShadowPulseImpact', 'ShadowPulseImpact.wav', 0.44],
    [5011, 6211, 'Celandia_HealChoirCast', 'HealChoirCast.wav', 0.42],
    [5012, 6212, 'Celandia_HealSparkleImpact', 'HealSparkleImpact.wav', 0.44],
    [5013, 6213, 'PrecastFrostLow', 'PrecastLow.wav', 0.36],
    [5014, 6214, 'PrecastFrostMedium', 'PrecastMedium.wav', 0.38],
    [5015, 6215, 'PrecastFrostHigh', 'PrecastHigh.wav', 0.40],
  ];
  for (const [id5k, id6k, name, wav, vol] of spellKitPairs) {
    addSoundEntry(id5k, 2, name, 'Sound\\Spells', wav, vol);
    addSoundEntry(id6k, 2, `${name}_Kit`, 'Sound\\Spells', wav, vol);
  }
  const spellSoundIds = {
    casts: [6201, 6203, 6205, 6207, 6209, 6211],
    impacts: [6202, 6204, 6206, 6208, 6210, 6212],
  };

  // Classic spell & mount kits referenced by `spell.rs` and `mount.rs`
  addSoundEntry(25, 2, 'PrecastFrostLow_Classic', 'Sound\\Spells', 'PrecastLow.wav', 0.56);
  addSoundEntry(2224, 2, 'FrostBoltLaunch', 'Sound\\Spells', 'FrostbellChimeCast.wav', 0.62);
  addSoundEntry(3185, 2, 'FrostBoltImpact', 'Sound\\Spells', 'FrostbellFreezeImpact.wav', 0.65);
  addSoundEntry(3335, 2, 'SpiritWolf (DONOTRENAME)', 'Sound\\Spells', 'SpiritWolfDismount.wav', 0.62);

  // 9. UI, Glue, Money & ItemGroupSounds Kits
  addSoundEntry(823, 3, 'igMiniMapZoomIn', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(841, 3, 'GAMEOBJECT_DOOROPEN', 'Sound\\Interface', 'uEscapeScreenOpen.wav', 0.62);
  addSoundEntry(850, 3, 'igMainMenuOpen', 'Sound\\Interface', 'uEscapeScreenOpen.wav', 0.62);
  addSoundEntry(851, 3, 'igMainMenuClose', 'Sound\\Interface', 'uEscapeScreenClose.wav', 0.62);
  addSoundEntry(852, 3, 'igMainMenuOption', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(853, 3, 'igMainMenuLogout', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(854, 3, 'igMainMenuQuit', 'Sound\\Interface', 'uEscapeScreenClose.wav', 0.62);
  addSoundEntry(855, 3, 'igMainMenuContinue', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(856, 3, 'igMainMenuOptionCheckBoxOn', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(857, 3, 'igMainMenuOptionCheckBoxOff', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(888, 3, 'LEVELUP', 'Sound\\Interface', 'uiLevelUp.wav', 0.70);
  addSoundEntry(895, 3, 'LOOTWINDOWCOINSOUND', 'Sound\\Interface', 'uiCoinLoot.wav', 0.66);
  addSoundEntry(896, 3, 'LootCoinSmall', 'Sound\\Interface', 'uiCoinLoot.wav', 0.62);
  addSoundEntry(902, 3, 'igAbiliityPageTurn', 'Sound\\Interface', 'uiClick.wav', 0.62);
  addSoundEntry(903, 3, 'igAbilityIconDrop', 'Sound\\Interface', 'uiClick.wav', 0.62);
  // Note: ID 7994 must keep volume 0.90 and flags 0x20 for `sound_entries.rs` unit test!
  addSoundEntry(7994, 3, 'ITEM_REPAIR', 'Sound\\Interface', 'uiItemRepair.wav', 0.90, 0x20);

  // ItemGroupSounds.dbc kit IDs (`item_sounds.rs` tests check group 1 -> [273, 274, 275, 0] and group 7 -> [1185, 1202, 0, 0])
  addSoundEntry(273, 1, 'ItemRingPickUp', 'Sound\\Interface', 'uiCoinLoot.wav', 0.60);
  addSoundEntry(274, 1, 'ItemRingPutDown', 'Sound\\Interface', 'uiCoinLoot.wav', 0.60);
  addSoundEntry(275, 1, 'ItemRingUse', 'Sound\\Interface', 'uiCoinLoot.wav', 0.60);
  addSoundEntry(1185, 1, 'ItemShieldPickUp', 'Sound\\Item\\Weapons\\Sheathe', 'ShieldUnsheathe.wav', 0.60);
  addSoundEntry(1202, 1, 'ItemShieldPutDown', 'Sound\\Item\\Weapons\\Sheathe', 'ShieldSheathe.wav', 0.60);

  const namedUiKits = [
    ['gsTitleEnterWorld', 'uiQuestComplete.wav'],
    ['gsTitleOptionOK', 'uiClick.wav'],
    ['gsTitleOptionExit', 'uEscapeScreenClose.wav'],
    ['gsTitleQuit', 'uEscapeScreenClose.wav'],
    ['gsLogin', 'uiClick.wav'],
    ['gsLoginNewAccount', 'uiClick.wav'],
    ['gsLoginChangeRealmOK', 'uiClick.wav'],
    ['gsLoginChangeRealmCancel', 'uEscapeScreenClose.wav'],
    ['gsCharacterSelectionEnterWorld', 'uiQuestComplete.wav'],
    ['gsCharacterSelectionDelCharacter', 'uEscapeScreenClose.wav'],
    ['gsCharacterSelectionAcctOptions', 'uiClick.wav'],
    ['gsCharacterSelectionExit', 'uEscapeScreenClose.wav'],
    ['gsCharacterSelectionCreateNew', 'uEscapeScreenOpen.wav'],
    ['gsCharacterCreationClass', 'uiClick.wav'],
    ['gsCharacterCreationLook', 'uiClick.wav'],
    ['gsCharacterCreationCreateChar', 'uiQuestComplete.wav'],
    ['gsCharacterCreationCancel', 'uEscapeScreenClose.wav'],
    ['igQuestListOpen', 'uEscapeScreenOpen.wav'],
    ['igQuestListClose', 'uEscapeScreenClose.wav'],
    ['igQuestLogOpen', 'uEscapeScreenOpen.wav'],
    ['igQuestLogClose', 'uEscapeScreenClose.wav'],
    ['igQuestLogAbandonQuest', 'uEscapeScreenClose.wav'],
    ['WriteQuest', 'uiQuestComplete.wav'],
    ['igCharacterInfoOpen', 'uEscapeScreenOpen.wav'],
    ['igCharacterInfoClose', 'uEscapeScreenClose.wav'],
    ['igInventoryRotateCharacter', 'uiClick.wav'],
    ['igBackPackOpen', 'uEscapeScreenOpen.wav'],
    ['igBackPackClose', 'uEscapeScreenClose.wav'],
    ['KeyRingOpen', 'uEscapeScreenOpen.wav'],
    ['KeyRingClose', 'uEscapeScreenClose.wav'],
    ['BAGMENUBUTTONPRESS', 'uiClick.wav'],
    ['igSpellBookOpen', 'uEscapeScreenOpen.wav'],
    ['igSpellBookClose', 'uEscapeScreenClose.wav'],
    ['igAbilityOpen', 'uEscapeScreenOpen.wav'],
    ['igAbilityClose', 'uEscapeScreenClose.wav'],
    ['igBonusBarOpen', 'uEscapeScreenOpen.wav'],
    ['UChatScrollButton', 'uiClick.wav'],
    ['LOOTWINDOWOPENEMPTY', 'uEscapeScreenOpen.wav'],
    ['FISHING REEL IN', 'uiClick.wav'],
    ['igCreatureNeutralSelect', 'uiClick.wav'],
    ['igCreatureAggroSelect', 'uiClick.wav'],
    ['INTERFACESOUND_LOSTTARGETUNIT', 'uEscapeScreenClose.wav'],
    ['igPVPUpdate', 'uiQuestComplete.wav'],
    ['igPlayerInvite', 'uiQuestComplete.wav'],
    ['TellMessage', 'uiClick.wav'],
    ['MapPing', 'uiClick.wav'],
    ['TutorialPopup', 'uiQuestComplete.wav'],
  ];
  let nextUiKitId = 8000;
  for (const [kitName, wavName] of namedUiKits) {
    addSoundEntry(nextUiKitId++, 3, kitName, 'Sound\\Interface', wavName, 0.62);
  }

  // 10. Creature Voice Kits + NPC Greeting Kits + Vocal UI Kits
  // Register per-archetype SoundEntries so CreatureSoundData, NPCSounds, and VocalUISounds resolve cleanly
  const archetypeBaseId = {};
  let nextCreatureEntryId = 7000;
  for (const [prefix] of creatureArchetypes) {
    const base = nextCreatureEntryId;
    archetypeBaseId[prefix] = base;
    for (let a = 0; a < creatureActions.length; a++) {
      const act = creatureActions[a];
      // Greeting/Farewell/Pissed use SoundType 17 (NPC vocal, EAXDef=0)
      const st = a >= 6 ? 17 : 10;
      addSoundEntry(base + a, st, `Celandia_${prefix}_${act}`, 'Sound\\Creature\\Celandia', `${prefix}_${act}.wav`, 0.42, 0, 8.0, 45.0, 0);
    }
    nextCreatureEntryId += 20;
  }

  // Classic unit test IDs for CreatureSoundData (`creature_sound.rs` & `creature.rs`) and NPCSounds (`npc_greeting.rs`)
  addSoundEntry(384, 10, 'WolfExertion', 'Sound\\Creature\\Celandia', 'PorcelainHound_Attack.wav', 0.85);
  addSoundEntry(385, 10, 'WolfWound', 'Sound\\Creature\\Celandia', 'PorcelainHound_Wound.wav', 0.85);
  addSoundEntry(386, 10, 'WolfWoundCrit', 'Sound\\Creature\\Celandia', 'PorcelainHound_WoundCrit.wav', 0.90);
  addSoundEntry(387, 10, 'WolfDeath', 'Sound\\Creature\\Celandia', 'PorcelainHound_Death.wav', 0.90);
  addSoundEntry(388, 10, 'WolfAggro', 'Sound\\Creature\\Celandia', 'PorcelainHound_Aggro.wav', 0.90);
  addSoundEntry(389, 10, 'WolfFidget', 'Sound\\Creature\\Celandia', 'PorcelainHound_Fidget.wav', 0.80);
  addSoundEntry(412, 10, 'MurlocAggro', 'Sound\\Creature\\Celandia', 'GlasswakeScorpion_Aggro.wav', 0.90);
  addSoundEntry(5881, 17, 'HumanMaleStandardGreetings', 'Sound\\Creature\\Celandia', 'HeroM_Greeting.wav', 0.90, 0, 8.0, 45.0, 0);
  addSoundEntry(5880, 17, 'HumanMaleStandardFarewells', 'Sound\\Creature\\Celandia', 'HeroM_Farewell.wav', 0.90, 0, 8.0, 45.0, 0);
  addSoundEntry(5922, 17, 'HumanMaleStandardPissed', 'Sound\\Creature\\Celandia', 'HeroM_Pissed.wav', 0.90, 0, 8.0, 45.0, 0);
  addSoundEntry(1942, 20, 'VocalUI_Male', 'Sound\\Creature\\Celandia', 'HeroM_Wound.wav', 0.85);
  addSoundEntry(2066, 20, 'VocalUI_Female', 'Sound\\Creature\\Celandia', 'HeroF_Wound.wav', 0.85);

  writeFile('DBFilesClient/SoundEntries.dbc', soundEntriesDbc.build());

  // -------------------------------------------------------------------------
  // F. Build ZoneMusic.dbc (8 cols, stringCol: [1]) & ZoneIntroMusicTable.dbc (5 cols, stringCol: [1])
  // -------------------------------------------------------------------------
  const zoneMusicDbc = new WdbcBuilder(8, [1]);
  const zoneMusicRows = [
    [101, 'Celandia-PorcelainWake', 60000, 90000, 120000, 180000, 6001, 6001],
    [102, 'Celandia-FrostbellLagoon', 60000, 90000, 120000, 180000, 6002, 6002],
    [103, 'Celandia-GlasswakeMesas', 60000, 90000, 120000, 180000, 6003, 6003],
    [104, 'Celandia-AureateReach', 60000, 90000, 120000, 180000, 6004, 6004],
    [105, 'Celandia-NocturnumIsle', 60000, 90000, 120000, 180000, 6005, 6005],
    [106, 'Celandia-TitleOverture', 60000, 90000, 120000, 180000, 6006, 6006],
    [60, 'Zone-Forest', 60000, 120000, 180000, 180000, 2523, 6005],
  ];
  for (const row of zoneMusicRows) zoneMusicDbc.addRow(row);
  writeFile('DBFilesClient/ZoneMusic.dbc', zoneMusicDbc.build());

  const zoneIntroMusicDbc = new WdbcBuilder(5, [1]);
  const zoneIntroRows = [
    [1, 'Intro-PorcelainWake', 6001, 1, 10],
    [2, 'Intro-FrostbellLagoon', 6002, 1, 10],
    [3, 'Intro-GlasswakeMesas', 6003, 1, 10],
    [4, 'Intro-AureateReach', 6004, 1, 10],
    [5, 'Intro-NocturnumIsle', 6005, 1, 10],
  ];
  for (const row of zoneIntroRows) zoneIntroMusicDbc.addRow(row);
  writeFile('DBFilesClient/ZoneIntroMusicTable.dbc', zoneIntroMusicDbc.build());

  // -------------------------------------------------------------------------
  // G. Build SoundAmbience.dbc (3 cols: ID, AmbienceDay, AmbienceNight)
  // -------------------------------------------------------------------------
  const soundAmbienceDbc = new WdbcBuilder(3, []);
  const ambienceRows = [
    [101, 6101, 6101],
    [102, 6102, 6102],
    [103, 6103, 6103],
    [104, 6104, 6104],
    [105, 6105, 6105],
  ];
  for (const row of ambienceRows) soundAmbienceDbc.addRow(row);
  writeFile('DBFilesClient/SoundAmbience.dbc', soundAmbienceDbc.build());

  // -------------------------------------------------------------------------
  // H. Build ItemSubClass.dbc (28 cols) & ItemSubClassMask.dbc (11 cols)
  // -------------------------------------------------------------------------
  // Schema:
  //   0: Class, 1: SubClass, 2: PrereqProf (i32), 3: PostreqProf (i32),
  //   4: Flags, 5: DisplayFlags, 6: WeaponParrySeq, 7: WeaponReadySeq,
  //   8: WeaponAttackSeq, 9: WeaponSwingSize, 10..17: DisplayName0..7,
  //   18: DisplayNameFlags, 19..26: VerboseName0..7, 27: VerboseNameFlags
  const itemSubClassDbc = new WdbcBuilder(28, [10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26]);
  function addItemSubClass(cls, sub, prereq, postreq, dispFlags, swingSize, displayName, verboseName = '') {
    itemSubClassDbc.addRow([
      cls,
      sub,
      prereq >>> 0,
      postreq >>> 0,
      0,
      dispFlags,
      0,
      0,
      0,
      swingSize,
      displayName, '', '', '', '', '', '', '',
      0x007f0000,
      verboseName, '', '', '', '', '', '', '',
      0x007f0000,
    ]);
  }

  // Class 0: Consumable
  addItemSubClass(0, 0, -1, -1, 0, 0, 'Consumable', '');
  // Class 2: Weapon (Note: 13 Fist Weapon placed before 15 Dagger so bitmask order matches unit tests)
  addItemSubClass(2, 0, -1, -1, 0, 1, 'Axe', 'One-Handed Axes');
  addItemSubClass(2, 1, 0, -1, 0, 2, 'Axe', 'Two-Handed Axes');
  addItemSubClass(2, 2, -1, -1, 0, 1, 'Bow', 'Bows');
  addItemSubClass(2, 3, -1, -1, 0, 1, 'Gun', 'Guns');
  addItemSubClass(2, 4, -1, 5, 0, 1, 'Mace', 'One-Handed Maces');
  addItemSubClass(2, 5, -1, -1, 0, 2, 'Mace', 'Two-Handed Maces');
  addItemSubClass(2, 6, -1, -1, 0, 2, 'Polearm', 'Polearms');
  addItemSubClass(2, 7, -1, -1, 0, 1, 'Sword', 'One-Handed Swords');
  addItemSubClass(2, 8, 7, -1, 0, 2, 'Sword', 'Two-Handed Swords');
  addItemSubClass(2, 9, -1, -1, 0, 1, 'Obsolete', '');
  addItemSubClass(2, 10, -1, -1, 0, 2, 'Staff', 'Staves');
  addItemSubClass(2, 11, -1, -1, 0, 1, 'Exotic', 'One-Handed Exotics');
  addItemSubClass(2, 12, -1, -1, 0, 2, 'Exotic', 'Two-Handed Exotics');
  addItemSubClass(2, 13, -1, -1, 0, 0, 'Fist Weapon', 'Fist Weapons');
  addItemSubClass(2, 14, -1, -1, 0, 0, 'Miscellaneous', '');
  addItemSubClass(2, 15, -1, -1, 0, 0, 'Dagger', 'Daggers');
  addItemSubClass(2, 16, -1, -1, 0, 1, 'Thrown', 'Thrown');
  addItemSubClass(2, 17, -1, -1, 0, 2, 'Spear', 'Spears');
  addItemSubClass(2, 18, -1, -1, 0, 1, 'Crossbow', 'Crossbows');
  addItemSubClass(2, 19, -1, -1, 0, 1, 'Wand', 'Wands');
  addItemSubClass(2, 20, -1, -1, 0, 0, 'Fishing Pole', 'Fishing Poles');
  // Class 4: Armor
  addItemSubClass(4, 0, -1, -1, 1, 0, 'Miscellaneous', '');
  addItemSubClass(4, 1, -1, -1, 0, 0, 'Cloth', 'Cloth');
  addItemSubClass(4, 2, -1, -1, 0, 0, 'Leather', 'Leather');
  addItemSubClass(4, 3, -1, -1, 0, 0, 'Mail', 'Mail');
  addItemSubClass(4, 4, -1, -1, 0, 0, 'Plate', 'Plate');
  addItemSubClass(4, 5, -1, -1, 0, 0, 'Buckler(OBSOLETE)', 'Bucklers');
  addItemSubClass(4, 6, 5, -1, 0, 0, 'Shield', 'Shields');
  // Class 5: Reagent
  addItemSubClass(5, 0, -1, -1, 0, 0, 'Reagent', '');
  // Class 6: Projectile (rows 0..=4 only)
  addItemSubClass(6, 0, -1, -1, 0, 0, 'Wand(OBSOLETE)', '');
  addItemSubClass(6, 1, -1, -1, 0, 0, 'Bolt(OBSOLETE)', '');
  addItemSubClass(6, 2, -1, -1, 0, 0, 'Arrow', '');
  addItemSubClass(6, 3, -1, -1, 0, 0, 'Bullet', '');
  addItemSubClass(6, 4, -1, -1, 0, 0, 'Thrown(OBSOLETE)', '');
  writeFile('DBFilesClient/ItemSubClass.dbc', itemSubClassDbc.build());

  const itemSubClassMaskDbc = new WdbcBuilder(11, [2, 3, 4, 5, 6, 7, 8, 9]);
  const maskRows = [
    [2, 0x0002a5f3, 'Melee Weapon'],
    [2, 0x0004000c, 'Ranged Weapon'],
    [4, 0x00000060, 'Shield'],
  ];
  for (const [cls, mask, name] of maskRows) {
    itemSubClassMaskDbc.addRow([cls, mask, name, '', '', '', '', '', '', '', 0x007f0000]);
  }
  writeFile('DBFilesClient/ItemSubClassMask.dbc', itemSubClassMaskDbc.build());

  // -------------------------------------------------------------------------
  // I. Build WeaponSwingSounds2.dbc (4 cols) & Material.dbc (3 cols)
  // -------------------------------------------------------------------------
  const weaponSwingDbc = new WdbcBuilder(4, []);
  const swingRows = [
    [1, 0, 0, 233],
    [2, 0, 1, 234],
    [3, 1, 0, 235],
    [4, 1, 1, 236],
    [5, 2, 0, 237],
    [6, 2, 1, 238],
  ];
  for (const row of swingRows) weaponSwingDbc.addRow(row);
  writeFile('DBFilesClient/WeaponSwingSounds2.dbc', weaponSwingDbc.build());

  const materialDbc = new WdbcBuilder(3, []);
  const materialRows = [
    [1, 1, 0],    // Metal (bit 0)
    [2, 0, 0],    // Wood
    [3, 0, 0],    // Gem / Liquid
    [4, 1, 0],    // Jewelry / Metal
    [5, 5, 1005], // Chain (metal bit 0 | chain bit 2, foley 1005)
    [6, 3, 1004], // Plate (metal bit 0 | plate bit 1, foley 1004)
    [7, 0, 0],    // Cloth
    [8, 0, 1003], // Leather (foley 1003)
  ];
  for (const row of materialRows) materialDbc.addRow(row);
  writeFile('DBFilesClient/Material.dbc', materialDbc.build());

  // -------------------------------------------------------------------------
  // J. Build WeaponImpactSounds.dbc (23 cols, 30 rows) & SheatheSoundLookups.dbc (7 cols, 33 rows)
  // -------------------------------------------------------------------------
  const weaponImpactDbc = new WdbcBuilder(23, []);
  let impactId = 1;
  // 15 weapon subclasses (0..=14) × 2 material types (0 = wood/non-metal, 1 = metal) = 30 rows
  for (let sub = 0; sub <= 14; sub++) {
    for (let metal = 0; metal <= 1; metal++) {
      const fleshHit = sub === 0 ? 171 : 143;
      const fleshCrit = sub === 0 ? 172 : 144;
      const impact = [fleshHit, 145, 147, 3263, 3262, 1002, 1001, 3205, 3206, 3207];
      const crit = [fleshCrit, 146, 148, 3263, 3262, 1002, 1001, 3205, 3206, 3207];
      weaponImpactDbc.addRow([impactId++, sub, metal, ...impact, ...crit]);
    }
  }
  writeFile('DBFilesClient/WeaponImpactSounds.dbc', weaponImpactDbc.build());

  const sheatheDbc = new WdbcBuilder(7, []);
  let sheatheId = 1;
  // 15 subclasses at material=1 (metal), 15 at material=2 (wood), 1 at (2,0,0), 2 shields (4,5,0) & (4,6,0) = 33 rows
  sheatheDbc.addRow([sheatheId++, 2, 0, 0, 0, 697, 699]);
  for (let sub = 0; sub <= 14; sub++) {
    sheatheDbc.addRow([sheatheId++, 2, sub, 1, 1, 698, 700]); // metal
    sheatheDbc.addRow([sheatheId++, 2, sub, 2, 0, 697, 699]); // wood
  }
  sheatheDbc.addRow([sheatheId++, 4, 5, 0, 0, 696, 701]); // Buckler
  sheatheDbc.addRow([sheatheId++, 4, 6, 0, 0, 696, 701]); // Shield
  writeFile('DBFilesClient/SheatheSoundLookups.dbc', sheatheDbc.build());

  // -------------------------------------------------------------------------
  // K. Build Footsteps, Terrain, GroundEffect, Footprint & DeathThud DBCs
  // -------------------------------------------------------------------------
  const terrainTypeSoundsDbc = new WdbcBuilder(1, []);
  for (let id = 1; id <= 9; id++) terrainTypeSoundsDbc.addRow([id]);
  writeFile('DBFilesClient/TerrainTypeSounds.dbc', terrainTypeSoundsDbc.build());

  const terrainTypeDbc = new WdbcBuilder(6, [1]);
  const terrainTypeRows = [
    [0, 'Dirt', 0, 0, 1, 0],
    [1, 'Metallic', 0, 0, 2, 0],
    [2, 'Stone', 0, 0, 3, 0],
    [3, 'Snow', 0, 0, 4, 1], // leaves footprints (bit 0)
    [4, 'Wood', 0, 0, 5, 0],
    [5, 'Grass', 0, 0, 6, 0],
    [6, 'Leaves', 0, 0, 7, 0],
    [7, 'Sand', 0, 0, 8, 1], // leaves footprints (bit 0)
    [8, 'Soggy', 0, 0, 9, 0],
    [9, 'DustyGrass', 0, 0, 6, 0],
    [10, 'None', 0, 0, 0, 0],
  ];
  for (const row of terrainTypeRows) terrainTypeDbc.addRow(row);
  writeFile('DBFilesClient/TerrainType.dbc', terrainTypeDbc.build());

  const groundEffectDoodadDbc = new WdbcBuilder(3, [2]);
  const detailDoodadRows = [
    [1, 1, 'PorcelainGrassTuft.mdl'],
    [2, 2, 'PorcelainWildflower.mdl'],
    [3, 3, 'PorcelainFern.mdl'],
    [4, 4, 'FrostbellSnowTuft.mdl'],
    [5, 5, 'FrostbellIceCrystal.mdl'],
    [6, 6, 'GlasswakeSucculent.mdl'],
    [7, 7, 'AureateGoldenWheat.mdl'],
    [8, 8, 'AureateSunflower.mdl'],
    [9, 9, 'NocturnumGlowShroom.mdl'],
    [10, 10, 'NocturnumVioletMoss.mdl'],
  ];
  for (const row of detailDoodadRows) groundEffectDoodadDbc.addRow(row);
  writeFile('DBFilesClient/GroundEffectDoodad.dbc', groundEffectDoodadDbc.build());

  const NO_DOODAD = 0xFFFFFFFF;
  const groundEffectTextureDbc = new WdbcBuilder(7, []);
  const groundEffectTextureRows = [
    // [ID, Doodad0, Doodad1, Doodad2, Doodad3, Density, TerrainType]
    [1, 6, 1, NO_DOODAD, NO_DOODAD, 10, 0],                   // 1: Dirt (TerrainType 0)
    [2, NO_DOODAD, NO_DOODAD, NO_DOODAD, NO_DOODAD, 0, 1],    // 2: Metallic (TerrainType 1)
    [3, NO_DOODAD, NO_DOODAD, NO_DOODAD, NO_DOODAD, 0, 2],    // 3: Stone / Cobblestone Road / Cliff (TerrainType 2)
    [4, 4, 5, 4, 2, 20, 3],                                   // 4: Frostbell Snow (TerrainType 3 + Footprints)
    [5, NO_DOODAD, NO_DOODAD, NO_DOODAD, NO_DOODAD, 0, 4],    // 5: Wood (TerrainType 4)
    [6, 1, 2, 3, 1, 24, 5],                                   // 6: Porcelain Wake Grass (TerrainType 5)
    [7, 2, 3, 8, 1, 24, 6],                                   // 7: Celandia Wildflower Meadow (TerrainType 6 Leaves)
    [8, 6, 7, 6, 1, 16, 7],                                   // 8: Glasswake Sand (TerrainType 7 + Footprints)
    [9, 9, 10, 9, 3, 22, 8],                                  // 9: Nocturnum Bioluminescent Moss (TerrainType 8 Soggy)
    [10, 7, 8, 1, 2, 22, 9],                                  // 10: Aureate Golden Terrace (TerrainType 9 DustyGrass)
    [11, NO_DOODAD, NO_DOODAD, NO_DOODAD, NO_DOODAD, 0, 10],  // 11: None (TerrainType 10)
  ];
  for (const row of groundEffectTextureRows) groundEffectTextureDbc.addRow(row);
  writeFile('DBFilesClient/GroundEffectTexture.dbc', groundEffectTextureDbc.build());

  const footprintTexturesDbc = new WdbcBuilder(2, [1]);
  const footprintRows = [
    [1, 'textures\\Footsteps\\BaseFootprint'],
    [2, 'textures\\Footsteps\\BootFootprint'],
    [3, 'textures\\Footsteps\\HoofFootprint'],
    [4, 'textures\\Footsteps\\ClawFootprint'],
    [5, 'textures\\Footsteps\\HeavyFootprint'],
    [7, 'textures\\Footsteps\\PawFootprint'],
  ];
  for (const row of footprintRows) footprintTexturesDbc.addRow(row);
  writeFile('DBFilesClient/FootprintTextures.dbc', footprintTexturesDbc.build());

  const footstepLookupDbc = new WdbcBuilder(5, []);
  let footstepRowId = 1;
  const terrainSoundToKit = [560, 560, 561, 563, 564, 565, 562, 566, 567, 568];
  for (let ts = 0; ts <= 9; ts++) {
    footstepLookupDbc.addRow([footstepRowId++, 7, ts, terrainSoundToKit[ts], ts === 0 ? 0 : 1062]);
  }
  for (let ts = 0; ts <= 9; ts++) {
    footstepLookupDbc.addRow([footstepRowId++, 8, ts, ts === 2 ? 650 : terrainSoundToKit[ts], ts === 0 ? 0 : 1063]);
  }
  for (let ts = 0; ts <= 9; ts++) {
    footstepLookupDbc.addRow([footstepRowId++, 1, ts, terrainSoundToKit[ts], ts === 0 ? 0 : 1062]);
  }
  writeFile('DBFilesClient/FootstepTerrainLookup.dbc', footstepLookupDbc.build());

  const deathThudDbc = new WdbcBuilder(5, []);
  let deathThudId = 1;
  // 5 size classes (0..=4) × 9 terrain sound IDs (1..=9) = 45 rows
  for (let sc = 0; sc <= 4; sc++) {
    for (let ts = 1; ts <= 9; ts++) {
      let landKit = sc === 0 ? (ts === 1 ? 907 : ts === 6 ? 908 : 910)
        : sc === 1 ? 915
        : sc === 2 ? 920
        : sc === 3 ? 926
        : 928;
      let waterKit = ts === 2 ? 0
        : sc === 0 ? 1266
        : sc <= 2 ? 1267
        : sc === 3 ? 1268
        : 1269;
      deathThudDbc.addRow([deathThudId++, sc, ts, landKit, waterKit]);
    }
  }
  writeFile('DBFilesClient/DeathThudLookups.dbc', deathThudDbc.build());

  // -------------------------------------------------------------------------
  // L. Build CreatureSoundData.dbc (30 cols), NPCSounds.dbc (5 cols), VocalUISounds.dbc (7 cols)
  // -------------------------------------------------------------------------
  const creatureSoundDbc = new WdbcBuilder(30, []);
  function addCreatureSoundRow(id, prefix, footstepId = 1, fidgetDelayMin = 120, fidgetDelayMax = 240) {
    const base = archetypeBaseId[prefix];
    creatureSoundDbc.addRow([
      id,
      base + 0, // 1: Exertion
      base + 0, // 2: ExertionCritical
      base + 1, // 3: Injury
      base + 2, // 4: InjuryCritical
      0,        // 5: InjuryCrushingBlow
      base + 3, // 6: Death
      0,        // 7: Stun
      0,        // 8: Stand
      footstepId, // 9:SoundFootstepID
      base + 4, // 10: Aggro
      0,        // 11: WingFlap
      0,        // 12: WingGlide
      0,        // 13: Alert
      0,        // 14: Fidget0
      0, 0, 0,  // 15..17: Fidget1..3
      0, 0, 0, 0, // 18..21: CustomAttack0..3
      0,        // 22: NPCSoundID (unused)
      0,        // 23: LoopSoundID (0 = no continuous body loop!)
      1,        // 24: CreatureImpactType
      0, 0,     // 25..26: JumpStart, JumpEnd
      0,        // 27: PetAttack
      fidgetDelayMin, // 28: PetOrder / FidgetDelayMin
      fidgetDelayMax, // 29: PetDismiss / FidgetDelayMax
    ]);
    return id;
  }

  // 16 Celandia Hero Models (IDs 1..16)
  const heroGenderArchetype = [
    'HeroF', 'HeroM', 'HeroM', 'HeroF', 'HeroM', 'HeroF', 'HeroF', 'HeroM',
    'HeroF', 'HeroM', 'HeroF', 'HeroM', 'HeroF', 'HeroM', 'HeroM', 'HeroF',
  ];
  for (let i = 0; i < 16; i++) {
    addCreatureSoundRow(i + 1, heroGenderArchetype[i], 7);
  }
  // 5 Celandia Fauna/Bosses (IDs 20..24) + 6 Reincarnation Monster Archetypes (IDs 25..30)
  addCreatureSoundRow(20, 'PorcelainHound', 1);
  addCreatureSoundRow(21, 'FrostbellStag', 1);
  addCreatureSoundRow(22, 'GlasswakeScorpion', 1);
  addCreatureSoundRow(23, 'AureateGriffin', 1);
  addCreatureSoundRow(24, 'NocturnumWraith', 1);
  addCreatureSoundRow(25, 'Construct', 8);
  addCreatureSoundRow(27, 'NocturnumWraith', 1);
  addCreatureSoundRow(28, 'PorcelainHound', 1);
  addCreatureSoundRow(29, 'HeroM', 7);
  addCreatureSoundRow(30, 'Boss', 8);

  // Classic unit test rows for CreatureSoundData (`creature_sound.rs` checks 26 Wolf, 37 Murloc, 68 Player)
  creatureSoundDbc.addRow([
    26, 384, 384, 385, 386, 0, 387, 0, 0, 1, 388, 0, 0, 388,
    389, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 20, 40,
  ]);
  creatureSoundDbc.addRow([
    37, 384, 384, 385, 386, 0, 387, 0, 0, 1, 412, 0, 0, 412,
    389, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 20, 40,
  ]);
  creatureSoundDbc.addRow([
    68, 384, 384, 385, 386, 0, 387, 0, 0, 7, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  writeFile('DBFilesClient/CreatureSoundData.dbc', creatureSoundDbc.build());

  // NPCSounds.dbc (5 cols: ID, Hello, Goodbye, Pissed, Ack)
  const npcSoundsDbc = new WdbcBuilder(5, []);
  const heroFBase = archetypeBaseId['HeroF'];
  const heroMBase = archetypeBaseId['HeroM'];
  npcSoundsDbc.addRow([1, heroFBase + 6, heroFBase + 7, heroFBase + 8, heroFBase + 6]);
  npcSoundsDbc.addRow([2, heroMBase + 6, heroMBase + 7, heroMBase + 8, heroMBase + 6]);
  npcSoundsDbc.addRow([50, 5881, 5880, 5922, 0]);
  npcSoundsDbc.addRow([161, 5881, 0, 0, 0]);
  writeFile('DBFilesClient/NPCSounds.dbc', npcSoundsDbc.build());

  // VocalUISounds.dbc (7 cols: ID, VocalUIEnum, RaceID, NormalMale, NormalFemale, PissedMale, PissedFemale)
  // Note: PissedMale & PissedFemale must be 0 per `the_annoyed_column_resolves_to_nothing_in_this_build`
  const vocalUiDbc = new WdbcBuilder(7, []);
  let vocalUiRowId = 1;
  for (let race = 1; race <= 8; race++) {
    for (let line = 0; line < 0x44; line++) {
      vocalUiDbc.addRow([vocalUiRowId++, line, race, 1942, 2066, 0, 0]);
    }
  }
  writeFile('DBFilesClient/VocalUISounds.dbc', vocalUiDbc.build());

  // -------------------------------------------------------------------------
  // M. Build ItemGroupSounds.dbc (5 cols), SoundProviderPreferences.dbc (24 cols), SoundWaterType.dbc (4 cols)
  // -------------------------------------------------------------------------
  const itemGroupSoundsDbc = new WdbcBuilder(5, []);
  itemGroupSoundsDbc.addRow([1, 273, 274, 275, 0]);
  for (let g = 2; g <= 24; g++) {
    if (g === 7) {
      itemGroupSoundsDbc.addRow([7, 1185, 1202, 0, 0]);
    } else {
      itemGroupSoundsDbc.addRow([g, 273, 274, 0, 0]);
    }
  }
  writeFile('DBFilesClient/ItemGroupSounds.dbc', itemGroupSoundsDbc.build());

  const soundProviderDbc = new WdbcBuilder(24, [1]);
  function addReverbPreset(id, desc, env, decayTime, decayHfRatio, room, roomHf, reflections, reverb) {
    soundProviderDbc.addRow([
      id,
      desc,
      0, // Flags
      env,
      f32(1.0), // EnvSize
      f32(1.0), // EnvDiffusion
      room >>> 0,
      roomHf >>> 0,
      0,
      f32(decayTime),
      f32(decayHfRatio),
      f32(1.0),
      reflections >>> 0,
      f32(0.007),
      reverb >>> 0,
      f32(0.011),
      f32(0.25),
      f32(0.0),
      f32(0.25),
      f32(0.0),
      f32(0.0),
      f32(5000.0),
      f32(250.0),
      f32(0.0),
    ]);
  }
  addReverbPreset(1, 'Simple', 0, 1.49, 0.83, -1000, -100, -2602, 200);
  addReverbPreset(11, 'Underwater', 22, 1.49, 0.10, -1000, -10000, -450, 1700);
  addReverbPreset(67, 'PRESET_GENERIC', 0, 1.49, 0.83, -1000, -100, -2602, 200);
  addReverbPreset(72, 'PRESET_ROOM', 1, 0.40, 0.83, -1000, -454, -1646, 53);
  addReverbPreset(73, 'PRESET_AUDITORIUM', 6, 4.32, 0.59, -1000, -476, -789, -289);
  addReverbPreset(74, 'PRESET_CAVE', 8, 2.91, 1.30, -1000, 0, -602, -302);
  writeFile('DBFilesClient/SoundProviderPreferences.dbc', soundProviderDbc.build());

  const soundWaterTypeDbc = new WdbcBuilder(4, []);
  const waterRows = [
    [1, 0, 0, 1111],  // Water Still -> RiverStill
    [2, 0, 4, 1112],  // Water Slow -> RiverSlow
    [3, 0, 8, 1113],  // Water Fast -> RiverFast
    [4, 1, 0, 1114],  // Ocean Still -> Ocean
    [5, 1, 4, 1114],  // Ocean Slow -> Ocean
    [6, 1, 8, 1114],  // Ocean Fast -> Ocean
    [7, 2, 0, 3072],  // Magma Still -> LavaPoolLoop
    [8, 2, 4, 3052],  // Magma Slow -> LavaFlowLoop
    [9, 2, 8, 3052],  // Magma Fast -> LavaFlowLoop
    [10, 3, 0, 3880], // Slime Still -> SlimeLoop
    [11, 3, 4, 3880], // Slime Slow -> SlimeLoop
    [12, 3, 8, 3880], // Slime Fast -> SlimeLoop
  ];
  for (const row of waterRows) soundWaterTypeDbc.addRow(row);
  writeFile('DBFilesClient/SoundWaterType.dbc', soundWaterTypeDbc.build());

  // -------------------------------------------------------------------------
  // N. Return Structured Audio IDs for AreaTable, SpellVisualKit & CreatureModelData
  // -------------------------------------------------------------------------
  const creatureSoundIds = {
    maren: 1, kaelen: 2, soren: 3, lyra: 4,
    thalos: 5, nyx: 6, veyra: 7, orin: 8,
    seraphina: 9, draven: 10, elowyn: 11, garrick: 12,
    isolde: 13, fenris: 14, zephyr: 15, morrigan: 16,
    porcelainHound: 20,
    frostbellStag: 21,
    glasswakeScorpion: 22,
    aureateGriffin: 23,
    nocturnumWraith: 24,
    construct: 25,
    wolf: 26,
    elemental: 27,
    beast: 28,
    humanoid: 29,
    boss: 30,
  };

  const zoneMusicIds = {
    1: 101, 2: 102, 3: 103, 4: 104, 5: 105,
    porcelainWake: 101,
    frostbellLagoon: 102,
    glasswakeMesas: 103,
    aureateReach: 104,
    nocturnumIsle: 105,
    title: 106,
    introIds: {
      1: 1, 2: 2, 3: 3, 4: 4, 5: 5,
      porcelainWake: 1,
      frostbellLagoon: 2,
      glasswakeMesas: 3,
      aureateReach: 4,
      nocturnumIsle: 5,
    },
  };

  const ambienceIds = {
    1: 101, 2: 102, 3: 103, 4: 104, 5: 105,
    porcelainWake: 101,
    frostbellLagoon: 102,
    glasswakeMesas: 103,
    aureateReach: 104,
    nocturnumIsle: 105,
  };

  return {
    spellSoundIds,
    creatureSoundIds,
    zoneMusicIds,
    ambienceIds,
  };
}

// Allow standalone CLI execution for testing/verification
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const DATA_DIR = path.join(ROOT, 'WoW', 'Data');

  function standaloneWriteFile(relPath, buf) {
    const full = path.join(DATA_DIR, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
  }

  class StandaloneWdbcBuilder {
    constructor(fieldCount, stringCols = []) {
      this.fieldCount = fieldCount;
      this.stringCols = new Set(stringCols);
      this.rows = [];
      this.strings = new Map([['', 0]]);
      this.stringChunks = [Buffer.from([0])];
      this.stringLen = 1;
    }
    addString(s) {
      const str = String(s ?? '');
      if (this.strings.has(str)) return this.strings.get(str);
      const offset = this.stringLen;
      const chunk = Buffer.from(str + '\0', 'utf8');
      this.strings.set(str, offset);
      this.stringChunks.push(chunk);
      this.stringLen += chunk.length;
      return offset;
    }
    addRow(fields) {
      const row = new Array(this.fieldCount).fill(0);
      for (let i = 0; i < this.fieldCount; i++) {
        row[i] = this.stringCols.has(i) ? this.addString(fields[i] ?? '') : (fields[i] ?? 0);
      }
      this.rows.push(row);
    }
    build() {
      const recSize = this.fieldCount * 4;
      const header = Buffer.alloc(20);
      header.write('WDBC', 0, 4, 'ascii');
      header.writeUInt32LE(this.rows.length, 4);
      header.writeUInt32LE(this.fieldCount, 8);
      header.writeUInt32LE(recSize, 12);
      header.writeUInt32LE(this.stringLen, 16);
      const records = Buffer.alloc(this.rows.length * recSize);
      for (let r = 0; r < this.rows.length; r++) {
        const row = this.rows[r];
        for (let c = 0; c < this.fieldCount; c++) {
          records.writeUInt32LE(row[c] >>> 0, (r * this.fieldCount + c) * 4);
        }
      }
      return Buffer.concat([header, records, ...this.stringChunks]);
    }
  }

  function standaloneF32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    return b.readUInt32LE(0);
  }

  const res = buildCelandiaAudio(standaloneWriteFile, StandaloneWdbcBuilder, standaloneF32);
  console.log('[build-celandia-audio] Built Celandia audio pipeline successfully:', res);
}
