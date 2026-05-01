---
title: "Welches wählen: Logic Apps vs Microsoft Power Automate"
description: "Vergleichen Sie Azure Logic Apps und Microsoft Power Automate, um zu entscheiden, welcher Workflow-Automatisierungsdienst am besten zu Ihrem Anwendungsfall passt."
pubDate: 2020-11-18
tags:
  - "azure"
  - "logic-apps"
  - "microsoft-power-automate"
lang: "de"
translationOf: "2020/11/which-to-choose-logic-apps-vs-microsoft-power-automate"
translatedBy: "claude"
translationDate: 2026-05-01
---
Beide sind Design-First-Technologien, das heißt, sie bieten Benutzeroberflächen, mit denen Sie Workflows zeichnen, statt sie zu programmieren. Weitere Gemeinsamkeiten der beiden:

-   Sie können Eingaben annehmen
-   Sie können Aktionen ausführen
-   Sie können den Workflow per Bedingungen steuern
-   Sie können Ausgaben erzeugen

## Logic Apps

Logic Apps ist ein Azure-Dienst, mit dem Sie unterschiedliche Komponenten einer verteilten Anwendung automatisieren, orchestrieren und integrieren können. Mit Logic Apps lassen sich komplexe Workflows zeichnen, die komplexe Geschäftsprozesse abbilden.

Logic Apps bietet außerdem eine Code-Ansicht, mit der Sie Workflows in JSON-Notation erstellen und bearbeiten können.

Sie eignen sich ideal für Integrationsprojekte, da der Dienst Hunderte verschiedener Konnektoren für unterschiedliche Apps und externe Dienste bereitstellt. Zusätzlich können Sie eigene benutzerdefinierte Konnektoren leicht selbst erstellen.

## Microsoft Power Automate

Microsoft Power Automate ist ein Dienst, der auf Logic Apps aufbaut und sich an Personen ohne Entwicklungs- oder IT-Pro-Erfahrung richtet, die Workflows erstellen möchten. Über die Website oder die mobile App von Microsoft Power Automate können Sie komplexe Workflows erstellen, die viele verschiedene Komponenten integrieren.

Es gibt vier verschiedene Workflow-Typen:

-   **Automated**: Ein Flow, der durch einen Trigger gestartet wird. Beispielsweise könnte der Trigger das Eintreffen eines neuen Tweets oder das Hochladen einer neuen Datei sein.
-   **Button**: Ein Flow, der manuell aus der mobilen Anwendung gestartet werden kann.
-   **Scheduled**: Ein Flow, der regelmäßig ausgeführt wird.
-   **Business process**: Ein Flow, der einen Geschäftsprozess abbildet und Folgendes enthalten kann: Benachrichtigung der erforderlichen Personen mit deren protokollierter Zustimmung; Kalenderdaten für die Schritte; sowie aufgezeichnete Zeiten der einzelnen Flow-Schritte.

In Bezug auf Konnektoren verfügt Microsoft Power Automate über genau dieselben Konnektoren wie Logic Apps, einschließlich der Möglichkeit, benutzerdefinierte Konnektoren zu erstellen und zu verwenden.

## Unterschiede

| | Microsoft Power Automate | Logic Apps |
| --- | --- | --- |
| **Zielgruppe** | Office-Mitarbeiter und Business-Analysten | Entwickler und IT-Pros |
| **Zielszenarien** | Self-Service-Workflow-Erstellung | Anspruchsvolle Integrationsprojekte |
| **Design-Werkzeuge** | Nur GUI. Browser und mobile App | Designer im Browser und in Visual Studio. Code-Bearbeitung per JSON möglich |
| **Application Lifecycle Management** | Power Automate umfasst Test- und Produktionsumgebungen | Logic-Apps-Quellcode kann in Azure DevOps und Versionskontrollsystemen abgelegt werden |

## Fazit

Die beiden Dienste sind sich sehr ähnlich, der Hauptunterschied liegt in der Zielgruppe: Microsoft Power Automate richtet sich eher an nicht-technisches Personal, während Logic Apps stärker auf IT-Profis, Entwickler und DevOps-Praktiker ausgerichtet ist.
