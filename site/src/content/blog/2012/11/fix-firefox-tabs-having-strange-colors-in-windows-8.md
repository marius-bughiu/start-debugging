---
title: "FIX: Firefox tabs having strange colors in Windows 8"
description: "This graphics glitch is a known bug in Firefox running on Windows 8. It appears to manifest only on machines that run on nVidia graphics cards and it is caused by the browser using hardware acceleration. The fix is simple – disable hardware acceleration from your browser’s settings menu. The strange colors will be gone…"
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
---
This graphics glitch is a known bug in Firefox running on Windows 8. It appears to manifest only on machines that run on nVidia graphics cards and it is caused by the browser using hardware acceleration.

The fix is simple – **disable hardware acceleration** from your browser’s settings menu. The strange colors will be gone – and so will be your browser’s hardware acceleration unfortunately. But that’s all we can do until the bug gets fixed.

You can track the issue on bugzilla here: [https://bugzilla.mozilla.org/show\_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

And just in case you can’t find the menu where to disable hardware acceleration: open the options window (Firefox – Options or Tools – Options) – Advanced – General . Once there, uncheck the ‘Use hardware acceleration when available’ checkbox. That’s it.

Update: 8 years later, updating this for SEO, the bug isn’t fixed, but hey… who’s still using Windows 8 anyways?
