---
title: "Lighthouse report: Defer offscreen images in WordPress"
description: "Improve your WordPress site's Lighthouse performance score by deferring offscreen images with lazy loading."
pubDate: 2019-05-01
updatedDate: 2023-11-05
tags:
  - "lighthouse"
---
One of the most important things when it comes to perceived performance is how fast a web page loads when it’s first accessed, and one of the key things in having a fast-loading web page is to only load what’s necessary, when necessary.

Of course, this might sound like a lot of work, but there are some low hanging fruits when it comes to this, especially when we look at images. Images usually take up the most bandwidth when loading a website and traditionally, you just load everything.

There are several disadvantages to doing that:

-   You are using resources for something that the user might never even see.
-   There’s possible cost implications for both the user and you. The user could be on a mobile, metered connection, while you might be hosting in the cloud and paying for outgoing bandwidth.
-   Poor user experience and perceived performance because you’re downloading and processing useless (out of view) content instead of focusing on what’s in view.
-   The previous one can also lead to page ranking penalties being applied by Google, as Google will favor more responsive web pages.

The solution: defer and load images only when they come into view. And because I’ve mentioned it’s a low hanging fruit – there’s a plugin for doing just that: [Lazy Load Optimizer](https://wordpress.org/support/plugin/lazy-load-optimizer/).

Just add it to your WordPress site and you’re done. Now when users will access your web page they will only download the images found inside their view. All other images will be lazy loaded only as the user scrolls through.

This one thing alone bumped the performance rating of the blog by 20 points, from 41 to 61. Let’s see where we go next.

## Troubleshooting

I personally had some troubles after installing the plugin with a couple of images blowing up like so:

![](/wp-content/uploads/2019/04/image-6-1024x490.png)

This was because of some hardcoded styling I had on the img tags themselves, which is anyways considered bad practice. I’ve moved everything in a couple of CSS classes that load up separately and now everything is fine.
