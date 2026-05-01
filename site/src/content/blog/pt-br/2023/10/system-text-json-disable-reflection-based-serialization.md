---
title: "System.Text.Json desabilitando a serialização baseada em reflexão"
description: "Veja como desabilitar a serialização baseada em reflexão do System.Text.Json a partir do .NET 8 para aplicações trimmed e native AOT, usando a propriedade JsonSerializerIsReflectionEnabledByDefault."
pubDate: 2023-10-21
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/10/system-text-json-disable-reflection-based-serialization"
translatedBy: "claude"
translationDate: 2026-05-01
---
A partir do .NET 8, você pode desabilitar o serializador padrão baseado em reflexão que vem com o `System.Text.Json`. Isso pode ser útil em aplicações trimmed e native AOT, em que você não quer incluir os componentes de reflexão na sua build.

Para habilitar esse comportamento, basta definir a propriedade `JsonSerializerIsReflectionEnabledByDefault` como `false` no seu arquivo `.csproj`.

```xml
<JsonSerializerIsReflectionEnabledByDefault>false</JsonSerializerIsReflectionEnabledByDefault>
```

Como efeito colateral, você passa a precisar fornecer um `JsonSerializerOptions` durante a serialização e a desserialização. Caso contrário, o resultado será uma `NotSupportedException` em tempo de execução.

Junto com essa opção, foi introduzida uma nova propriedade `IsReflectionEnabledByDefault` em `JsonSerializer`, que permite aos desenvolvedores fazer uma checagem em tempo de execução para saber se o recurso está ligado ou não.
