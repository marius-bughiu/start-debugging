---
title: "Use your Android phone as a webcam for Streamlabs"
description: "Use an Android phone as a webcam in Streamlabs Desktop on Windows, with current DroidCam download guidance and clearly labelled classic screenshots."
pubDate: 2019-04-30
updatedDate: 2026-11-02
tags:
  - "android"
---

An Android phone with a working camera can provide the camera input for a Streamlabs scene. Image quality depends on the phone, lighting, connection, and app settings; an old phone is not automatically better than a dedicated webcam.

## Choose the matching app and desktop client

The screenshots below show **DroidCam Classic and the older Streamlabs OBS interface on Windows**. The original Android package, `com.dev47apps.droidcam`, returned 404 in checks using US, Romanian, and German Google Play region parameters on 2 November 2026. Those checks do not prove worldwide removal or availability for every existing account/device.

For a new installation, the publisher currently links [DroidCam Webcam & OBS Camera by Dev47Apps](https://play.google.com/store/apps/details?id=com.dev47apps.obsdroidcam), package `com.dev47apps.obsdroidcam`, from [droidcam.app](https://droidcam.app/). This is a different Android app, not a renamed link to the classic listing. The [official FAQ](https://droidcam.app/help/) says the new Android app/client and the classic app/client are separate. Pair the matching versions; the classic screenshots are not instructions for the new interface.

The workflow here is for **Windows**. The [current DroidCam Windows client](https://droidcam.app/windows/) supports Windows 10/11, while your Streamlabs version must also meet its [own system requirements](https://streamlabs.com/content-hub/post/streamlabs-desktop-system-requirements). A DroidCam Linux client does not make this a Linux Streamlabs Desktop tutorial. macOS/OBS Studio plugin setups are separate; an OBS Studio plugin is not interchangeable with a Streamlabs source.

## Current Windows setup

1. Install the current Dev47Apps Android app from the verified listing above and grant the camera permissions it requests. Enable microphone access only if you plan to use phone audio.
2. Install the matching Windows client from the [official download/setup page](https://droidcam.app/windows/).
3. Put the phone and computer on the same network. Open the phone app, then in the client choose **Add > DroidCam** and refresh the device list. Select the phone and connect. For USB or discovery problems, follow the publisher's setup/help pages.
4. Reopen Streamlabs Desktop after installing the webcam driver. Following its [source setup guide](https://streamlabs.com/content-hub/post/quick-start-guide-setting-up-streamlabs-desktop-for-streaming), add **Video Capture Device**, then select the camera exposed by the client. The current Windows guide calls it **DroidCam Video**; older classic installations may show **DroidCam Source 2/3**.
5. Check the preview, resize the source in the scene, and make a short test recording. Check audio separately if enabled; successful video does not guarantee correct microphone routing.

## Classic Windows walkthrough: archived screenshots

These images preserve the original walkthrough for readers who already have the matching classic app and client. In the [classic connection guide](https://www.dev47apps.com/droidcam/connect/), the phone and computer share a network, and the desktop client uses the phone's displayed Wi-Fi IP and port. Classic Windows downloads remain documented on the [publisher's classic client page](https://www.dev47apps.com/droidcam/windows/).

The classic Android app displays the connection address.

![DroidCam on Android showing the Wi-Fi IP address and port needed to connect the desktop client.](/wp-content/uploads/2019/04/image-7.png)

Enter that address and port in the classic Windows client.

![DroidCam Client Wi-Fi connection dialog with the device IP and port filled in and Video and Audio enabled.](/wp-content/uploads/2019/04/image-8.png)

Start the connection and check the camera preview.

![DroidCam Client displaying the connected phone camera feed.](/wp-content/uploads/2019/04/image-9.png)

The historical Streamlabs interface adds a Video Capture Device source.

![Streamlabs Add Source dialog with Video Capture Device underlined.](/wp-content/uploads/2019/04/image-5-1024x555.png)

This installation used DroidCam Source 3; use the device your installed client exposes.

![Streamlabs Video Capture Device settings with DroidCam Source 3 selected and a live camera preview.](/wp-content/uploads/2019/04/image-10.png)

Place and resize the camera overlay within the scene.

![Streamlabs scene with the phone camera feed placed as a small overlay in the lower-right corner of the desktop capture.](/wp-content/uploads/2019/04/image-11-1024x555.png)

A stable phone mount near eye level makes framing easier. Choose one that fits your device; the old Huawei AF14 mention was a personal purchase, not a current availability or price recommendation.

For another scene element, see the [Streamlabs polls walkthrough](/2020/08/polls-for-streamlabs-interact-with-your-viewers/).

**Correction, 2 November 2026:** separated classic and current DroidCam identities, replaced the unavailable classic listing with explicitly labelled current download guidance, and restricted the Streamlabs walkthrough to Windows. Links and vendor instructions were checked; no phone/Windows hardware test was performed for this update.
