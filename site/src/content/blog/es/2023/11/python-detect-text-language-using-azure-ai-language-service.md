---
title: "Python: detectar el idioma de un texto con el servicio Azure AI Language"
description: "Aprende a detectar el idioma de un texto usando el servicio Azure AI Language y el SDK de Python azure-ai-textanalytics, con ejemplos de código y de payloads de la API."
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
lang: "es"
translationOf: "2023/11/python-detect-text-language-using-azure-ai-language-service"
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

Para probar la API de detección de idioma, crea un nuevo script `.py` e instala el paquete `azure-ai-textanalytics`.

```bash
pip install azure-ai-textanalytics==5.3.0
```

Una vez instalado el paquete, comenzamos creando una instancia de `TextAnalyticsClient`.

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

Asegúrate de reemplazar el endpoint y la clave de autorización por los datos que obtuviste en la página **Keys and Endpoint** de tu propio recurso. Una vez hecho esto, ya puedes llamar al servicio.

`TextAnalyticsClient` incluye un método `detect_language` con sobrecargas que aceptan `List[str]`, `List[DetectLanguageInput]` o `List[Dict[str, str]]`.

Exploremos un poco este método. Primero, detectando el idioma de un único fragmento de texto:

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

La respuesta se verá así:

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

Pasemos ahora a un escenario más complejo en el que, igual que en el ejemplo de payload JSON anterior, enviamos varios documentos con identificadores únicos asociados y, para uno de los documentos, también proporcionamos un `country_hint`. El código se verá así:

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

La respuesta se verá así:

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
