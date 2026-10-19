# Glyph Tide

A field of random characters that behaves like wind over water. Click for a ripple, Shift-click (or Option/Alt-click) for a heart.

Inspired by the New session background in the Claude desktop app. No dependencies, needs WebGL2.

## Run

Open `index.html`.

## Use

```html
<div class="hero">
  <div class="hero-content" style="position: relative; z-index: 1">…</div>
</div>
<script src="glyph-tide.js"></script>
<script>
  const tide = GlyphTide.mount(document.querySelector('.hero'), { calm: '.hero-content' });
</script>
```

Characters use the container's `color` and `font-family`; the glow uses `--tide-glow`. Options are at the top of `glyph-tide.js`.

- `tide.set({...})` changes options live
- `tide.ripple(x, y)` drops a ripple
- `tide.destroy()` cleans up

## Notes

- Characters don't move. Each cell cycles through a shared glyph sequence at its own pace; ripples push cells a few steps ahead and back.
- Gust light is sampled per pixel, and stroke edges facing the wind catch more of it (`friction`).
- Idles at 25 fps. After `budget` seconds without input it eases to a stop and stops drawing until the next touch. Respects `prefers-reduced-motion`.
