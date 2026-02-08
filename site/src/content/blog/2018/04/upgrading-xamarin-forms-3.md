---
title: "Upgrading to Xamarin Forms 3"
description: "A quick guide to upgrading to Xamarin Forms 3, including common build errors and how to fix them."
pubDate: 2018-04-07
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
---
Upgrading between major versions of Xamarin tends to break stuff and lead to projects no longer building due to weird errors. In their innocence, most devs will take these errors for real, try to understand them, to fix them and when they fail, they will Google them; when most of the times, the fix is to close Visual Studio, open it back up, and then do a clean build of your solution. Now let's have a look at Xamarin Forms 3 (bear in mind this is a pre-release version, so these might be solved by the time of the actual release).

Open up your existing project, or create a new Master Detail project using .NET Standard. Build your project, see that it runs. Now go ahead and manage the NuGet packages for your solution. If you're working with a pre-release version like I am, tick the "Include prerelease" box.

Select all packages and Update. If you try a build now, you should be getting some errors about GenerateJavaStubs failing and the XamlFiles parameter not being supported by the XamlGTask. Ignore them, close Visual Studio (VS might throw an error about some task being cancelled; ignore that too), open VS back up again, clean your solution and rebuild -- you know, like a true developer.

After this, if you're working with a new project & building for Android, you're getting the Java max heap size error.

Go to properties in your Android project, choose Android Options and click on Advanced at the bottom. Then type in "1G" for the Java Max Heap Size option. I wonder when they will decide to make this a default in new projects...

Build again, and voila! It's working now.
