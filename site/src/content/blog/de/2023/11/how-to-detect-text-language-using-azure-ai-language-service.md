---
title: "Textsprache mit dem Azure AI Language Service erkennen"
description: "Erfahren Sie, wie Sie die Sprache eines Textes mit dem Azure AI Language Service erkennen, einschließlich Bereitstellung, API-Payloads und C#-SDK-Beispielen mit TextAnalyticsClient."
pubDate: 2023-11-16
tags:
  - "ai"
  - "azure"
lang: "de"
translationOf: "2023/11/how-to-detect-text-language-using-azure-ai-language-service"
translatedBy: "claude"
translationDate: 2026-05-01
---
Der Azure AI Language Service stellt Entwicklerinnen und Entwicklern eine API für gängige Textanalyseverfahren bereit, etwa die Erkennung der Sprache eines Textes, Sentiment-Analyse, Schlüsselbegriffextraktion sowie Erkennung und Verknüpfung benannter Entitäten.

## Bereitstellung

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

Der erste Schritt zur Textanalyse mit Azure AI Language ist die Bereitstellung einer `Language service`-Ressource in Azure. Für Tests können Sie die kostenlose `F0`-Stufe nutzen, die ein Limit von 5000 Transaktionen pro Monat hat.

Neben den Stufenlimits sollten Sie auch die Limits pro Anfrage berücksichtigen:

-   Sie können maximal 1000 Dokumente pro Anfrage senden
-   und jedes Dokument darf maximal 5120 Zeichen lang sein

Nachdem die Ressource erstellt wurde, navigieren Sie zu **Keys and Endpoint**, um Ihre Endpunkt-URL und Ihren Autorisierungsschlüssel abzurufen (jeder der beiden funktioniert). Wir benötigen diese Werte später, wenn wir Aufrufe an die API durchführen.

## API zur Spracherkennung

Die Spracherkennungs-API nimmt ein oder mehrere Textdokumente entgegen und liefert für jedes davon die erkannte Sprache zusammen mit einem Konfidenzwert zurück. Das ist nützlich, wenn Sie mit beliebigem Texteingabematerial arbeiten und die Sprache des Textes nicht kennen, was wiederum eine wichtige Rolle in nachfolgenden Analysen oder Aktionen spielen kann. In einem Chatbot-Szenario können Sie diese Information beispielsweise nutzen, um den Benutzer in seiner eigenen Sprache zu unterstützen.

Jedes Eingabedokument besteht aus seinem `text`-Inhalt und einer eindeutigen `id` (eindeutig im Kontext dieser Anfrage). Zusätzlich können Sie für jedes Eingabedokument einen `countryHint` angeben, um die Vorhersagegenauigkeit zu verbessern.

Sehen wir uns ein Beispiel-JSON-Payload an:

```json
{
  "kind": "LanguageDetection",
  "parameters": {
    "modelVersion": "latest"
  },
  "analysisInput": {
    "documents": [
      {
        "id": "1",
        "text": "Good morning",
        "countryHint": "US"
      },
      {
        "id": "2",
        "text": "Hello, je m'appelle Marius!"
      }
    ]
  }
}
```

Für jedes Eingabedokument erhalten wir die erkannte Sprache (`name` und `iso6391Name`) zusammen mit einem Konfidenzwert und einer Liste von Warnungen (falls vorhanden) zurück.

```json
{
  "kind": "LanguageDetectionResults",
  "results": {
    "documents": [
      {
        "detectedLanguage": {
          "confidenceScore": 1,
          "iso6391Name": "en",
          "name": "English"
        },
        "id": "1",
        "warnings": []
      },
      {
        "detectedLanguage": {
          "confidenceScore": 0.98,
          "iso6391Name": "fr",
          "name": "French"
        },
        "id": "2",
        "warnings": []
      }
    ],
    "errors": [],
    "modelVersion": "2022-10-01"
  }
}
```

Falls der Eingabetext vom Dienst nicht erkannt werden kann, ist die Sprache `(Unknown)` mit einem `confidenceScore` von `0`.

## Ausprobieren

Um die Spracherkennungs-API auszuprobieren, erstellen Sie eine neue Konsolenanwendung und installieren das NuGet-Paket `Azure.AI.TextAnalytics`. Nach der Installation des Pakets erstellen wir zunächst eine Instanz von `TextAnalyticsClient`.

```cs
using Azure.AI.TextAnalytics;
using Azure;

var aiClient = new TextAnalyticsClient(
    new Uri("https://my-service.cognitiveservices.azure.com/"),
    new AzureKeyCredential("98c1961504db412c9fd36d15984c9d9e"));
```

Achten Sie darauf, den Endpunkt und den Autorisierungsschlüssel durch die Daten zu ersetzen, die Sie auf der Seite **Keys and Endpoint** Ihrer eigenen Ressource erhalten haben. Anschließend können Sie den Dienst aufrufen.

Der `TextAnalyticsClient` stellt zwei Methoden zur Spracherkennung bereit:

-   `DetectLanguageAsync`, das mit einem einzelnen Textstück arbeitet und einen optionalen Parameter für den `countryHint` hat
-   `DetectLanguageBatchAsync`, das mit mehreren Dokumenten arbeitet und entweder Strings oder `DetectLanguageInput`-Instanzen akzeptiert

Sehen wir sie uns nacheinander an. Zuerst die Spracherkennung eines einzelnen Textstücks:

```cs
var response = await aiClient.DetectLanguageAsync("Hello, world!");
var detectedLanguage = response.Value;
```

`DetectLanguageAsync` gibt ein `Task<Response<DetectedLanguage>>` zurück. Um an die eigentliche `DetectedLanguage` zu gelangen, müssen wir also `.Value` auf das Task-Ergebnis anwenden. Die Antwort sieht so aus:

```json
{
  "Name": "English",
  "Iso6391Name": "en",
  "ConfidenceScore": 1,
  "Warnings": []
}
```

Nun zu einem komplexeren Szenario, in dem wir, wie im obigen JSON-Payload-Beispiel, mehrere Dokumente mit zugehörigen eindeutigen Bezeichnern senden und für eines der Dokumente zusätzlich einen `CountryHint` angeben. Der Code sieht so aus:

```cs
var inputDocuments = new DetectLanguageInput[]
{
    new("1", "Good morning") { CountryHint = "US" },
    new("2", "Hello, je m'appelle Marius!"),
};

var detectedLanguages = (await aiClient.DetectLanguageBatchAsync(inputDocuments)).Value;
```

`detectedLanguages` ist vom Typ `DetectLanguageResultCollection`, was tatsächlich eine `ReadOnlyCollection` mit zusätzlichen Informationen darüber hinaus ist (Statistiken über den Dokumentenstapel und wie er vom Dienst verarbeitet wurde, sowie die Version des Language-Service-Modells, das für die Operation verwendet wurde).

```json
[
  {
    "PrimaryLanguage": {
      "Name": "English",
      "Iso6391Name": "en",
      "ConfidenceScore": 1,
      "Warnings": []
    },
    "Id": "1"
  },
  {
    "PrimaryLanguage": {
      "Name": "French",
      "Iso6391Name": "fr",
      "ConfidenceScore": 0.98,
      "Warnings": []
    },
    "Id": "2"
  }
]
```
