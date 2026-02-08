---
title: "Use your Android phone as a webcam for Streamlabs"
description: "Need a webcam to use for streaming? Why not use one of the broken/outdated phones you currently have lying around the house? Most phones are capable of taking pictures and recording at a higher resolution and with a better quality than your typical webcam. This makes them an ideal replacement for a webcam when streaming,…"
pubDate: 2019-04-30
updatedDate: 2020-08-06
tags:
  - "android"
---
Need a webcam to use for streaming? Why not use one of the broken/outdated phones you currently have lying around the house?  

Most phones are capable of taking pictures and recording at a higher resolution and with a better quality than your typical webcam. This makes them an ideal replacement for a webcam when streaming, especially when you have one just lying around.

I recently ended up with a [Google Pixel 2 XL](https://amzn.to/2XYg9bP) with a defective screen. Long story short, I cracked the screen, replaced it and 8 months later the replacement screen failed. And because of the cost and lack of warranty I decided to draw the line and not replace the screen again. So I ended up with a defect smartphone but with a perfectly functioning awesome camera.

So let’s get started. To use your Android phone as a webcam you will need two things:

-   [DroidCam Wireless Webcam](https://play.google.com/store/apps/details?id=com.dev47apps.droidcam) for Android
-   and the Windows or Linux client app which you can [download from here](http://www.dev47apps.com/)

First, download and install the app on your Android phone. Once installed, go through the setup wizard, give the app the required permissions (to record audio and video) and you’re done. The app should now display information like the IP address and port on which it’s streaming the video. Keep that handy, we’ll need it in the next step.

![](/wp-content/uploads/2019/04/image-7.png)

Next, you need to download and install the client for Windows or Linux. Once you’re done installing launch the app and fill in the IP address and port number just as they show up in the Android application.

![](/wp-content/uploads/2019/04/image-8.png)

When you’re ready, hit Start. And voila, your brand new webcam!

![](/wp-content/uploads/2019/04/image-9.png)

Final step is adding the video source into Streamlabs. To do so, open up Streamlabs OBS and click + to add a new Source.

![](/wp-content/uploads/2019/04/image-5-1024x555.png)

In the popup that opens select Video Capture Device and click Add Source. In the next screen just click Add New Source. Now you get to play with the settings for the device. First, select the DroidCam from the Device dropdown – in my case it’s called DroidCam Srouce. Then play around with the setting until you get the desired result; for me the defaults worked just fine. When you’re finished, click Done.

![](/wp-content/uploads/2019/04/image-10.png)

Now you get to drag the video source around your scene and resize it as you want. Once you’re ready, you can start streaming.

![](/wp-content/uploads/2019/04/image-11-1024x555.png)

## Tip

One of the problems when using phones as webcams is getting them to sit in a steady position, preferably at a certain height and angle. You can solve this problem using a smartphone tripod.

I ended up going with a Huawei AF14 as it was the cheapest option that fit my needs. Once you get the tripod, set it up at an angle that suits you and at a height close to your eye level.
