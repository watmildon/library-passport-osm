// controls.js — small UI controls shared by the QA and Augment pages.

import { customOverpass, setCustomOverpass, DEFAULT_ENDPOINT } from './config.js';

// ---------------- Overpass server picker ----------------
//
// Both pages talk to Overpass — the system explorer's live view, and every
// "Send to JOSM", which reads each object's current geometry and version before
// building the layer. The default is a public server, and public servers do not
// refuse work when they are busy: they QUEUE it, holding the connection open.
// That is what a mysterious 40-second button press usually is.
//
// So the endpoint is a visible setting rather than a buried one, and the hint
// says which server is in play — a slow send should be attributable.
export function setupOverpassPicker(onChange) {
  const input = document.querySelector('#overpass-url');
  const hint = document.querySelector('#overpass-hint');
  if (!input) return;

  const paint = () => {
    const custom = customOverpass();
    input.value = custom;
    if (!hint) return;
    hint.textContent = custom
      ? 'Using your server.'
      : 'Using the public server – it queues when busy, which is why a send can stall.';
    hint.classList.toggle('qa-endpoint-custom', !!custom);
  };

  const save = () => {
    const v = input.value.trim();
    if (v && !/^https?:\/\/.+/i.test(v)) {
      if (hint) {
        hint.textContent = 'That doesn’t look like a URL – expected https://…/api/interpreter';
        hint.classList.remove('qa-endpoint-custom');
      }
      return;
    }
    // A bare host or a truncated path is the classic mistake; nudge, don't block.
    if (v && !/\/api\/interpreter\/?$/i.test(v) && hint) {
      hint.textContent = 'Saved. Most instances expect the path /api/interpreter – check yours if requests fail.';
      setCustomOverpass(v);
      onChange?.();
      return;
    }
    setCustomOverpass(v);
    paint();
    onChange?.();
  };

  input.addEventListener('change', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  input.placeholder = DEFAULT_ENDPOINT;
  paint();
}

// ---------------- Busy state for a long-running button ----------------
//
// Anything that goes to Overpass can take tens of seconds. Without feedback a
// slow send is indistinguishable from a dead click, so the button owns its own
// pending state: disabled, labelled, and spinning until the work settles.
export async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const original = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.innerHTML = `<span class="qa-spinner" aria-hidden="true"></span>${label}`;
  try {
    return await fn();
  } finally {
    btn.disabled = wasDisabled;
    btn.classList.remove('is-busy');
    btn.innerHTML = original;
  }
}
