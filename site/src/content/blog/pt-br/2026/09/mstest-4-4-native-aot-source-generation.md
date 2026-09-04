---
title: "MSTest 4.4 formaliza o gerador de código de reflexão, e projetos Native AOT recebem ele automaticamente"
description: "O MSTest 4.4 tira o MSTest.SourceGeneration do status experimental e o alinha com a versão do MSTest. Projetos de teste Native AOT passam a usá-lo sem opt-in, o modo ReflectionFree já consegue pular a descoberta em runtime para [TestMethod] e [DataRow] simples, e cinco diagnósticos AOTSG mostram quais formatos de teste não sobrevivem."
pubDate: 2026-09-04
tags:
  - "mstest"
  - "native-aot"
  - "testing"
  - "source-generators"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/09/mstest-4-4-native-aot-source-generation"
translatedBy: "claude"
translationDate: 2026-09-04
---

A Microsoft publicou ["Test what you ship: MSTest and Native AOT"](https://devblogs.microsoft.com/dotnet/mstest-source-generation/) em 3 de setembro de 2026, e o argumento do título é exatamente o ponto. Se você publica seu aplicativo com `PublishAot`, seu CI vinha validando um binário diferente daquele que seus usuários executam: o host de testes carrega no CoreCLR com reflexão completa, então um membro que o trimmer teria removido continua lá quando a asserção roda. A falha aparece em produção.

O MSTest 4.3 trouxe uma correção para isso no pacote experimental `MSTest.SourceGeneration`, versionado de forma independente. O MSTest 4.4 o formaliza: o pacote perde o rótulo de experimental e passa para a linha de versão do MSTest, e o `MSTest.Sdk` mantém `MSTest.SourceGeneration`, `MSTest.TestFramework` e `MSTest.TestAdapter` alinhados por meio de `MSTestVersion`.

## Projetos Native AOT recebem o gerador sem opt-in

Um projeto de teste que define `PublishAot` agora traz o gerador automaticamente:

```xml
<Project Sdk="MSTest.Sdk/4.4.0">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <PublishAot>true</PublishAot>
  </PropertyGroup>
</Project>
```

O código de teste em si não muda. Os membros `[TestClass]` e `[TestMethod]` de sempre continuam como estão, e o gerador emite o registro, os dados de atributos e os delegates de invocação em tempo de compilação, antes de o trimmer rodar.

Para um projeto que não é Native AOT e usa o `MSTest.Sdk`, o gerador é opcional:

```xml
<EnableMSTestSourceGeneration>true</EnableMSTestSourceGeneration>
```

Isso também funciona em bibliotecas de teste reutilizáveis e sob Central Package Management, onde o SDK gera os itens `PackageVersion` correspondentes. Não funciona em .NET Standard: os hooks de runtime do `MSTest.TestAdapter` necessários não existem lá, e o SDK falha a compilação com um erro explícito em vez de produzir um registro quebrado.

## A descoberta em tempo de compilação muda uma regra

Como a descoberta acontece em tempo de compilação, `[TestClass]` precisa estar declarado na própria classe. Herdar de uma classe base funcionava com reflexão e agora não produz nada, silenciosamente. O analisador [MSTEST0069](https://learn.microsoft.com/en-us/dotnet/core/testing/mstest-analyzers/mstest0069) sinaliza exatamente esse caso, que é a diferença entre um aviso de compilação e uma execução de CI que reporta zero testes e termina em verde.

## O que o ReflectionFree realmente cobre no 4.4

`MSTestSourceGenMode` tem `ReflectionFree` como padrão para projetos com trimming e Native AOT desde o MSTest 4.3.2. Em um runtime que ainda tem reflexão, ele recorre ao fallback para tudo o que o gerador não cobriu.

O 4.4 amplia o conjunto coberto. A geração sem reflexão agora materializa os metadados completos de atributos herdados, incluindo `AttributeUsage` e `AllowMultiple`, e sobre o [Microsoft.Testing.Platform](/pt-br/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) ele consegue pular inteiramente a descoberta e a validação em runtime para métodos `[TestMethod]` e `[DataRow]` síncronos simples. Testes assíncronos, atributos de método de teste personalizados, `DynamicData`, implementações próprias de `ITestDataSource` e formatos ambíguos continuam pelo caminho de fallback. O VSTest mantém seu caminho existente de qualquer forma.

Cinco diagnósticos mostram o que o modo sem reflexão não consegue gerar: `AOTSG0001` classe de teste estática, `AOTSG0002` classe de teste genérica aberta (incluindo uma aninhada em um tipo genérico), `AOTSG0003` uma classe que o código gerado não alcança, como uma classe file-local ou aninhada como privada, `AOTSG0004` método de teste genérico e `AOTSG0005` um método de teste com parâmetro `ref`, `in` ou `out`.

Se algo quebrar e você precisar fazer bisseção, existe uma saída de emergência que mantém a descoberta mas restaura a execução por reflexão:

```xml
<PropertyGroup>
  <MSTestSourceGenMode>Rooting</MSTestSourceGenMode>
</PropertyGroup>
```

Uma ressalva que vale a leitura antes de reescrever um pipeline: o comportamento do 4.4 está por enquanto apenas em builds de preview, até o MSTest 4.4.0 sair. A [documentação de configuração do MSTest SDK](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-sdk) traz a lista completa de propriedades.
