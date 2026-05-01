---
title: "Python: Textsprache mit dem Azure AI Language Service erkennen"
description: "Erfahren Sie, wie Sie die Sprache eines Textes mit dem Azure AI Language Service und dem Python-SDK azure-ai-textanalytics erkennen, mit Codebeispielen und Beispielen für API-Payloads."
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
lang: "de"
translationOf: "2023/11/python-detect-text-language-using-azure-ai-language-service"
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

Um die Spracherkennungs-API auszuprobieren, erstellen Sie eine neue `.py`-Skriptdatei und installieren das Paket `azure-ai-textanalytics`.

```bash
pip install azure-ai-textanalytics==5.3.0
```

Nach der Installation des Pakets erstellen wir zunächst eine Instanz von `TextAnalyticsClient`.

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

Achten Sie darauf, den Endpunkt und den Autorisierungsschlüssel durch die Daten zu ersetzen, die Sie auf der Seite **Keys and Endpoint** Ihrer eigenen Ressource erhalten haben. Anschließend können Sie den Dienst aufrufen.

Der `TextAnalyticsClient` enthält eine Methode `detect_language` mit Überladungen, die entweder ein `List[str]`, ein `List[DetectLanguageInput]` oder ein `List[Dict[str, str]]` akzeptieren.

Schauen wir uns diese Methode etwas genauer an. Zuerst die Spracherkennung eines einzelnen Textstücks:

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

Die Antwort sieht so aus:

```python
{
  'id': '0', 
  'primary_language': DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), 
  'warnings': [], 
  'statistics': None, 
  'is_error': False, 
  'kind': 'LanguageDetection'
}
```

Nun zu einem komplexeren Szenario, in dem wir, wie im obigen JSON-Payload-Beispiel, mehrere Dokumente mit zugehörigen eindeutigen Bezeichnern senden und für eines der Dokumente zusätzlich einen `country_hint` angeben. Der Code sieht so aus:

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

Die Antwort sieht so aus:

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
