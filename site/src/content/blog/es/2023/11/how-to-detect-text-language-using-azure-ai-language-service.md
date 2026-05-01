---
title: "Cómo detectar el idioma de un texto usando el servicio Azure AI Language"
description: "Aprende a detectar el idioma de un texto usando el servicio Azure AI Language, incluyendo aprovisionamiento, payloads de la API y ejemplos con el SDK de C# usando TextAnalyticsClient."
pubDate: 2023-11-16
tags:
  - "ai"
  - "azure"
lang: "es"
translationOf: "2023/11/how-to-detect-text-language-using-azure-ai-language-service"
translatedBy: "claude"
translationDate: 2026-05-01
---
El servicio Azure AI Language proporciona a las personas desarrolladoras una API para técnicas comunes de análisis de texto, como detectar el idioma de un texto, realizar análisis de sentimiento, extraer frases clave y reconocer y vincular entidades nombradas.

## Aprovisionamiento

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

El primer paso para analizar texto con Azure AI Language es aprovisionar un recurso `Language service` en Azure. Para fines de prueba puedes usar el nivel gratuito `F0`, que tiene un límite de 5000 transacciones al mes.

Además de los límites del nivel, también debes tener en cuenta los límites por solicitud:

-   puedes enviar un máximo de 1000 documentos por solicitud
-   y cada documento puede tener una longitud máxima de 5120 caracteres

Después de crear el recurso, navega a **Keys and Endpoint** para obtener la URL del endpoint y tu clave de autorización (cualquiera de las dos funcionará). Las necesitaremos más adelante cuando empecemos a hacer llamadas a la API.

## API de detección de idioma

La API de detección de idioma recibe uno o varios documentos de texto y, para cada uno, devuelve el idioma detectado junto con una puntuación de confianza. Esto puede ser útil al manejar texto arbitrario cuando no conoces el idioma del contenido y eso puede influir en análisis o acciones posteriores. Por ejemplo, en un escenario de chatbot puedes usar esta información para atender al usuario en su propio idioma.

Cada documento de entrada se compone de su contenido `text` y un `id` único (único en el contexto de esta solicitud). Además, puedes proporcionar un `countryHint` para cada documento de entrada con el fin de mejorar el rendimiento de la predicción.

Veamos un ejemplo de payload JSON:

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

Para cada documento de entrada recibiremos de vuelta el idioma detectado (`name` e `iso6391Name`) junto con una puntuación de confianza y una lista de advertencias (si las hay).

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

En caso de que el servicio no pueda entender tu texto de entrada, el idioma será `(Unknown)`, con un `confidenceScore` de `0`.

## Probarlo

Para probar la API de detección de idioma, crea una nueva aplicación de consola e instala el paquete NuGet `Azure.AI.TextAnalytics`. Una vez instalado el paquete, comenzamos creando una instancia de `TextAnalyticsClient`.

```cs
using Azure.AI.TextAnalytics;
using Azure;

var aiClient = new TextAnalyticsClient(
    new Uri("https://my-service.cognitiveservices.azure.com/"),
    new AzureKeyCredential("98c1961504db412c9fd36d15984c9d9e"));
```

Asegúrate de reemplazar el endpoint y la clave de autorización por los datos que obtuviste en la página **Keys and Endpoint** de tu propio recurso. Una vez hecho esto, ya puedes llamar al servicio.

`TextAnalyticsClient` proporciona dos métodos para detectar el idioma:

-   `DetectLanguageAsync`, que funciona con un único fragmento de texto y tiene un parámetro opcional `countryHint`
-   `DetectLanguageBatchAsync`, que funciona con múltiples documentos, aceptando strings o instancias de `DetectLanguageInput`

Veámoslos uno por uno. Primero, detectando el idioma de un único fragmento de texto:

```cs
var response = await aiClient.DetectLanguageAsync("Hello, world!");
var detectedLanguage = response.Value;
```

`DetectLanguageAsync` devuelve un `Task<Response<DetectedLanguage>>`, así que para llegar al `DetectedLanguage` real necesitamos hacer `.Value` sobre el resultado de la tarea. La respuesta se verá así:

```json
{
  "Name": "English",
  "Iso6391Name": "en",
  "ConfidenceScore": 1,
  "Warnings": []
}
```

Pasemos ahora a un escenario más complejo en el que, igual que en el ejemplo de payload JSON anterior, enviamos varios documentos con identificadores únicos asociados y, para uno de los documentos, también proporcionamos un `CountryHint`. El código se verá así:

```cs
var inputDocuments = new DetectLanguageInput[]
{
    new("1", "Good morning") { CountryHint = "US" },
    new("2", "Hello, je m'appelle Marius!"),
};

var detectedLanguages = (await aiClient.DetectLanguageBatchAsync(inputDocuments)).Value;
```

`detectedLanguages` es de tipo `DetectLanguageResultCollection`, que en realidad es una `ReadOnlyCollection` con algo de información adicional encima (estadísticas sobre el lote de documentos y cómo lo procesó el servicio, además de la versión del modelo del servicio Language usada para la operación).

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
