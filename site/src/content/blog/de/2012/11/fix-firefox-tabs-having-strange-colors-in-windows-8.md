---
title: "Seltsame Farben in Firefox-Tabs unter Windows 8 beheben"
description: "So beheben Sie den Firefox-Tab-Farb-Glitch unter Windows 8 auf nVidia-Grafikkarten, indem Sie die Hardwarebeschleunigung deaktivieren."
pubDate: 2012-11-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "de"
translationOf: "2012/11/fix-firefox-tabs-having-strange-colors-in-windows-8"
translatedBy: "claude"
translationDate: 2026-05-01
---
Dieser Grafik-Glitch ist ein bekannter Bug in Firefox unter Windows 8. Er scheint nur auf Maschinen mit nVidia-Grafikkarten aufzutreten und wird durch die Hardwarebeschleunigung des Browsers verursacht.

Die Lösung ist einfach -- **Hardwarebeschleunigung deaktivieren** im Einstellungsmenü Ihres Browsers. Die seltsamen Farben verschwinden -- und leider auch die Hardwarebeschleunigung Ihres Browsers. Aber mehr können wir nicht tun, bis der Bug behoben ist.

Sie können das Issue auf bugzilla hier verfolgen: [https://bugzilla.mozilla.org/show_bug.cgi?id=686782](https://bugzilla.mozilla.org/show_bug.cgi?id=686782)

Und falls Sie die Einstellung nicht finden: Öffnen Sie das Optionen-Fenster (Firefox > Options oder Tools > Options) > Advanced > General. Dort die Checkbox "Use hardware acceleration when available" deaktivieren. Das war's.

Update: 8 Jahre später, ich aktualisiere das aus SEO-Gründen; der Bug ist nicht behoben, aber hey... wer nutzt heute noch Windows 8?
