// boot.js — the pre-login loading experience, shared by the dev page (web/index.html) and the
// realm page (crates/wenilla-realm/templates/play.html).
//
// Why this exists: the client cannot show its own boot. Everything a fresh tab waits on — the
// 15 MB (brotli) wasm download, instantiation, and the first update's catalog pile (~100+
// synchronous XHR chain reads in ONE rAF task, the "unresponsive tab" window) — happens before
// the first frame the app could draw. So the page owns a DOM overlay, and it does two jobs:
//
//   1. SHOW what is happening: a byte-counted wasm download bar (the counting stream is
//      re-wrapped in a Response so `WebAssembly.compileStreaming` still streams), a
//      "game data N/M" line for the prefetch, then indeterminate "Starting…" states driven by
//      the client's own `window.__wenilla_progress(stage)` calls (benilla-app/src/webprogress.rs)
//      until "ready" — the first glue screen — fades the overlay out.
//   2. SHRINK the unresponsive window: `/data/*` is served immutable (max-age=1y), and a sync
//      XHR is served from the HTTP cache when the same URL was fetch()ed first (verified live:
//      transferSize 0, deliveryType "cache"). So the overlay prefetches the boot read-set — a
//      checked-in manifest (boot-manifest.json) captured from a traced boot — with a small
//      fetch pool, in parallel with the wasm download. The catalog pile then costs parse, not
//      ~100 serial network round trips. Every miss (drift, missing manifest) degrades to
//      exactly today's behavior, and a warm-cache visitor flies through all of it: progress is
//      measured, never scripted.
//
// Page contract: `const w = await boot(init); bind(w.memory);` — bind must stay immediately
// after (the Lua WASI shims need the module's linear memory). Query switches: `?boottrace=1`
// arms window.__wenilla_boottrace and skips the prefetch (a manifest-capture boot must show the
// true read order); `?noprefetch=1` skips the prefetch only (the A/B lever).

// The wasm travels brotli-compressed: content-length counts .br bytes while the counted stream
// yields decompressed ones. Dividing the two on a real build gives ~5.0; it drifts a little per
// build and that is cosmetic — the bar is clamped at 99% until the stream actually ends.
const BR_RATIO = 5.0;
const READY_TIMEOUT_MS = 20000;
const PREFETCH_CONCURRENCY = 8;

