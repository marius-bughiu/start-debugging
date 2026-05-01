---
title: "Wie Sie Windows 8 von einem USB-Stick installieren"
description: "Schritt-für-Schritt-Anleitung zur Installation von Windows 8 von einem USB-Stick mithilfe der Windows 7 USB/DVD Download Tool, mit Hinweisen zu Formatierung, BIOS-Einstellungen und Troubleshooting."
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "de"
translationOf: "2012/02/how-to-install-windows-8-using-a-usb-drive"
translatedBy: "claude"
translationDate: 2026-05-01
---
Zum Einstieg benötigen Sie ein ISO-Image von Windows 8 sowie die Windows 7 USB / DVD Download Tool, die Ihnen hilft, dieses Image auf den USB-Stick zu bringen. Beides können Sie über die jeweiligen Bilder unten herunterladen.

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

Installieren Sie nach dem Download die Windows 7 USB Tool. Lassen Sie sich vom Namen "Windows 7" nicht stören, sie funktioniert auch mit Windows 8 problemlos.

Sobald Sie alle benötigten Dateien haben, stecken Sie Ihren USB-Stick in den PC, klicken Sie ihn rechts an und wählen Sie format. Die meisten Tutorials, die ich gesehen habe, sagen, der Stick müsse mit FAT32 formatiert werden, sonst funktioniere es nicht -- wenn ich aber das Tool nutze, um die Windows-Dateien auf den Stick zu kopieren, formatiert es ihn auf NTFS. Seltsam, aber egal.

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

Quick-Format als FAT32 -- und **vergessen Sie nicht, Ihre Daten zu sichern!**

Sobald der USB-Stick formatiert ist, öffnen Sie das Windows 7 USB Tool, klicken auf **Browse** und wählen das gerade heruntergeladene ISO-Image aus.

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

Klicken Sie auf **Next** und wählen Sie auf der nächsten Seite, auf der Sie den Medientyp auswählen sollen, **USB device**. Wie Sie sehen, gibt es auch die Möglichkeit, das Image direkt auf eine DVD zu schreiben. Für diese Anleitung bleiben wir beim USB.

[![Windows USB Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

Wählen Sie das USB-Gerät aus, auf das das Tool die Installationsdateien kopieren soll, und klicken Sie auf **Begin copying.**

[![Windows USB Tool Choose USB Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

Das Tool kopiert nun die Windows-Installationsdateien auf den USB-Stick.

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

Wenn der gesamte Vorgang fehlerfrei abgeschlossen ist, starten Sie den Rechner neu, rufen Sie das Bootmenü auf (bei mir F12 -- während des POST) und wählen Sie den USB-Stick. Falls Ihr USB-Stick nicht in dieser Liste erscheint, gehen Sie ins BIOS und stellen Sie sicher, dass **Legacy USB Support** auf **Enabled** steht.

**Hinweise:**

-   Sie können keinen bootfähigen USB-Stick mit 64-Bit-Windows erzeugen, wenn Sie aktuell ein 32-Bit-Betriebssystem verwenden. Dafür benötigen Sie ein 64-Bit-Betriebssystem.
-   Der USB-Stick muss groß genug sein. 4 GB reichen für die einfachen 32-Bit- und 64-Bit-Versionen, aber für die 64-Bit-Version mit den Developer Tools benötigen Sie einen 8-GB-Stick, weil allein die ISO 4,7 GB groß ist.
-   Sichern Sie unbedingt die Daten auf dem USB-Stick, bevor Sie ihn formatieren. Sonst sind sie weg. Wählen Sie zudem die Partition, auf der Sie das OS installieren, mit Bedacht aus, damit Sie Ihre bestehende Windows-Installation nicht versehentlich überschreiben -- denn dann sind ebenfalls alle Daten verloren.

Und noch eines: veröffentlicht von einer frischen Installation von Windows 8. Damit Sie sicher wissen, dass es funktioniert.
