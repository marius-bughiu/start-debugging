---
title: "Flutter Text: the `leadingDistribution` detail that changes how your UI “breathes”"
description: "A Flutter tutorial video published on 2026-01-16 reminded me of a subtle but very real source of “why does this look off?” bugs: the Text widget is simple until you start combining custom fonts, tight line heights, and multi-line layouts. Source: Video and the original r/FlutterDev post. Line height is not just TextStyle.height On Flutter…"
pubDate: 2026-01-18
tags:
  - "dart"
  - "flutter"
---
A Flutter tutorial video published on 2026-01-16 reminded me of a subtle but very real source of “why does this look off?” bugs: the `Text` widget is simple until you start combining custom fonts, tight line heights, and multi-line layouts.

Source: [Video](https://www.youtube.com/watch?v=xen-Al9H-4k) and the original [r/FlutterDev post](https://www.reddit.com/r/FlutterDev/comments/1qfhug1/how_well_do_you_really_know_the_text_widget/).

## Line height is not just `TextStyle.height`

On Flutter 3.x, developers often tweak:

-   `TextStyle(height: ...)` to tighten or loosen lines
-   `TextHeightBehavior(...)` to control how leading is applied

If you only set `height`, you can still end up with text that looks vertically “miscentered” in a `Row`, or headings that feel too airy compared to body text. This is where `leadingDistribution` comes in.

`leadingDistribution` controls how the extra leading (the space added by line height) is distributed above and below the glyphs. The default is not always what you want for UI typography.

## A small widget that makes the difference obvious

Here is a minimal snippet you can drop into a screen and compare visually:

```dart
import 'package:flutter/material.dart';

class LeadingDistributionDemo extends StatelessWidget {
  const LeadingDistributionDemo({super.key});

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(
      fontSize: 20,
      height: 1.1, // intentionally tight so leading behavior is visible
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: const [
        Text('Default leadingDistribution', style: style),
        SizedBox(height: 8),
        Text(
          'Even leadingDistribution\n(two lines to show it)',
          style: style,
          textHeightBehavior: TextHeightBehavior(
            leadingDistribution: TextLeadingDistribution.even,
          ),
        ),
      ],
    );
  }
}
```

When you see the two blocks side by side, you can usually spot it immediately on real fonts: one block sits “better” in its vertical space, especially when you align it with icons or when you cap the height of a container.

## Where this bites in real apps

This detail tends to show up in the parts of Flutter apps that are hardest to keep pixel-clean:

-   **Buttons and chips**: label text looks too low or too high relative to the container.
-   **Cards with mixed content**: a heading + subheading stack does not feel evenly spaced.
-   **Custom fonts**: ascent/descent metrics vary a lot between typefaces.
-   **Internationalization**: scripts with different glyph metrics expose spacing assumptions.

The fix is not “always set `leadingDistribution`”. The fix is: when you do typography cleanup, include `TextHeightBehavior` in your mental model, not just `fontSize` and `height`.

If your Flutter 3.x UI is 95% there but still feels slightly off, this is one of the first knobs I check.
