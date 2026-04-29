---
title: "SBOM für .NET in Docker: hören Sie auf, ein einziges Werkzeug alles sehen zu lassen"
description: "Wie Sie NuGet-Abhängigkeiten und OS-Pakete des Containers für ein .NET-Docker-Image mit CycloneDX, Syft und Dependency-Track verfolgen -- und warum ein einzelnes SBOM nicht ausreicht."
pubDate: 2026-01-10
tags:
  - "docker"
  - "dotnet"
lang: "de"
translationOf: "2026/01/sbom-for-net-in-docker-stop-trying-to-force-one-tool-to-see-everything"
translatedBy: "claude"
translationDate: 2026-04-30
---
Ein DevOps-Thread stellte eine Frage, die ich immer wieder sehe: "Wie verfolge ich sowohl NuGet-Abhängigkeiten als auch OS-Pakete des Containers für eine .NET-App, die als Docker-Image ausgeliefert wird?" Der Autor war schon nahe am richtigen Ansatz: CycloneDX für den .NET-Projektgraph, Syft für das Image und dann Ingestion in Dependency-Track.

Quelle: [Reddit-Thread](https://www.reddit.com/r/devops/comments/1q8erp9/sbom_generation_for_a_net_app_in_a_container/).

## Ein einzelnes SBOM ist oft das falsche Ziel

Ein Container-Image enthält mindestens zwei Abhängigkeitsuniversen:

-   Anwendungsabhängigkeiten: zur Build-Zeit aufgelöste NuGet-Pakete (Ihre `*.deps.json`-Welt).
-   Image-Abhängigkeiten: OS-Pakete und Schichten des Basis-Images (Ihre Welt aus `apt`, `apk`, libc, OpenSSL).

Unter .NET 9 und .NET 10 kann jede der beiden Seiten versehentlich verschwinden:

-   Image-Scanner können NuGet-Versionen übersehen, weil sie den Projektgraph nicht lesen.
-   SBOM-Werkzeuge auf Anwendungsebene sehen die OS-Pakete des Basis-Images nicht, weil sie keine Schichten scannen.

Deshalb endet "ein Werkzeug soll alles können" meist mit blinden Flecken.

## Erzeugen Sie zwei SBOMs und bewahren Sie die Herkunft

Das ist die praktische Pipeline:

-   **SBOM A** (Anwendungsebene): zur Build-Zeit aus der Solution oder dem Projekt erzeugen.
    -   Werkzeug: [cyclonedx-dotnet](https://github.com/CycloneDX/cyclonedx-dotnet)
-   **SBOM B** (Image-Ebene): aus dem gebauten Image erzeugen.
    -   Werkzeug: [Syft](https://github.com/anchore/syft)
-   **Ingestion und Monitoring**: beide in [Dependency-Track](https://dependencytrack.org/) hochladen.

Der Schlüssel ist die Herkunft. Sie wollen die Frage beantworten können: "Steckt diese CVE in meinem Basis-Image oder in meinem NuGet-Graph?" -- ohne zu raten.

## Minimale Befehle, die Sie in einen CI-Job einfügen können

```bash
# App SBOM (NuGet focused)
dotnet tool install --global CycloneDX
dotnet CycloneDX .\MyApp.sln -o .\sbom --json

# Image SBOM (OS packages and what the image reveals)
docker build -t myapp:ci .
syft myapp:ci -o cyclonedx-json=.\sbom\container.cdx.json
```

Wenn das Anwendungs-SBOM das widerspiegeln soll, was tatsächlich ausgeliefert wird, erzeugen Sie es aus demselben Commit, der das Container-Image hervorgebracht hat, und legen Sie beide Artefakte gemeinsam ab.

## Sollten Sie die BOMs zusammenführen?

Wenn Ihre Hauptfrage "Sollte ich diese BOMs zu einem zusammenführen?" lautet, ist meine Standardantwort: nicht standardmäßig zusammenführen.

-   Halten Sie sie getrennt, damit Alarme handlungsrelevant bleiben.
-   Wenn Sie einen einzelnen Compliance-Bericht brauchen, führen Sie auf der Berichtsebene zusammen, nicht indem Sie die Herkunft im SBOM selbst plattmachen.

In Dependency-Track werden daraus oft zwei Projekte: `myapp` und `myapp-image`. Das ist keine zusätzliche Komplexität. Es ist ein saubereres Modell.

## Warum Syft "NuGet übersieht" und was zu tun ist

Syft ist stark bei Images und Dateisystemen. Es meldet, was es aus dem identifizieren kann, was es sieht. Wenn Sie verbindliche NuGet-Abhängigkeiten wollen, erzeugen Sie sie mit dem CycloneDX-Werkzeug aus dem Projektgraphen.

Sie können probieren, die veröffentlichte Ausgabe zu scannen (zum Beispiel `syft dir:publish/`), aber behandeln Sie das als Ergänzung. Die Frage "welche Pakete haben wir referenziert und in welchen Versionen?" gehört zum Build-Graphen, nicht zu einem Schicht-Scan.

Wenn Sie .NET-10-Dienste in Containern bauen, sind zwei SBOMs die ehrliche Antwort. Sie bekommen bessere Abdeckung, klarere Verantwortlichkeit und weniger Falschmeldungen, die einen Sprint kosten.
