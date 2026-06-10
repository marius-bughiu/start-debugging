---
title: "System.Text.Json finalmente escreve JSON Lines no .NET 11 Preview 5"
description: ".NET 11 Preview 5 adiciona JsonSerializer.SerializeAsyncEnumerable com topLevelValues: true, para que o System.Text.Json possa transmitir JSONL, e não apenas lê-lo."
pubDate: 2026-06-10
tags:
  - "dotnet-11"
  - "csharp"
  - "system-text-json"
  - "serialization"
lang: "pt-br"
translationOf: "2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-10
---

As [notas da biblioteca do .NET 11 Preview 5](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) fecham uma lacuna que estava aberta desde o .NET 9: o `System.Text.Json` agora pode serializar JSON Lines, e não apenas desserializá-lo. O lado de leitura chegou duas versões atrás, o lado de escrita estava faltando, e quem exportava JSONL precisava escrever à mão um laço que emitia um documento por linha. O Preview 5 transforma isso em uma única chamada.

## O que é JSON Lines de fato

JSON Lines (JSONL) não é um arranjo JSON. É um valor JSON independente por linha, separados por `\n`, sem colchetes envolventes e sem vírgulas entre os registros:

```
{"Device":"kitchen","Celsius":21.4}
{"Device":"garage","Celsius":8.1}
```

Esse formato está em toda parte assim que você começa a transmitir dados: arquivos de log estruturados, exportações grandes de banco de dados e os formatos de entrada/saída em lote usados pelos pipelines de treinamento e avaliação de LLM. A vantagem é que você pode anexar um registro sem reescrever o arquivo, e pode processar o arquivo linha por linha sem nunca ter tudo na memória. Um arranjo JSON de nível superior não oferece nada disso, porque um analisador não tem como saber que o arranjo é válido até ver o `]` de fechamento.

## O lado de escrita que estava faltando

O `System.Text.Json` aprendeu a *ler* vários valores de nível superior no .NET 9, quando o `DeserializeAsyncEnumerable` ganhou um parâmetro `topLevelValues`. O Preview 5 adiciona a sobrecarga simétrica no serializador:

```csharp
record SensorReading(string Device, double Celsius, DateTimeOffset At);

async IAsyncEnumerable<SensorReading> GetReadings()
{
    yield return new("kitchen", 21.4, DateTimeOffset.UtcNow);
    yield return new("garage", 8.1, DateTimeOffset.UtcNow);
}

await using var stream = File.Create("readings.jsonl");
await JsonSerializer.SerializeAsyncEnumerable(
    stream,
    GetReadings(),
    topLevelValues: true);
```

Com `topLevelValues: true` você obtém JSONL: cada item escrito como seu próprio documento raiz na sua própria linha. Deixe no valor padrão `false` e você obtém o comportamento antigo, um único arranjo JSON. As novas sobrecargas aceitam tanto um `Stream` quanto um `PipeWriter`, e recebem `JsonSerializerOptions` ou um `JsonTypeInfo<TValue>` gerado por código-fonte para uma serialização compatível com AOT, sem reflexão.

## Um ciclo completo limpo

Como o lado de leitura já existe, as duas metades agora se encaixam:

```csharp
await using var input = File.OpenRead("readings.jsonl");

await foreach (var reading in JsonSerializer.DeserializeAsyncEnumerable<SensorReading>(
    input,
    topLevelValues: true))
{
    Console.WriteLine($"{reading.Device}: {reading.Celsius} C");
}
```

Note que `GetReadings` é um `IAsyncEnumerable<T>`, então o serializador puxa os registros à medida que os escreve. Você pode transmitir direto de um cursor de banco de dados ou de uma resposta HTTP para um arquivo JSONL sem materializar antes uma `List<T>`. Esse é todo o objetivo: memória constante, não importa quantos registros você passe.

Isso ainda é um preview, então as assinaturas exatas podem mudar antes do lançamento de novembro. Mas o formato da API espelha o lado de leitura o suficiente para que seja seguro começar a projetar em torno dele. Se você vinha colando `Utf8JsonWriter` com quebras de linha manuais para emitir JSONL, esta é a chamada que substitui tudo isso.
