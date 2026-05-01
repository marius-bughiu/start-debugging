---
title: ".NET 8 lidando com membros não mapeados na desserialização JSON"
description: "Aprenda a lançar exceções para propriedades JSON não mapeadas durante a desserialização no .NET 8 usando JsonUnmappedMemberHandling."
pubDate: 2023-09-02
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/09/net-8-handle-missing-members-during-json-deserialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
Por padrão, se houver propriedades adicionais no payload JSON que você está tentando desserializar, elas são simplesmente ignoradas. Mas e se você quisesse que a desserialização falhasse e lançasse uma exceção quando o JSON tiver propriedades extras? Isso é possível a partir do .NET 8.

Existem algumas formas de habilitar esse comportamento ao usar o serializador `System.Text.Json`.

## 1\. Usando o atributo JsonUnmappedMemberHandling

Você pode anotar seu tipo com `[System.Text.Json.Serialization.JsonUnmappedMemberHandlingAttribute]`, passando a opção como parâmetro.

```cs
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public class Foo
{
     public int Bar { get; set; }
}
```

## 2\. Usando JsonSerializerOptions

Defina a propriedade `JsonSerializerOptions.UnmappedMemberHandling` como `Disallow` e passe esse `options` para o método `Deserialize`.

```cs
new JsonSerializerOptions 
{ 
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow 
};
```

## Uma exceção é lançada

Esteja preparado para tratá-la. Com `JsonUnmappedMemberHandling` em `Disallow`, a seguinte exceção será lançada ao desserializar um payload JSON com membros adicionais.

> **System.Text.Json.JsonException**: 'The JSON property '<property name>' could not be mapped to any .NET member contained in type '<namespace>+<type name>'.'
