---
title: "MSTest 4.4.1 corrige as chamadas ambíguas de Assert com CS0121 que o 4.4.0 quebrou abaixo do C# 14"
description: "O MSTest 4.4.0 adicionou sobrecargas de Span<T> e ReadOnlySpan<T> a Assert.Contains e Assert.DoesNotContain, o que fez asserções comuns sobre arrays e strings falharem com CS0121 em net8.0, net9.0 ou qualquer projeto abaixo do C# 14. O MSTest 4.4.1, publicado em 2026-09-16, adiciona sobrecargas exatas para arrays e encaminhadores com restrições. Dois formatos de chamada com genérico explícito ainda falham."
pubDate: 2026-09-17
tags:
  - "mstest"
  - "testing"
  - "csharp"
  - "dotnet"
  - "breaking-changes"
lang: "pt-br"
translationOf: "2026/09/mstest-4-4-1-fixes-cs0121-ambiguous-assert-calls-below-csharp-14"
translatedBy: "claude"
translationDate: 2026-09-17
---

Se você atualizou o MSTest para 4.4.0 em um projeto que tem como alvo `net8.0` ou `net9.0`, seu projeto de testes pode ter parado de compilar em linhas que não mudavam havia anos. O [MSTest 4.4.1](https://github.com/microsoft/testfx/releases/tag/v4.4.1), publicado no NuGet em 2026-09-16, corrige isso. Aqui está o que quebrou, a matriz de versões que eu medi e os dois formatos de chamada que o 4.4.1 ainda não cobre.

## Sobrecargas de span que só o C# 14 consegue classificar

O MSTest 4.4.0 adicionou sobrecargas de `Span<T>` e `ReadOnlySpan<T>` ao lado das já existentes de `IEnumerable<T>` em `Assert.Contains` e `Assert.DoesNotContain`. No C# 14, as conversões de span de primeira classe dão ao compilador regras de desempate para arrays e strings, então ele escolhe uma sobrecarga. Abaixo do C# 14, a conversão de `T[]` para `Span<T>` é apenas um `op_Implicit` definido pelo usuário, e nenhuma das sobrecargas é melhor. A [issue #11022](https://github.com/microsoft/testfx/issues/11022) relatou isso no dia seguinte ao lançamento do 4.4.0:

```text
error CS0121: The call is ambiguous between the following methods or properties:
'Assert.Contains<T>(T, System.Collections.Generic.IEnumerable<T>, string?, string, string)' and
'Assert.Contains<T>(T, System.Span<T>, string?, string, string)'
```

Como `net8.0` usa C# 12 por padrão e `net9.0` usa C# 13, esses TFMs quebram logo de cara. O mesmo acontece com um projeto `net10.0` fixado em um `LangVersion` mais antigo.

## A matriz de versões

Compilei o mesmo arquivo contra cada versão com o SDK 10.0.302:

```csharp
int[] ids = [1, 2, 3];
string name = "Marius";

Assert.Contains(2, ids);
Assert.DoesNotContain(4, ids);
Assert.DoesNotContain('z', name);
Assert.Contains<int>(2, ids);
```

| MSTest | Alvo / linguagem | Resultado |
| --- | --- | --- |
| 4.3.3 | `net8.0`, `net10.0` | compila |
| 4.4.0 | `net10.0` (C# 14) | compila |
| 4.4.0 | `net8.0`, `net9.0` ou `net10.0` com `LangVersion` 12 | 4 x `CS0121` |
| 4.4.0 | `net8.0` com `LangVersion` 14 | compila |
| 4.4.1 | `net8.0`, `net10.0` | compila |

As quatro chamadas falham no 4.4.0, incluindo o `Contains<int>` explícito e o caso com `string`. O único contorno no 4.4.0 é elevar o `LangVersion` para 14 em um TFM mais antigo, o que não é uma combinação suportada. Atualizar é a correção de verdade:

```xml
<PackageReference Include="MSTest" Version="4.4.1" />
```

Se você usa `MSTest.Sdk`, atualize a versão em `global.json` ou no atributo `Sdk="MSTest.Sdk/4.4.1"`.

## Como o 4.4.1 corrige isso e o que fica de fora

O [PR #11038](https://github.com/microsoft/testfx/pull/11038) adiciona sobrecargas exatas de `T[]` a todas as famílias de `Assert` afetadas. Uma correspondência exata vence as duas conversões, então chamadas inferidas e explícitas sobre arrays voltam a ser resolvidas. Ele também adiciona encaminhadores com restrições que mantêm as chamadas inferidas funcionando para outros tipos que convertem para span, como `string`, `ArraySegment<T>` e suas próprias coleções. Eles encaminham para o código existente de `IEnumerable<T>`, então o comportamento é igual ao do 4.3.3.

O PR diz que chamadas com `<T>` explícito sobre tipos que não são arrays estão fora do escopo, e meu teste no 4.4.1 com `net8.0` confirma:

```csharp
var seg = new ArraySegment<int>(ids);
Assert.Contains(2, seg);           // OK
Assert.Contains(2, ids.AsSpan());  // OK
Assert.Contains<int>(2, seg);      // CS0121
Assert.Contains<char>('M', name);  // CS0121
```

Remova o argumento de tipo e deixe a inferência escolher o encaminhador, ou faça um cast para `IEnumerable<T>`.

A mesma versão também reduz o que o gerador de código-fonte do MSTest preserva como raiz para trimming e Native AOT, e corrige os literais gerados para enums, tipos integrais estreitos, `NaN` e caracteres de controle. Se você ativou o gerador depois que o [MSTest 4.4 o promoveu a estável](/pt-br/2026/09/mstest-4-4-native-aot-source-generation/), esse é um segundo motivo para adotar o 4.4.1.
