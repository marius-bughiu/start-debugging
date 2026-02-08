---
title: "Fix Xamarin error – Csc.exe exited with code -1073741790. (MSB6006)"
description: "Fix the Xamarin Csc.exe MSB6006 error by running as Administrator or cleaning the solution bin and obj folders."
pubDate: 2015-08-28
updatedDate: 2023-11-05
tags:
  - "xamarin"
---
Just run Xamarin Studio as an Administrator.

The error usually means that the process cannot access a certain resource. In my case that meant insufficient rights; but it could also mean that some file is already in use; in that case – Clean the solution & Rebuild and if that doesn't work either, do a manual cleanup of the solution by deleting the "bin" and "obj" folders for every project in your solution.
