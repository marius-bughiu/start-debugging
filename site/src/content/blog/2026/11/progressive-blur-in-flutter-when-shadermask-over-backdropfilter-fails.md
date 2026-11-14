---
title: "How to build a progressive blur in Flutter when ShaderMask over BackdropFilter does nothing"
description: "Wrapping a BackdropFilter in a ShaderMask removes the blur entirely on both Skia and Impeller. Here is why, plus two working progressive blurs: stepped BackdropFilter bands that work everywhere, and a variable-radius Gaussian through ImageFilter.shader on Impeller, both measured pixel by pixel in Flutter 3.44.8."
pubDate: 2026-11-14
template: how-to
tags:
  - "flutter"
  - "dart"
  - "impeller"
  - "shaders"
  - "performance"
---

**Short answer:** A `ShaderMask` around a `BackdropFilter` cannot fade a blur. `ShaderMask` paints its child into an offscreen layer. The `BackdropFilter` inside it then blurs that layer's empty contents, so nothing visibly changes, on Skia and on Impeller alike. Even if it worked, masking a uniform blur gives you a cross-fade between sharp and blurred, not a blur whose radius shrinks. For a real progressive blur there are two options. You can stack several clipped `BackdropFilter` bands with decreasing sigma, which works on every renderer but shows faint seams. Or you can run a variable-radius Gaussian fragment shader through `ImageFilter.shader`, which is smooth but needs Impeller. The code below was run and measured on Flutter 3.44.8 (Dart 3.12.2) on macOS with Impeller on Metal.

The question comes up constantly, usually as an attempt to rebuild Figma's "background blur + gradient mask" or the iOS-style blur that fades under a navigation bar. The [Stack Overflow thread that prompted this post](https://stackoverflow.com/questions/79942651) collected four answers, none accepted, ranging from "not possible with built-in widgets" to "tweak the gradient stops". The asker also tried a custom shader and got 30 to 40 FPS on a 120 Hz phone. Each of those points has a concrete explanation, and each can be fixed.

## How the blur was measured

Eyeballing blur is unreliable, so every variant in this post was rendered over the same test pattern and read back as pixels. The background is a `ListView` of rows painted with vertical black and white stripes, 24 logical pixels per period. A 300 px overlay sits on top, and it should blur hard at its top edge and not at all at its bottom edge. An `integration_test` running on macOS captures the whole scene with `RenderRepaintBoundary.toImage(pixelRatio: 1.0)`. For each row it reports the luminance range across 480 pixels: about 1.00 for sharp stripes (0.84 on the indigo rows) and close to 0 when they have been blurred into flat grey. Without the `FLTEnableImpeller` key in `macos/Runner/Info.plist`, `ImageFilter.isShaderFilterSupported` returned `false` and the app rendered with Skia. With the key it returned `true`. That gave one Skia run and one Impeller run of the same code.

Here are the results for the variants discussed below, all on Impeller (contrast per row, measured from the top of the overlay):

