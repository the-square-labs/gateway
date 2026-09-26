// components/Cover/preview.html: the system's face. Every fill is bound to a
// token, every length is a spacing step, every corner the (zero) radius.

export function renderCover({ tokens, tagline }) {
  const need = ["theme-color", "color-primary", "color-border", "color-success", "color-warning", "color-background", "color-foreground"];
  const names = new Set(tokens.color.tokens.map((token) => token.name));
  for (const name of need) if (!names.has(name)) throw new Error(`cover: token ${name} is missing`);

  // Art box: x 480..960 of the 960 × 288 layout, drawn in its own 480 × 288 space.
  // A strip of 16px square buckets on a 24px pitch (spacing-4 tiles, spacing-6 pitch),
  // the HealthBars rhythm redrawn as squares: mostly success, one merged two-wide warning.
  const strip = [];
  for (let i = 0; i < 18; i += 1) {
    const x = 24 + i * 24;
    if (i === 12) continue; // taken by the merged warning tile
    if (i === 13) {
      strip.push(`<rect class="warn sq" x="${24 + 12 * 24}" y="240" width="40" height="16"/>`);
      continue;
    }
    strip.push(`<rect class="ok sq" x="${x}" y="240" width="16" height="16"/>`);
  }
  // The same tiles cut out of the ink block as ground, a 3 × 2 grid with one merged pair.
  const cuts = [
    '<rect class="cut sq" x="232" y="144" width="16" height="16"/>',
    '<rect class="cut sq" x="256" y="144" width="40" height="16"/>',
    '<rect class="cut sq" x="232" y="168" width="16" height="16"/>',
    '<rect class="cut sq" x="256" y="168" width="16" height="16"/>',
    '<rect class="cut sq" x="280" y="168" width="16" height="16"/>',
  ];

  return `<!-- @dsCard height=288 -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Good Gateway</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: var(--color-background); color: var(--color-foreground); overflow: hidden; }
  .cover { position: relative; height: 288px; overflow: hidden; }
  .art { position: absolute; top: 0; left: 480px; width: 480px; height: 288px; overflow: hidden; }
  .art svg { display: block; width: 480px; height: 288px; }
  .brand { fill: var(--theme-color); }
  .ink { fill: var(--color-primary); }
  .tint { fill: var(--color-border); }
  .ok { fill: var(--color-success); }
  .warn { fill: var(--color-warning); }
  .cut { fill: var(--color-background); }
  .sq { rx: var(--radius-sm); }
  .words { position: absolute; left: 24px; right: 24px; bottom: 24px; max-width: 440px; }
  .name { margin: 0; font-size: 96px; line-height: .95; font-weight: 700; letter-spacing: -0.02em; color: var(--color-foreground); }
  .tag { margin: 8px 0 0 4px; font-size: 14px; line-height: 20px; color: var(--color-foreground); }
</style>
</head>
<body>
<div class="cover">
<div class="art" aria-hidden="true">
<svg viewBox="0 0 480 288" width="480" height="288">
<!--
  blocks      theme-color 168×232 slab bled off the top (the brand indigo, largest) · color-primary 144×168 (ink: the product's only emphasis) · color-border 136×120 tint bled off the right · color-success 16px buckets and one color-warning 40×16 tile, small (they only mean status)
  arrangement one tall indigo slab with an ink block and a tint stepping down to the right, bottoms flush on one line (y 216), a spacing-4 gutter between; a status strip below on its own line
  pattern     square tiles on a spacing-6 pitch, some merged two-wide: "geometric, modular, dense UI" (radius 0, 1px borders, HealthBars buckets); the strip reads as uptime, the cut-outs as the same tiles in the ground
  scales      sides in spacing-4 (16px) multiples; gutters spacing-4; pitch spacing-6 (24px); every corner radius-sm (0)
-->
<rect class="brand sq" x="24" y="-16" width="168" height="232"/>
<rect class="ink sq" x="208" y="48" width="144" height="168"/>
<rect class="tint sq" x="368" y="96" width="136" height="120"/>
${cuts.join("\n")}
${strip.join("\n")}
</svg>
</div>
<div class="words">
<h1 class="name">Good<br>Gateway</h1>
<p class="tag">${tagline}</p>
</div>
</div>
</body>
</html>
`;
}
