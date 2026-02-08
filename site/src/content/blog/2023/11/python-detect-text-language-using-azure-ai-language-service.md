---
title: "Python: Detect text language using Azure AI Language service"
description: "Learn how to detect text language using the Azure AI Language service and the azure-ai-textanalytics Python SDK, with code samples and API payload examples."
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
---
The Azure AI Language service provides developers with an API for common text analysis techniques, such as the ability to detect language from text, perform sentiment analysis, key phrase extraction, and named entity recognition and linking.

## Provisioning

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

The first step in analyzing text with Azure AI Language is provisioning a `Language service` resource in Azure. For testing purposes you can use the Free `F0` tier which has a limit of 5000 transactions per month.

Besides the tier limits, you should also take into account the request limits:

-   you can send a maximum of 1000 documents per request
-   and each document can have a maximum length of 5120 characters

After the resource is created, navigate to **Keys and Endpoint** to retrieve your endpoint URL and your authorization key (any of the two will work). We will need these later when we start making calls to the API.

## Detect language API

The language detection API takes in one or more text documents, and for each of them it provides in return the detected language along with a confidence score. This can be useful when dealing with arbitrary text input, when you don’t know the language of the text, and that could play an important role in subsequent analysis or actions. For example, in a chat bot scenario, you might use this information to assist the user in their own language.

Each input document is made up of its `text` content and a unique `id` (unique in the context of this request). Additionally, you can provide a `countryHint` for each of the input documents to improve the prediction performance.

Let’s look at a sample JSON payload:

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

For each of the input documents we will receive back the detected language (`name` and `iso6391Name`) along with a confidence score and a list of warnings (if any).

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

In case your text input cannot be understood by the service, the language will be `(Unknown)`, with a `confidenceScore` of `0`.

## Try it out

To try out the detect language API, create a new `.py` script file and install the `azure-ai-textanalytics` package.

```bash
pip install azure-ai-textanalytics==5.3.0
```

Once you have the package installed, we begin by creating a `TextAnalyticsClient` instance.

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

Make sure to replace the endpoint and authorization key with the data you got from the **Keys and Endpoint** page of your own resource. Once you’ve done that, you’re ready to call the service.

The `TextAnalyticsClient` comes with a `detect_language` method with overloads accepting either a `List[str]`, a `List[DetectLanguageInput]`, or a `List[Dict[str, str]]`.

Let’s explore this method for a bit. First, detecting the language of a single piece of text:

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

The response will look like this:

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

Now, on to a more complex scenario, where – just like in the JSON payload example above – we send multiple documents, with unique identifiers associated, and for one of the documents we also provide a `country_hint`. The code will look like this:

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

The response will look like this:

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
