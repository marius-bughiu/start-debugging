---
title: "FluentValidation 12.2 corrige o crash de IsInEnum() em apps native AOT com enums [Flags]"
description: "O FluentValidation 12.2.0, lançado em 10 de outubro de 2026, troca Enum.GetValues por Enum.GetValuesAsUnderlyingType dentro do EnumValidator, então IsInEnum() em um enum [Flags] não lança mais NotSupportedException em um binário native AOT."
pubDate: 2026-10-12
tags:
  - "fluentvalidation"
  - "native-aot"
  - "dotnet"
  - "csharp"
  - "validation"
lang: "pt-br"
translationOf: "2026/10/fluentvalidation-12-2-isinenum-on-flags-enums-works-under-native-aot"
translatedBy: "claude"
translationDate: 2026-10-12
---

O [FluentValidation 12.2.0](https://github.com/FluentValidation/FluentValidation/releases/tag/12.2.0) chegou ao NuGet em 10 de outubro de 2026. A maior parte do changelog é manutenção (mensagens em lituano e bielorrusso, algumas correções em `PropertyChain`), mas uma linha importa muito se você publica com `PublishAot`: "Change EnumValidator to work under native AOT". Antes desta versão, `RuleFor(x => x.Access).IsInEnum()` em um enum `[Flags]` compilava, passava em todos os testes baseados em JIT e depois derrubava o binário nativo publicado na primeira chamada de validação.

## Como era o crash

Aqui está um app mínimo. É o formato que você encontraria em qualquer minimal API publicada com AOT que valida um enum de permissões ou opções:

```csharp
using FluentValidation;

var v = new GrantValidator();
Console.WriteLine(v.Validate(new Grant(Access.Read | Access.Write)).IsValid);
Console.WriteLine(v.Validate(new Grant((Access)64)).IsValid);

[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Delete = 4 }

public record Grant(Access Access);

public class GrantValidator : AbstractValidator<Grant>
{
    public GrantValidator() => RuleFor(x => x.Access).IsInEnum();
}
```

Publiquei com `<PublishAot>true</PublishAot>` no SDK do .NET 10.0.302 (osx-arm64), uma vez com o FluentValidation 12.1.1 e outra com o 12.2.0. Com o 12.1.1 o binário morre imediatamente:

```text
Unhandled exception. System.NotSupportedException: 'Access[]' is missing native code or metadata.
   at System.Array.CreateInstance(Type, Int32) + 0x5c
   at System.RuntimeType.GetEnumValues() + 0x88
```

Com o 12.2.0 o mesmo código imprime `True` e `False`, que é a resposta correta para uma combinação válida e um bit não definido.

## Por que só enums [Flags] eram afetados

O `EnumValidator` segue dois caminhos. Enums sem flags passam por `Enum.IsDefined`, que sempre foi seguro para AOT. Enums com flags passam por um método privado `EvaluateFlagEnumValues` que monta uma máscara a partir de cada valor declarado, e no 12.1.x ele fazia isso com `Enum.GetValues(Type)`. Essa sobrecarga é marcada com `[RequiresDynamicCode]` porque precisa alocar um `Access[]` em runtime, e o ILC não consegue pré-gerar um tipo de array que nunca viu estaticamente.

A publicação até avisava, só que não em voz alta. Por padrão, o trimmer agrupa os avisos de terceiros em uma única linha:

```text
warning IL3053: Assembly 'FluentValidation' produced AOT analysis warnings.
```

Só com `-p:TrimmerSingleWarn=false` você vê o `IL3050` real apontando para `EnumValidator.cs(103)` e `Enum.GetValues(Type)`.

## A correção de uma linha

O [PR #2371](https://github.com/FluentValidation/FluentValidation/pull/2371) substitui a chamada por `Enum.GetValuesAsUnderlyingType(enumType)`, disponível desde o .NET 8 (que é o target mínimo do FluentValidation 12). Ele retorna os valores em box como o tipo inteiro subjacente, então nenhum array tipado como enum é criado, e o loop existente com `Convert.ToInt64` continua funcionando sem alterações. Nenhuma mudança de API, nenhuma mudança de comportamento, e ainda elimina uma ida e volta de box/unbox por valor.

```csharp
// FluentValidation 12.2.0, EnumValidator.EvaluateFlagEnumValues
foreach (var enumValue in Enum.GetValuesAsUnderlyingType(enumType)) {
    var enumValueAsInt64 = Convert.ToInt64(enumValue);
    // ...
}
```

Com o 12.2.0, o aviso `IL3053` do FluentValidation some completamente da saída da publicação neste exemplo.

## A outra correção que vale conhecer

O 12.2.0 também corrige `context.PropertyPath` dentro de um `.When()` em `RuleForEach` ([#2363](https://github.com/FluentValidation/FluentValidation/pull/2363)). A condição via o caminho do item anterior (ou `null` para o primeiro), porque o contexto era atualizado depois que a condição rodava. Se você monta chaves de erro ou linhas de log a partir de `PropertyPath` dentro de condições, estava recebendo caminhos deslocados em um.

## O que fazer

Atualize o pacote:

```bash
dotnet add package FluentValidation --version 12.2.0
```

Se você distribui com native AOT, defina também `TrimmerSingleWarn` como `false` no CI pelo menos uma vez. Linhas `IL3053` agrupadas são o caminho pelo qual bugs como este chegam à produção. E se você ainda está decidindo se precisa do FluentValidation no ASP.NET Core 11, eu o comparei com a opção nativa em [validação em minimal APIs vs FluentValidation](/pt-br/2026/06/minimal-api-validation-vs-fluentvalidation-in-aspnetcore-11/).