| Variant | y=5 | y=75 | y=150 | y=220 | y=295 |
| --- | --- | --- | --- | --- | --- |
| No overlay | 1.00 | 0.84 | 1.00 | 0.84 | 1.00 |
| Uniform `BackdropFilter`, sigma 12 | 0.03 | 0.02 | 0.03 | 0.02 | 0.03 |
| `ShaderMask` + `BackdropFilter` (the question's code) | 1.00 | 0.84 | 1.00 | 0.84 | 1.00 |
| Same, with `blendMode: BlendMode.src` | 1.00 | 0.84 | 1.00 | 0.84 | 1.00 |
| 8 stepped bands | 0.05 | 0.07 | 0.46 | 0.79 | 1.00 |
| 16 stepped bands | 0.05 | 0.06 | 0.40 | 0.84 | 1.00 |
| Shader widget (final version below) | 0.07 | 0.05 | 0.37 | 0.84 | 1.00 |

The `ShaderMask` rows are pixel-identical to having no overlay at all. The Skia run gave the same result: the masked variant matched the unfiltered background row for row.

## Why ShaderMask over BackdropFilter erases the blur

`ShaderMask` works by drawing its child into a temporary buffer (a save layer) and then combining that buffer with the gradient shader using the blend mode you pass, usually `BlendMode.dstIn`. `BackdropFilter` filters "the existing painted content", and inside a save layer the existing content is the save layer itself. When the `BackdropFilter` runs, that buffer is still empty. So the filter blurs transparent pixels, the gradient fades transparent pixels, and the composited result is the untouched background. The [`BackdropFilter` API docs](https://api.flutter.dev/flutter/widgets/BackdropFilter-class.html) warn about this: `BlendMode.srcOver` "may produce surprising results when a parent of the BackdropFilter uses a temporary buffer, or save layer, as does an Opacity widget", and suggest `BlendMode.src` instead. In this case `BlendMode.src` changed nothing. The table above shows it still blurs nothing.

The stacked variant hit the same wall. It nested eight top-anchored `BackdropFilter` layers and gave each one a short `ShaderMask` fade at its bottom edge to hide the seams. On both renderers the output was identical to no overlay. Any ancestor that introduces a save layer (`ShaderMask`, `Opacity` below 1.0, `ColorFiltered`) cuts a `BackdropFilter` off from the content behind it.

There is a second, subtler problem with the "blur once, then mask the blur" idea from the question. Suppose it did composite correctly. At a mask alpha of `a`, each output pixel would be `a * blurred + (1 - a) * sharp`. A sharp edge then survives at `(1 - a)` of its original strength, so halfway down the gradient you see a 50% ghost of the crisp content over a fully blurred copy. A progressive blur needs the *radius* to shrink, so that edges soften gradually. No mask over a single uniform blur can produce that.

## Version 1: stepped BackdropFilter bands (every renderer)

The simplest real progressive blur splits the region into horizontal bands. Each band gets its own `ClipRect` and a uniform `BackdropFilter`, with the sigma decreasing from top to bottom. Nothing wraps the filters in a save layer, so each one reads the real background:

```dart
// Flutter 3.44.8, Dart 3.12.2 -- works on Skia, Impeller, and the web
import 'dart:ui' as ui;
import 'package:flutter/widgets.dart';

class BandedBlur extends StatelessWidget {
  const BandedBlur({super.key, this.maxSigma = 12, this.bands = 16});
  final double maxSigma;
  final int bands;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < bands; i++)
          Expanded(
            child: ClipRect(
              child: BackdropFilter(
                filter: ui.ImageFilter.blur(
                  sigmaX: maxSigma * (1 - (i + 0.5) / bands),
                  sigmaY: maxSigma * (1 - (i + 0.5) / bands),
                  tileMode: TileMode.mirror,
                ),
                child: const SizedBox.expand(),
              ),
            ),
          ),
      ],
    );
  }
}
```

Use it the way you would use the question's overlay: inside a `Stack`, positioned over the scrolling content, for example `Positioned(top: 0, left: 0, right: 0, height: 300, child: BandedBlur())`.

The overall curve comes out right, but every band is still a uniform blur, so its edges show. Here is the contrast measured row by row across the boundary between bands 5 and 6 of the 8-band version, which sits at y=187.5:

| y | 180 | 184 | 186 | 187 | 188 | 189 | 190 | 192 | 196 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 bands | 0.61 | 0.59 | 0.58 | 0.57 | 0.63 | 0.67 | 0.71 | 0.76 | 0.79 |
| 16 bands | 0.72 | 0.68 | 0.67 | 0.66 | 0.64 | 0.67 | 0.70 | 0.75 | 0.78 |
| Shader | 0.63 | 0.64 | 0.65 | 0.65 | 0.66 | 0.67 | 0.68 | 0.69 | 0.73 |

The bands make a sawtooth. Contrast drifts within each band, then jumps by 0.14 within three rows at the boundary. Over photos or text that shows up as faint horizontal lines. Doubling the band count makes each step smaller but costs raster time (see the performance section). The shader row rises smoothly.

Two related tricks don't fix the seams. Fading each band into the next with a `ShaderMask` fails for the reason explained above. `BackdropGroup` with `BackdropFilter.grouped` is meant for exactly this kind of non-overlapping set of filters: it let the engine share one backdrop read across the 16 bands and cut average raster time from 6.02 ms to 5.26 ms. The pixels changed a little (0.58 instead of 0.40 at y=150), but the seams stayed.

## Version 2: a variable-radius Gaussian with ImageFilter.shader (Impeller)

To get a truly progressive blur, the sigma has to vary per pixel, and only a custom filter can do that. [`ImageFilter.shader`](https://api.flutter.dev/flutter/dart-ui/ImageFilter/ImageFilter.shader.html) turns a [fragment shader](https://docs.flutter.dev/ui/design/graphics/fragment-shaders) into an image filter, and a `BackdropFilter` accepts it like any other filter. It has three requirements: Impeller only (it throws `UnsupportedError` on Skia, so check `ImageFilter.isShaderFilterSupported`), a `vec2` as the first uniform (the engine writes the input texture size into it), and at least one `sampler2D` (the engine binds the backdrop to the first one).

The steps:

1. Write a one-dimensional Gaussian shader whose sigma depends on the pixel's vertical position.
2. Register it under `flutter: shaders:` in `pubspec.yaml` and load it once with `FragmentProgram.fromAsset`.
3. Run it twice, as a horizontal pass and then a vertical pass, using two `BackdropFilter` widgets inside one `ClipRect`.
4. Pass the widget's on-screen rectangle into the shader so the fade lines up with the widget and the taps stay inside it.
5. Fall back to `BandedBlur` when `ImageFilter.isShaderFilterSupported` is `false`.

### The shader

```glsl
// shaders/progressive_blur.frag -- Flutter 3.44.8, Impeller only
#version 460 core
#include <flutter/runtime_effect.glsl>

uniform vec2 uSize;       // set by the engine: input texture size in pixels
uniform vec2 uDirection;  // (1, 0) horizontal pass, (0, 1) vertical pass
uniform float uMaxSigma;  // strongest blur, in logical pixels
uniform vec2 uViewSize;   // view size in logical pixels
uniform vec4 uRegion;     // blurred rect as LTRB fractions of the view
uniform sampler2D uTexture; // set by the engine: the backdrop

out vec4 fragColor;

const int kTaps = 24; // taps on each side of the center pixel

// Only read pixels inside the blurred rect. Outside the texture the sampler
// returns transparent pixels, and outside the rect the backdrop is still sharp
// (the other pass never touched it), so both would leak into the edges.
vec4 tap(vec2 uv) {
  vec2 halfTexel = 0.5 / uSize;
  return texture(uTexture, clamp(uv, uRegion.xy + halfTexel, uRegion.zw - halfTexel));
}

void main() {
  vec2 uv = FlutterFragCoord().xy / uSize;
#ifdef IMPELLER_TARGET_OPENGLES
  uv.y = 1.0 - uv.y;
#endif
  // 1 at the top edge of the rect, 0 at the bottom edge.
  float strength = 1.0 - smoothstep(uRegion.y, uRegion.w, uv.y);
  float sigma = uMaxSigma * strength * (uSize.y / uViewSize.y); // texture pixels
  if (sigma < 0.5) {
    fragColor = tap(uv);
    return;
  }
  float stepPx = (3.0 * sigma) / float(kTaps); // cover +/- 3 sigma
  vec2 stepUv = uDirection * stepPx / uSize;
  vec4 sum = tap(uv);
  float total = 1.0;
  for (int i = 1; i <= kTaps; i++) {
    float x = float(i) * stepPx;
    float w = exp(-(x * x) / (2.0 * sigma * sigma));
    sum += tap(uv + stepUv * float(i)) * w;
    sum += tap(uv - stepUv * float(i)) * w;
    total += 2.0 * w;
  }
  fragColor = sum / total;
}
```

```yaml
# pubspec.yaml
flutter:
  shaders:
    - shaders/progressive_blur.frag
```

Two details took measurement to get right.

**The input texture is the whole view, not the clipped area.** The first version computed the fade from `uv.y` with `0..1` mapped to the overlay. The output was blurred far too much, with the fade running across the full 600 px window. As captured here, the engine bound the entire backdrop as `uTexture` and set `uSize` to its size. That is why the shader takes the region as fractions of the view and derives the logical-to-texture scale from `uSize.y / uViewSize.y`. It also keeps the shader correct at any device pixel ratio, since sigma is given in logical pixels.

**Taps must be clamped to the region.** Before the clamp, moving the overlay down to y=150 left its first rows sharp: the contrast at y=150 was 0.51 instead of 0.07. The vertical pass was averaging rows from above the clip, where the horizontal pass never ran. With the clamp to `uRegion`, the top row measured 0.07 and the whole profile matched the overlay-at-the-top case shifted by 150 px.

The OpenGL ES y-flip comes straight from the `ImageFilter.shader` documentation. It matters on Android devices where Impeller falls back to GLES. It was not exercised in this test, which ran on Metal.

### The widget

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'dart:ui' as ui;
import 'package:flutter/widgets.dart';

class ProgressiveBlur extends StatefulWidget {
  const ProgressiveBlur({
    super.key,
    required this.program,
    this.maxSigma = 12,
    this.child,
  });

  /// await ui.FragmentProgram.fromAsset('shaders/progressive_blur.frag')
  final ui.FragmentProgram program;
  final double maxSigma; // logical pixels
  final Widget? child;

  @override
  State<ProgressiveBlur> createState() => _ProgressiveBlurState();
}

class _ProgressiveBlurState extends State<ProgressiveBlur> {
  late final ui.FragmentShader _horizontal = widget.program.fragmentShader();
  late final ui.FragmentShader _vertical = widget.program.fragmentShader();
  // Global bounds of this widget, refreshed after layout.
  Rect _rect = Rect.zero;

  @override
  void dispose() {
    _horizontal.dispose();
    _vertical.dispose();
    super.dispose();
  }

  void _syncRect() {
    if (!mounted) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final rect = box.localToGlobal(Offset.zero) & box.size;
    if (rect != _rect) setState(() => _rect = rect);
  }

  void _configure(ui.FragmentShader s, double dx, double dy, Size view) {
    // Floats 0 and 1 are uSize; the engine writes them.
    s
      ..setFloat(2, dx)
      ..setFloat(3, dy)
      ..setFloat(4, widget.maxSigma)
      ..setFloat(5, view.width)
      ..setFloat(6, view.height)
      ..setFloat(7, _rect.left / view.width)
      ..setFloat(8, _rect.top / view.height)
      ..setFloat(9, _rect.right / view.width)
      ..setFloat(10, _rect.bottom / view.height);
  }

  @override
  Widget build(BuildContext context) {
    final child = widget.child ?? const SizedBox.expand();
    if (!ui.ImageFilter.isShaderFilterSupported) {
      // Skia, the web, or Impeller turned off.
      return Stack(fit: StackFit.expand, children: [
        BandedBlur(maxSigma: widget.maxSigma, bands: 16),
        child,
      ]);
    }
    // The shader needs this widget's position in the view, which is only
    // known after layout. Read it after the frame and rebuild if it moved.
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncRect());
    if (_rect.isEmpty) return child; // first frame: position not known yet
    final view = MediaQuery.sizeOf(context);
    _configure(_horizontal, 1, 0, view);
    _configure(_vertical, 0, 1, view);
    return ClipRect(
      child: Stack(
        fit: StackFit.expand,
        children: [
          // Two backdrop filters, not ImageFilter.compose (see below).
          BackdropFilter(
            filter: ui.ImageFilter.shader(_horizontal),
            child: const SizedBox.expand(),
          ),
          BackdropFilter(
            filter: ui.ImageFilter.shader(_vertical),
            child: child,
          ),
        ],
      ),
    );
  }
}
```

Load the program once at startup and then place the widget wherever the overlay goes:

```dart
// Flutter 3.44.8
late final ui.FragmentProgram blurProgram;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  blurProgram = await ui.FragmentProgram.fromAsset('shaders/progressive_blur.frag');
  runApp(const MyApp());
}

// ...inside a Stack over your feed:
Positioned(
  top: 0,
  left: 0,
  right: 0,
  height: 300,
  child: ProgressiveBlur(program: blurProgram, maxSigma: 12),
),
```

The second `BackdropFilter` reads the output of the first, so the two 1D passes combine into a 2D Gaussian. Put a translucent tint (the `Colors.white.withValues(alpha: 0.05)` container from the question, updated for [the `withOpacity` deprecation](/2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues/)) in `child`. Painting it there means it lands on top of the blur.

### Why not ImageFilter.compose

The obvious way to chain the passes is a single filter, `ImageFilter.compose(outer: ImageFilter.shader(vertical), inner: ImageFilter.shader(horizontal))`. It mostly worked, but the top of the view stayed partly sharp. Contrast was 0.51 at row 0, 0.37 at row 5, and only reached the expected 0.07 about 30 rows down. A single horizontal pass on its own measured 0.07 from row 0, and two separate `BackdropFilter` widgets did the same. The likely cause is that the composed outer filter gets an input texture whose size or origin differs from the full view, which breaks the coordinate assumptions above. This post did not dig further. Two backdrop filters inside one `ClipRect` avoid the issue, and on this machine they cost no measurable extra raster time.

## What it costs per frame

Every variant ran in `flutter drive --profile` on macOS 27.0.1 with an Apple M4 at 120 Hz. The test scrolled the striped feed 6000 px down and back four times while `SchedulerBinding.addTimingsCallback` collected `FrameTiming` values, about 2,940 frames per run:

| Variant | Raster avg (ms) | Raster p90 (ms) | Raster p99 (ms) |
| --- | --- | --- | --- |
| No overlay | 1.15 | 1.80 | 2.12 |
| Uniform blur | 1.44 | 2.35 | 2.66 |
| 8 bands | 2.97 | 3.56 | 4.48 |
| 16 bands | 6.02 | 6.46 | 6.74 |
| 16 bands, `BackdropGroup` | 5.26 | 5.79 | 6.28 |
| Shader widget (2 passes) | 1.40 | 2.22 | 2.53 |
| Shader via `ImageFilter.compose` | 1.37 | 2.20 | 2.46 |

Read these numbers with their limits in mind. `FrameTiming.rasterDuration` measures raster-thread time, mostly the CPU cost of recording and submitting GPU work. It does not include the time the M4's GPU spends running the shader's 49 taps per pass. Every variant held 120 Hz with no dropped frames on this Mac, which says nothing about a mid-range Android phone. What the numbers do show is that band count drives the CPU cost: each band is its own backdrop read and render pass, so 16 bands cost about four times as much as the two-pass shader. Measure GPU time on your target devices with the DevTools performance view (see [profiling jank in a Flutter app with DevTools](/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/)) before choosing a band count or `kTaps`.

The asker's 30 to 40 FPS shader most likely came from a single-pass 2D kernel. A 2D Gaussian with 49 taps per axis reads 49 x 49 = 2,401 pixels per output pixel, while two separable passes read 2 x 49 = 98. If the shader is still too heavy, lower `kTaps`, cap `maxSigma`, or shrink the blurred area. The cost scales with every one of them.

## Gotchas

- **Impeller availability.** On Flutter 3.44.8 macOS still defaulted to Skia, and `isShaderFilterSupported` was `false` until `FLTEnableImpeller` was set. [Flutter 3.47 made Impeller the default on desktop](/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/). iOS uses Impeller by default. On Android it is the default where supported, with an OpenGL ES fallback, which is why the shader keeps the y-flip. On the web (either renderer, see [CanvasKit vs skwasm](/2026/09/canvaskit-vs-skwasm-for-flutter-web-in-2026/)) the code path was not tested here, so rely on the `isShaderFilterSupported` check and the banded fallback rather than assuming shader filters work.
- **The rect is one frame late.** The widget reads its global position after layout. That is fine for pinned bars and sheets. An overlay that moves every frame, such as one inside a scrolling list, will draw its fade one frame behind. In that case, compute the rect from the scroll offset you already know, or pass it in from the parent.
- **No save-layer ancestors.** The `BackdropFilter`s in both versions need a direct path to the content behind them. An `Opacity`, `ShaderMask`, or `ColorFiltered` ancestor breaks them exactly as in the question. Animate the tint color in `child` instead of fading the whole widget with `Opacity`.
- **Fade direction and shape.** The shader fades from the top edge to the bottom edge with `smoothstep`. For a bottom bar, flip the `strength` expression. For a fade that covers only part of the widget, map `uv.y` through two extra uniforms before the `smoothstep`.
- **Reproducing the measurements on macOS.** The integration test writes its captures to disk, which needs the app sandbox disabled in the Debug and Release entitlements. Running `flutter test integration_test -d macos` on Xcode 27 also requires [raising `MACOSX_DEPLOYMENT_TARGET` to 12.0](/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

## Sources

- [`ImageFilter.shader` API reference](https://api.flutter.dev/flutter/dart-ui/ImageFilter/ImageFilter.shader.html) (uniform requirements, Impeller-only, GLES y-flip)
- [Writing and using fragment shaders](https://docs.flutter.dev/ui/design/graphics/fragment-shaders) (Flutter docs)
- [`BackdropFilter` class](https://api.flutter.dev/flutter/widgets/BackdropFilter-class.html) (save layer caveat, `BackdropGroup` and `BackdropKey`)
- [Stack Overflow: progressive blur with BackdropFilter and ShaderMask](https://stackoverflow.com/questions/79942651)
