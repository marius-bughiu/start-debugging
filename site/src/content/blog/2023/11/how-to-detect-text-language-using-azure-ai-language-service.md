---
title: "How to: Detect text language using Azure AI Language service"
description: "The Azure AI Language service provides developers with an API for common text analysis techniques, such as the ability to detect language from text, perform sentiment analysis, key phrase extraction, and named entity recognition and linking. Provisioning The first step in analyzing text with Azure AI Language is provisioning a Language service resource in Azure…."
pubDate: 2023-11-16
tags:
  - "ai"
  - "azure"
---
The Azure AI Language service provides developers with an API for common text analysis techniques, such as the ability to detect language from text, perform sentiment analysis, key phrase extraction, and named entity recognition and linking.

## Provisioning

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

The first step in analyzing text with Azure AI Language is provisioning a `Language service` resource in Azure. For testing purposes you can use the Free `F0` tier which has a limit of 5000 transactions per month.

Besides the tier limits, you should also take into account the request limits:

-   you can send a maximum of 1000 documents per request
-   and each document can have a maximum length of 5120 characters

After the resource is created, navigate to **Keys and Endpoint** to retrieve your endpoint URL and your authorization key (any of the two will work). We will need these later when we start making calls to the API.

# Detect language API

The language detection API takes in one or more text documents, and for each of them it provides in return the detected language along with a confidence score. This can be useful when dealing with arbitrary text input, when you don’t know the language of the text, and that could play an important role in subsequent analysis or actions. For example, in a chat bot scenario, you might use this information to assist the user in their own language.

Each input document is made up of it’s `text` content and a unique `id` (unique in the context of this request). Additionally, you can provide a `countryHint` for each of the input documents to improve the prediction performance.

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

To try out the detect language API, create a new console application and install the `Azure.AI.TextAnalytics` NuGet package. Once you have the package installed, we begin by creating a `TextAnalyticsClient` instance.

```cs
using Azure.AI.TextAnalytics;
using Azure;

var aiClient = new TextAnalyticsClient(
    new Uri("https://my-service.cognitiveservices.azure.com/"),
    new AzureKeyCredential("98c1961504db412c9fd36d15984c9d9e"));
```

Make sure to replace the endpoint and authorization key with the data you got from the **Keys and Endpoint** page of your own resource. Once you’ve done that, you’re ready to call the service.

The `TextAnalyticsClient` provides two methods for detecting the language:

-   `DetectLanguageAsync` – this works for a single piece of text, and has an optional parameter for the `countryHint`
-   `DetectLanguageBatchAsync` – this works with multiple documents, accepting either strings or `DetectLanguageInput` instances

Let’s take them one by one. First, detecting the language of a single piece of text:

```cs
var response = await aiClient.DetectLanguageAsync("Hello, world!");
var detectedLanguage = response.Value;
```

`DetectLanguageAsync` returns a `Task<Response<DetectedLanguage>>`, so in order to get to the actual `DetectedLanguage`, we need to do a `.Value` on the task result. The response will look like this:

```json
{
  "Name": "English",
  "Iso6391Name": "en",
  "ConfidenceScore": 1,
  "Warnings": []
}
```

Now, on to a more complex scenario, where – just like in the JSON payload example above – we send multiple documents, with unique identifiers associated, and for one of the documents we also provide a `CountryHint`. The code will look like this:

```cs
var inputDocuments = new DetectLanguageInput[]
{
    new("1", "Good morning") { CountryHint = "US" },
    new("2", "Hello, je m'appelle Marius!"),
};

var detectedLanguages = (await aiClient.DetectLanguageBatchAsync(inputDocuments)).Value;
```

`detectedLanguages` is of type `DetectLanguageResultCollection`, which is actually a `ReadOnlyCollection` with some additional information on top (statistics about the documents batch and how it was processed by the service, plus the version of the Language service model used for the operation).

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
