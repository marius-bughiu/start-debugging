---
title: "Windows 8 und Secure Boot - Was, wenn Ihr PC es nicht unterstützt?"
description: "Was Sie tun, wenn beim Installieren von Windows 8 die Meldung 'Secure Boot isn't compatible with your PC' erscheint, und was Secure Boot eigentlich ist."
pubDate: 2012-06-05
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "de"
translationOf: "2012/06/windows-8-and-secure-boot-what-if-your-pc-doesnt-support-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
Heute, als ich (versehentlich) versuchte, mein Windows 7 auf Windows 8 zu aktualisieren, stieß ich auf eine Kompatibilitätsprüfung mit 6 Fehlern, darunter einer, der besagt:

> Secure Boot isn't compatible with your PC

Zuerst hat es mich erschreckt, weil ich dachte, ich könne Windows 8 nicht installieren, obwohl die Consumer Preview problemlos lief (mit ein paar Ausnahmen), aber nach ein paar Suchen war klar, dass das überhaupt kein Problem ist. Secure Boot ist ein Feature, das Sie einfach überspringen können, und alles wird trotzdem laufen.

**Was genau ist Secure Boot?**

Secure Boot ist ein neuer Boot-Prozess (Measured Boot), der zusammen mit UEFI 2.3.1 (Unified Extensible Firmware Interface) eine bestehende Sicherheitslücke im aktuellen BIOS-Design adressiert, durch die schädliche Software vor dem Betriebssystem geladen werden kann. Das geschieht über Zertifikate -- es wird nichts geladen, was nicht von Microsoft signiert ist, was bedeutet: keine Malware.

Dieses Feature ist nur auf vergleichsweise neuen Systemen verfügbar, weil es einen Chip namens Trusted Platform Module (TPM) voraussetzt. Dieser Chip speichert die signierten, geschützten und gemessenen Startprozesse, auf denen Secure Boot beruht.

Also ohne TPM kein Secure Boot, sondern der normale -- das heißt, das hindert Sie nicht daran, Windows 8 auf Ihrem Rechner zu installieren.
