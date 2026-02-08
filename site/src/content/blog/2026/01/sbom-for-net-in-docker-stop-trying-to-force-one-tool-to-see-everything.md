---
title: "SBOM for .NET in Docker: stop trying to force one tool to see everything"
description: "How to track NuGet dependencies and container OS packages for a .NET Docker image using CycloneDX, Syft, and Dependency-Track -- and why one SBOM is not enough."
pubDate: 2026-01-10
tags:
  - "docker"
  - "net"
---
A DevOps thread asked a question I keep seeing: “How do I track both NuGet dependencies and container OS packages for a .NET app shipped as a Docker image?” The author was already close to the right approach: CycloneDX for the .NET project graph, Syft for the image, then ingestion in Dependency-Track.

Source: [Reddit thread](https://www.reddit.com/r/devops/comments/1q8erp9/sbom_generation_for_a_net_app_in_a_container/).

## One SBOM is often the wrong target

A container image contains at least two dependency universes:

-   Application dependencies: NuGet packages resolved at build time (your `*.deps.json` world).
-   Image dependencies: OS packages and base image layers (your `apt`, `apk`, libc, OpenSSL world).

On .NET 9 and .NET 10, you can make either side disappear accidentally:

-   Image scanners can miss NuGet versions because they are not reading the project graph.
-   App-level SBOM tools won’t see the base image’s OS packages because they are not scanning layers.

That’s why “make one tool do everything” usually ends in blind spots.

## Generate two SBOMs and keep provenance

This is the practical pipeline:

-   **SBOM A** (app-level): generate from the solution or project at build time.
    -   Tooling: [cyclonedx-dotnet](https://github.com/CycloneDX/cyclonedx-dotnet)
-   **SBOM B** (image-level): generate from the built image.
    -   Tooling: [Syft](https://github.com/anchore/syft)
-   **Ingest and monitor**: upload both to [Dependency-Track](https://dependencytrack.org/).

The key is provenance. You want to be able to answer: “Is this CVE in my base image or in my NuGet graph?” without guesswork.

## Minimal commands you can paste into a CI job

```bash
# App SBOM (NuGet focused)
dotnet tool install --global CycloneDX
dotnet CycloneDX .\MyApp.sln -o .\sbom --json

# Image SBOM (OS packages and what the image reveals)
docker build -t myapp:ci .
syft myapp:ci -o cyclonedx-json=.\sbom\container.cdx.json
```

If you want the app SBOM to match what actually ships, generate it from the same commit that produced the container image and store both artifacts together.

## Should you merge the BOMs?

If your main question is “Should I merge these BOMs into one?”, my default answer is: don’t merge by default.

-   Keep them separate so alerts stay actionable.
-   If you need a single compliance report, merge at the reporting layer, not by flattening away provenance in the SBOM itself.

In Dependency-Track, this often becomes two projects: `myapp` and `myapp-image`. It’s not extra complexity. It’s a cleaner model.

## Why Syft “misses NuGet” and what to do about it

Syft is strong at images and filesystems. It reports what it can identify from what it can see. If you want authoritative NuGet dependencies, generate from the project graph with CycloneDX tooling.

You can experiment with scanning the published output (for example `syft dir:publish/`), but treat that as a supplement. The “what packages did we reference and at what versions?” question belongs to the build graph, not to a layer scan.

If you’re building .NET 10 services in containers, two SBOMs is the honest answer. You get better coverage, clearer ownership, and fewer false positives that waste a sprint.