export async function boot(init, opts = {}) {
  const q = new URLSearchParams(location.search);
  const ui = createBootUi();
  if (q.get('boottrace') === '1') window.__wenilla_boottrace = [];
  const skipPrefetch = q.get('boottrace') === '1' || q.get('noprefetch') === '1';
  installProgressHook(ui, skipPrefetch);

  const prefetch = skipPrefetch
    ? Promise.resolve()
    : prefetchManifest('./boot-manifest.json', (done, total) => ui.setData(done, total)).catch(
        () => ui.setData(0, 0)
      );

  // Compile immediately: merely fetching a Response leaves its body backpressured until
  // someone consumes it. Instantiation must still wait for the cache warmup because the
  // game's Startup performs synchronous reads of the prefetched catalogs.
  const wasm = compileWasm(new URL('./wenilla_bg.wasm', import.meta.url), (got, total) =>
    ui.setWasmProgress(got, total)
  );
  let w;
  try {
    // Attach rejection handlers to both operations now, including while prefetch is pending.
    const [module] = await Promise.all([wasm, prefetch]);
    w = await init({ module_or_path: module });
  } catch (e) {
    ui.fail('The client failed to start: ' + (e && e.message ? e.message : e));
    throw e;
  }
  // init() resolved = module instantiated and the plugin graph built; the heavy catalog frame
  // is still ahead. From here the client drives the stages; the timeout is the drift backstop
  // (an old bundle without webprogress under a new page must not strand the overlay).
  ui.setStage('Starting…');
  ui.armTimeout(opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  return w;
}

// Match wasm-bindgen's non-streaming fallback for servers without the WASM MIME type.
// Choose before consuming the body, avoiding a cloned response buffering the whole module.
async function compileWasm(url, onBytes) {
  const response = await fetchWasm(url, onBytes);
  if (!response.ok) throw new Error(`Client download failed (HTTP ${response.status})`);
  if (typeof WebAssembly.compileStreaming === 'function' &&
      response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

/// Byte-counting fetch of the wasm, re-wrapped so streaming compilation survives. Returns a
/// Promise<Response> consumed immediately by compileWasm, before game instantiation.
async function fetchWasm(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok || !r.body) return r; // compileWasm surfaces HTTP errors / handles a missing stream
  const contentLength = Number(r.headers.get('content-length')) || 0;
  const compressed = !!(r.headers.get('content-encoding') || '').trim();
  const total = contentLength ? contentLength * (compressed ? BR_RATIO : 1) : 0;
  let got = 0;
  const reader = r.body.getReader();
  const counted = new ReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        onBytes(got, got); // the honest total, now that we know it
        c.close();
        return;
      }
      got += value.byteLength;
      onBytes(got, total);
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // Headers are copied so Content-Type: application/wasm survives — compileStreaming
  // refuses anything else.
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/// Warm the HTTP cache with a manifest's read-set: fetch the manifest, then a fixed-size pool of
/// full-body fetches. Failures are counted as done and otherwise ignored — a miss just means
/// that file loads the old way. A missing/invalid manifest resolves immediately (line hides).
/// Used twice: the boot set before `init()`, the world-entry set after `ready`.
async function prefetchManifest(manifestUrl, onProgress) {
  const r = await fetch(manifestUrl);
  if (!r.ok) return onProgress(0, 0);
  const manifest = await r.json();
  const names = Array.isArray(manifest && manifest.names) ? manifest.names : [];
  if (!names.length) return onProgress(0, 0);
  let done = 0;
  onProgress(0, names.length);
  const queue = names.slice();
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      try {
        const resp = await fetch('/data/' + encodeURIComponent(name));
        if (resp.ok) await resp.arrayBuffer(); // body fully read = body fully cached
      } catch (_) {
        /* offline blip, 404 drift — the sync XHR path will deal with it */
      }
      done += 1;
      onProgress(done, names.length);
    }
  }
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

/// `window.__wenilla_progress(stage)` — the client's calls land here (webprogress.rs).
///
/// `ready` also starts the SECOND prefetch: the world-entry read-set. Entering the world used
/// to be one frozen frame of ~200 synchronous sprite reads (184 `Interface\…\*.blp` on the
/// first UI draw, plus a few quest-marker models and zone sounds) — 206 s on a cold 100 ms-RTT
/// cache. That set is location-independent, so `world-manifest.json` (captured the same way
/// as the boot manifest, minus the boot set) is warmed while the player is at the glue screens,
/// with a corner line so it is visible but never in the way. Whatever is still in flight when
/// they click Enter World just loads the old way.
function installProgressHook(ui, skipPrefetch) {
  window.__wenilla_progress = (stage) => {
    if (stage === 'startup') ui.setStage('Raising the world…');
    else if (stage === 'ready') {
      ui.hide();
      if (!skipPrefetch) {
        const corner = createCornerLine();
        prefetchManifest('./world-manifest.json', (done, total) =>
          corner.set(total > 0 && done < total ? `preparing world data — ${done}/${total}` : '')
        )
          .catch(() => {})
          .finally(() => corner.remove());
      }
    }
  };
}

/// The unobtrusive bottom-left status line the world prefetch reports on.
function createCornerLine() {
  const el = document.createElement('div');
  el.id = 'wenilla-corner';
  el.style.cssText =
    'position:fixed;left:.6rem;bottom:.5rem;z-index:15;font:12px system-ui,sans-serif;' +
    'color:#d8c4e8;background:rgba(23,18,36,.78);border:1px solid rgba(245,154,184,.35);' +
    'padding:.2rem .55rem;border-radius:4px;pointer-events:none;transition:opacity .4s ease';
  document.body.appendChild(el);
  return {
    set(text) {
      el.textContent = text;
      el.style.opacity = text ? '1' : '0';
    },
    remove() {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    },
  };
}

/// The overlay itself. Styled in Celandia's Porcelain Court & Nocturnum palette; no external dependencies.
function createBootUi() {
  const root = document.createElement('div');
  root.id = 'wenilla-boot';
  root.innerHTML = `
    <style>
      @font-face { font-family: 'WowMorpheus'; src: url('/data/Fonts%5CMORPHEUS.TTF'); font-display: swap; }
      @font-face { font-family: 'WowFriz'; src: url('/data/Fonts%5CFRIZQT__.TTF'); font-display: swap; }
      #wenilla-boot { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
        color: #f2e4f0; font: 14px WowFriz, system-ui, -apple-system, sans-serif; overflow: hidden;
        background:
          radial-gradient(ellipse at 50% 34%, rgba(245, 154, 184, .22), transparent 58%),
          radial-gradient(ellipse at 28% 78%, rgba(143, 214, 240, .18), transparent 52%),
          radial-gradient(ellipse at 72% 88%, rgba(184, 108, 255, .26), transparent 55%),
          #171224;
        transition: opacity .6s ease; }
      #wenilla-boot.gone { opacity: 0; pointer-events: none; }
      #wenilla-boot::before { content: ''; position: absolute; inset: -50%;
        background: repeating-conic-gradient(from 0deg, rgba(245, 154, 184, .06) 0deg, transparent 4deg 11deg, rgba(143, 214, 240, .06) 15deg);
        filter: blur(6px); animation: wboot-spin 120s linear infinite;
        mask: radial-gradient(circle at 50% 50%, #000 0 18%, transparent 55%); }
      #wenilla-boot .embers { position: absolute; inset: 0; pointer-events: none; }
      #wenilla-boot .embers i { position: absolute; bottom: -10px; width: 3px; height: 3px; border-radius: 50%;
        background: #f59ab8; box-shadow: 0 0 9px 2px rgba(143, 214, 240, .75); opacity: 0;
        animation: wboot-rise linear infinite; }
      #wenilla-boot .box { position: relative; width: min(640px, 88vw); text-align: center; }
      #wenilla-boot .bar, #wenilla-boot .stage, #wenilla-boot .data { width: min(460px, 82vw); margin-left: auto; margin-right: auto; }
      #wenilla-boot .title { font: 82px/1.05 WowMorpheus, Georgia, serif; letter-spacing: .02em;
        background: linear-gradient(180deg, #ffffff 0%, #f59ab8 42%, #8fd6f0 74%, #b86cff 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
        filter: drop-shadow(0 3px 0 #120b1d) drop-shadow(0 0 24px rgba(245, 154, 184, .42)); }
      #wenilla-boot .by { margin: .8rem 0 2.4rem; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #8fd6f0; }
      #wenilla-boot .stage { margin-bottom: .7rem; min-height: 1.2em; color: #f6e8f4; }
      #wenilla-boot .bar { position: relative; height: 10px; border: 1px solid #9e75ad; border-radius: 6px;
        background: linear-gradient(#120d1e, #211834); overflow: hidden;
        box-shadow: 0 0 0 1px #0b0812, inset 0 1px 3px #08050e; }
      #wenilla-boot .bar > i { position: relative; display: block; height: 100%; width: 0;
        background: linear-gradient(90deg, #b86cff, #f59ab8 55%, #8fd6f0);
        box-shadow: 0 0 12px rgba(245, 154, 184, .65); transition: width .2s linear; }
      #wenilla-boot .bar > i::after { content: ''; position: absolute; right: -3px; top: -4px; bottom: -4px; width: 8px;
        border-radius: 50%; background: #ffffff; box-shadow: 0 0 10px 4px rgba(143, 214, 240, .85); }
      #wenilla-boot .bar.pulse > i { width: 28% !important; animation: wboot-slide 1.4s ease-in-out infinite; }
      #wenilla-boot .data { margin-top: .6rem; font-size: 12px; color: #b59ec6; min-height: 1.2em; }
      #wenilla-boot .tip { margin-top: 2.2rem; font-size: 14px; color: #e2cde8; min-height: 2.6em; font-style: italic;
        transition: opacity .5s ease; }
      #wenilla-boot .err { color: #ff85a2; }
      @keyframes wboot-slide { 0% { margin-left: 0 } 50% { margin-left: 72% } 100% { margin-left: 0 } }
      @keyframes wboot-spin { to { transform: rotate(360deg) } }
      @keyframes wboot-rise { 0% { transform: translateY(0); opacity: 0 } 10% { opacity: .9 }
        100% { transform: translateY(-105vh) translateX(var(--dx)); opacity: 0 } }
      @media (prefers-reduced-motion: reduce) {
        #wenilla-boot::before, #wenilla-boot .embers i { animation: none; } }
    </style>
    <div class="embers"></div>
    <div class="box">
      <div class="title">Wokecraft NoW</div>
      <div class="by">Celandia: The Elsewhere Tide — Porcelain Court &amp; Nocturnum</div>
      <div class="stage">Loading…</div>
      <div class="bar"><i></i></div>
      <div class="data"></div>
      <div class="tip"></div>
    </div>`;
  const embers = root.querySelector('.embers');
  for (let i = 0; i < 26; i++) {
    const e = document.createElement('i');
    e.style.left = `${Math.random() * 100}%`;
    e.style.setProperty?.('--dx', `${(Math.random() - 0.5) * 120}px`);
    e.style.animationDuration = `${7 + Math.random() * 9}s`;
    e.style.animationDelay = `${-Math.random() * 14}s`;
    embers?.appendChild?.(e);
  }
  const tips = [
    'Your spells cast themselves across the Porcelain Wake. Keep moving and weave through the tide.',
    'Resonance crystals pull toward you once you are close. Greed gets heroes cornered.',
    'An Elsewhere boss arrives every two minutes across the five island kingdoms.',
    'From level 5, F casts your class\u2019s mobility escape: Phase Blink, Grapple Lunge, Nocturnum Sprint\u2026',
    'Team up in 2\u20138 player Multiplayer Co-Op or explore the authoritative Celandia RPG realm.',
    'Press C to unlock the camera and swing it around with the mouse, or M to open the Celandia World Map.',
  ];
  const tipEl = root.querySelector('.tip');
  let tipN = Math.floor(Math.random() * tips.length);
  tipEl.textContent = tips[tipN];
  const tipTimer = setInterval(() => {
    tipEl.style.opacity = '0';
    setTimeout(() => {
      tipN = (tipN + 1) % tips.length;
      tipEl.textContent = tips[tipN];
      tipEl.style.opacity = '1';
    }, 500);
  }, 5000);
  tipTimer?.unref?.();
  document.body.appendChild(root);
  const stageEl = root.querySelector('.stage');
  const barEl = root.querySelector('.bar');
  const fillEl = root.querySelector('.bar > i');
  const dataEl = root.querySelector('.data');
  let gone = false;
  let timeout = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(0);
  return {
    setWasmProgress(got, total) {
      if (gone) return;
      if (total > 0) {
        const pct = Math.min(99, Math.floor((got / total) * 100));
        const done = got >= total;
        stageEl.textContent = done
          ? 'Summoning the horde…'
          : `Downloading the client — ${pct}%`;
        fillEl.style.width = (done ? 100 : pct) + '%';
      } else {
        stageEl.textContent = `Downloading client — ${mb(got)} MB`;
        barEl.classList.add('pulse');
      }
    },
    setData(done, total) {
      if (gone) return;
      dataEl.textContent = total > 0 && done < total ? `warming game data ${done} / ${total}` : '';
    },
    setStage(text) {
      if (gone) return;
      stageEl.textContent = text;
      barEl.classList.add('pulse');
    },
    fail(text) {
      clearTimeout(timeout);
      barEl.remove();
      dataEl.remove();
      clearInterval(tipTimer);
      stageEl.className = 'err';
      stageEl.textContent = text;
    },
    armTimeout(ms) {
      timeout = setTimeout(() => this.hide(), ms);
    },
    hide() {
      if (gone) return;
      gone = true;
      clearTimeout(timeout);
      clearInterval(tipTimer);
      root.classList.add('gone');
      setTimeout(() => root.remove(), 700);
    },
  };
}
