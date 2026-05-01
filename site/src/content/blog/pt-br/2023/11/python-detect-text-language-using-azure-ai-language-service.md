---
title: "Python: detectar o idioma do texto usando o serviço Azure AI Language"
description: "Aprenda a detectar o idioma de um texto usando o serviço Azure AI Language e o SDK Python azure-ai-textanalytics, com exemplos de código e payloads da API."
pubDate: 2023-11-18
tags:
  - "ai"
  - "azure"
  - "python"
lang: "pt-br"
translationOf: "2023/11/python-detect-text-language-using-azure-ai-language-service"
translatedBy: "claude"
translationDate: 2026-05-01
---
O serviço Azure AI Language oferece aos desenvolvedores uma API para técnicas comuns de análise de texto, como detectar o idioma do texto, fazer análise de sentimento, extração de frases-chave e reconhecimento e vinculação de entidades nomeadas.

## Provisionamento

[![](/wp-content/uploads/2023/11/image-11.png)](/wp-content/uploads/2023/11/image-11.png)

O primeiro passo para analisar texto com o Azure AI Language é provisionar um recurso `Language service` no Azure. Para fins de teste, você pode usar o nível gratuito `F0`, que tem um limite de 5000 transações por mês.

Além dos limites do nível, você também precisa considerar os limites de requisição:

-   é possível enviar no máximo 1000 documentos por requisição
-   e cada documento pode ter no máximo 5120 caracteres

Depois que o recurso for criado, navegue até **Keys and Endpoint** para obter a URL do endpoint e a chave de autorização (qualquer uma das duas funciona). Vamos precisar delas mais adiante, quando começarmos a fazer chamadas à API.

## API de detecção de idioma

A API de detecção de idioma recebe um ou mais documentos de texto e, para cada um deles, retorna o idioma detectado junto com uma pontuação de confiança. Isso é útil ao lidar com textos arbitrários, quando você não sabe qual é o idioma do conteúdo e isso pode ter um papel importante em análises ou ações subsequentes. Por exemplo, em um cenário de chatbot, você pode usar essa informação para atender o usuário no idioma dele.

Cada documento de entrada é composto pelo seu conteúdo `text` e por um `id` único (único no contexto desta requisição). Você também pode informar um `countryHint` para cada documento de entrada para melhorar o desempenho da predição.

Vamos olhar um exemplo de payload JSON:

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

Para cada documento de entrada, receberemos de volta o idioma detectado (`name` e `iso6391Name`) junto com uma pontuação de confiança e uma lista de avisos (se houver).

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

Caso o serviço não consiga entender o texto de entrada, o idioma será `(Unknown)`, com um `confidenceScore` de `0`.

## Testando

Para testar a API de detecção de idioma, crie um novo arquivo de script `.py` e instale o pacote `azure-ai-textanalytics`.

```bash
pip install azure-ai-textanalytics==5.3.0
```

Depois que o pacote estiver instalado, começamos criando uma instância de `TextAnalyticsClient`.

```python
from azure.core.credentials import AzureKeyCredential
from azure.ai.textanalytics import TextAnalyticsClient

credential = AzureKeyCredential('<your-authorization-key>')
ai_client = TextAnalyticsClient(endpoint='https://<your-resource-name>.cognitiveservices.azure.com/', credential=credential)
```

Lembre-se de substituir o endpoint e a chave de autorização pelos dados obtidos na página **Keys and Endpoint** do seu próprio recurso. Feito isso, você está pronto para chamar o serviço.

O `TextAnalyticsClient` vem com um método `detect_language` com sobrecargas que aceitam `List[str]`, `List[DetectLanguageInput]` ou `List[Dict[str, str]]`.

Vamos explorar um pouco esse método. Primeiro, detectando o idioma de um único trecho de texto:

```python
detectedLanguage = ai_client.detect_language(documents=['Hello, world!'])[0]
print(detectedLanguage)
```

A resposta será assim:

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

Agora um cenário mais complexo, em que, como no exemplo de payload JSON acima, enviamos múltiplos documentos com identificadores únicos associados e, para um deles, também fornecemos um `country_hint`. O código fica assim:

```python
inputDocuments: List[DetectLanguageInput] = [
    DetectLanguageInput(id="1", text="Good morning", country_hint = "US"),
    DetectLanguageInput(id="2", text="Hello, je m'appelle Marius!")
]

detectedLanguages = ai_client.detect_language(inputDocuments)
print(detectedLanguages)
```

A resposta será assim:

```python
[
  DetectLanguageResult(id=1, primary_language=DetectedLanguage(name=English, iso6391_name=en, confidence_score=1.0), warnings=[], statistics=None, is_error=False, kind=LanguageDetection), 
  DetectLanguageResult(id=2, primary_language=DetectedLanguage(name=French, iso6391_name=fr, confidence_score=0.98), warnings=[], statistics=None, is_error=False, kind=LanguageDetection)
]
```
