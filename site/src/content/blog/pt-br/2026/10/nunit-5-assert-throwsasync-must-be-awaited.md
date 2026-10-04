---
title: "NUnit 5: Assert.ThrowsAsync agora retorna uma Task, e uma sem await passa silenciosamente"
description: "O NUnit 5.0.0 torna Assert.ThrowsAsync, CatchAsync e DoesNotThrowAsync realmente assíncronos. Esqueça o await e a asserção nunca é executada. Veja o que quebra, o que a regra NUnit2059 do NUnit.Analyzers detecta e as outras mudanças do NUnit 5 a verificar antes de atualizar."
pubDate: 2026-10-04
tags:
  - "nunit"
  - "testing"
  - "dotnet"
  - "csharp"
lang: "pt-br"
translationOf: "2026/10/nunit-5-assert-throwsasync-must-be-awaited"
translatedBy: "claude"
translationDate: 2026-10-04
---

O [NUnit 5.0.0](https://github.com/nunit/nunit/releases/tag/v5.0.0) foi lançado em 27 de setembro de 2026. Os mantenedores o descrevem como uma versão major pequena, e a maioria das [mudanças incompatíveis](https://docs.nunit.org/articles/nunit/V5BreakingChanges.html) transforma falhas em runtime em erros de compilação. Uma mudança vai no sentido oposto: se você atualizar sem cuidado, um teste que falha pode passar a passar.

## ThrowsAsync costumava bloquear, agora retorna uma Task

No NUnit 4, `Assert.ThrowsAsync<T>`, `Assert.CatchAsync` e `Assert.DoesNotThrowAsync` tinham nomes assíncronos, mas executavam o delegate de forma síncrona, bloqueando a thread chamadora, e retornavam a exceção diretamente. A [issue #4384](https://github.com/nunit/nunit/issues/4384) corrigiu isso na 5.0.0: os três agora retornam uma `Task` e precisam de await.

```csharp
// NUnit 4.6.1
var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());

// NUnit 5.0.0
var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoAsync());
```

O novo formato é o correto. O problema é o código que você já tem.

## A aprovação silenciosa

Testes antigos chamam `ThrowsAsync` de um método de teste `void` comum. No NUnit 5 isso ainda compila: a `Task` retornada é descartada e, como o método não é `async`, o compilador sequer emite CS4014. Executei isto no .NET SDK 10.0.302 com NUnit3TestAdapter 6.3.0, em que `DoesNotThrowAsync` nunca lança exceção:

```csharp
static async Task DoesNotThrowAsync() => await Task.Delay(10);

[Test]
public void Unawaited()
{
    var ex = Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}

[Test]
public async Task Awaited()
{
    var ex = await Assert.ThrowsAsync<ArgumentException>(async () => await DoesNotThrowAsync());
}
```

Os resultados:

| Configuração | `Unawaited` | `Awaited` |
| --- | --- | --- |
| NUnit 4.6.1 | falha (correto) | CS1061, `ArgumentException` não tem `GetAwaiter` |
| NUnit 5.0.0, NUnit.Analyzers 4.13.0 | **passa** | falha (correto) |
| NUnit 5.0.0, NUnit.Analyzers 4.14.0 ou 4.15.0 | erro de build NUnit2059 | falha (correto) |

A linha do meio é a que preocupa. O teste que deveria detectar a ausência de uma `ArgumentException` fica verde, e nada na saída dos testes indica que a asserção nunca foi executada.

## Deixe o analisador fazer a migração

O [NUnit.Analyzers](https://www.nuget.org/packages/NUnit.Analyzers) 4.14.0 adicionou o NUnit2059, "Method 'ThrowsAsync' returns a Task and is not being observed", reportado como erro por padrão. Sua correção automática adiciona o `await` e muda o método que o contém para `async Task`. Portanto, a ordem da atualização importa:

```xml
<PackageReference Include="NUnit" Version="5.0.0" />
<PackageReference Include="NUnit.Analyzers" Version="4.15.0" />
<PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />
```

Atualize o analisador no mesmo commit que o framework. Se seus projetos fixam o NUnit.Analyzers de forma centralizada em `Directory.Packages.props` em uma versão mais antiga, ou o removeram, o build continua verde e você cai na linha da aprovação silenciosa.

## As outras mudanças do NUnit 5 que valem um grep

- `TestDelegate`, `AsyncTestDelegate` e `ActualValueDelegate<T>` foram removidos. Lambdas não são afetadas; usos explícitos passam a ser `Action`, `Func<Task>` e `Func<T>`.
- `[Platform("NET")]` e `"DotNET"` agora significam o .NET moderno, não o .NET Framework. Use o novo identificador `"NETFramework"` se era isso que você queria, ou os testes passarão a rodar (ou deixarão de rodar) silenciosamente no runtime errado.
- `Is.SameAs` só aceita tipos de referência, e `Has.Attribute<T>()` exige `T : Attribute`. Ambos eram falhas em runtime antes.
- `StringAssert`, `CollectionAssert`, `FileAssert` e `DirectoryAssert` voltam para `NUnit.Framework`.
- O framework tem como alvo `net462`, `net8.0` e `net10.0`. O alvo `net6.0` foi removido.
- `[Order]` agora é `[Obsolete]`. Os substitutos são os novos atributos `[DependsOnTest]` e `[DependsOnFixture]`, que ignoram um teste quando sua dependência falha.

Se você está decidindo se o NUnit ainda é o framework certo para um novo projeto, minha [comparação entre xUnit v3, NUnit e MSTest](/pt-br/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) foi medida no NUnit 4.6.1. Os números lá são anteriores à 5.0.0, mas a recomendação não depende de nada que esta versão tenha mudado.
