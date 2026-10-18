---
title: "Como formatar números com o agrupamento de dígitos indiano lakh/crore no .NET (NumberGroupSizes)"
description: "Use a cultura en-IN ou defina NumberFormatInfo.NumberGroupSizes como [3, 2] para imprimir 12,34,56,789 em vez de 123,456,789 em C#. Medido no .NET 10 e no .NET 11 RC1: como o array funciona, por que CurrencyGroupSizes é separado, a armadilha da globalização invariante que imprime em silêncio o agrupamento ocidental e um helper de lakh/crore por extenso."
pubDate: 2026-10-18
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "globalization"
  - "formatting"
lang: "pt-br"
translationOf: "2026/10/how-to-format-numbers-with-indian-lakh-crore-digit-grouping-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-18
---

**Resposta curta:** passe a cultura `en-IN` (ou qualquer outra cultura indiana, como `hi-IN`) para `ToString("N2", culture)` e o .NET imprime `12,34,56,789.50` em vez de `123,456,789.50`, porque essas culturas já trazem `NumberFormatInfo.NumberGroupSizes = [3, 2]`. Se você precisa do agrupamento sem o resto da cultura, clone um `NumberFormatInfo`, defina `NumberGroupSizes = [3, 2]` (e `CurrencyGroupSizes` e `PercentGroupSizes` se usar `C` ou `P`) e passe esse objeto como provedor de formato. O array significa "o primeiro grupo da direita tem 3 dígitos, todos os grupos seguintes têm 2", e funciona para `int`, `long`, `decimal`, `double`, `BigInteger`, padrões personalizados `#,##0` e `TryFormat` da mesma forma.

Tudo abaixo foi medido no .NET SDK 10.0.302 (runtime 10.0.10) e no .NET 11 RC1 (`11.0.100-rc.1.26425.128`) em macOS com ICU, C# 14. A saída foi idêntica byte a byte nos dois runtimes, e a própria API `NumberGroupSizes` não muda desde o .NET Framework 1.1, então o mesmo código funciona no .NET 8 e 9.

## Por que o agrupamento indiano é diferente do ocidental

A convenção ocidental agrupa a cada três dígitos: mil, milhão, bilhão. O sistema numérico indiano agrupa os três primeiros dígitos (centenas) e depois a cada dois dígitos: mil, lakh (1,00,000), crore (1,00,00,000) e assim por diante. Assim, cento e vinte e três milhões, quatrocentos e cinquenta e seis mil, setecentos e oitenta e nove é escrito `123,456,789` nos EUA e `12,34,56,789` na Índia (12 crore, 34 lakh, 56 mil, 789).

O .NET não fixa nenhuma das duas convenções no código. Todo `NumberFormatInfo` carrega três arrays de inteiros que descrevem como dividir a parte inteira de um número em grupos:

- `NumberGroupSizes`, usado pelo formato `N` e por padrões personalizados que contêm `,`
- `CurrencyGroupSizes`, usado pelo formato `C`
- `PercentGroupSizes`, usado pelo formato `P`

O formatador percorre esses arrays do ponto decimal para a esquerda. Esse é todo o mecanismo, e a razão pela qual um único array consegue descrever as duas convenções.

## Repro mínimo: o mesmo número, duas culturas

```csharp
// .NET 11, C# 14 (also .NET 10.0.10)
using System.Globalization;

var us  = CultureInfo.GetCultureInfo("en-US");
var inr = CultureInfo.GetCultureInfo("en-IN");
decimal amount = 123456789.5m;

Console.WriteLine(string.Join(",", us.NumberFormat.NumberGroupSizes));  // 3
Console.WriteLine(string.Join(",", inr.NumberFormat.NumberGroupSizes)); // 3,2

Console.WriteLine(amount.ToString("N2", us));   // 123,456,789.50
Console.WriteLine(amount.ToString("N2", inr));  // 12,34,56,789.50
Console.WriteLine(amount.ToString("C", inr));   // ₹12,34,56,789.50
Console.WriteLine(12345.678.ToString("P1", inr)); // 12,34,567.8%
```

`hi-IN`, `bn-IN` e `ta-IN` informam os mesmos tamanhos `[3, 2]` nos três arrays. Elas também usam dígitos ASCII na saída: a formatação numérica do .NET nunca substitui por `NativeDigits`, então você obtém `12,34,56,789`, e não dígitos devanágari ou bengalis, qualquer que seja a cultura indiana escolhida.

## A correção, passo a passo

Se seu app já roda com uma cultura indiana como `CurrentCulture`, está pronto: `$"{amount:N2}"` usa o agrupamento automaticamente. Na maioria das vezes, porém, você precisa do agrupamento indiano em um servidor cuja cultura é `en-US` ou invariante, ou apenas em uma coluna de um relatório. Este é o procedimento que funciona em todos os casos.

1. Decida se você quer a cultura indiana inteira ou apenas o agrupamento de dígitos. `en-IN` também traz o símbolo de moeda `₹`, datas no estilo `dd-MM-yyyy` e os nomes dos meses em inglês indiano. Se você só quer as vírgulas, crie um `NumberFormatInfo` personalizado.
2. Comece por uma cópia gravável. `CultureInfo.GetCultureInfo(...)` e `CultureInfo.InvariantCulture` retornam instâncias somente leitura, e atribuir às propriedades de `NumberFormat` lança `InvalidOperationException: Instance is read-only.` Chame `Clone()` no `NumberFormatInfo`, ou crie uma cultura com `new CultureInfo("en-US")`, que é gravável.
3. Atribua os tamanhos de grupo. Defina `NumberGroupSizes = [3, 2]` para `N` e padrões personalizados. Defina também `CurrencyGroupSizes` e `PercentGroupSizes` se formatar com `C` ou `P`; são arrays independentes.
4. Congele-o com `NumberFormatInfo.ReadOnly(nfi)` e guarde-o em um campo `static readonly`, para que todos os chamadores compartilhem um único provedor imutável.
5. Passe-o como `IFormatProvider` para `ToString`, `TryFormat`, `string.Format` ou `string.Create`, ou defina-o como `CurrentCulture` se a thread inteira deve usá-lo.

Em código:

```csharp
// .NET 11, C# 14
using System.Globalization;

public static class IndianNumberFormat
{
    public static readonly NumberFormatInfo Grouping = Create();

    private static NumberFormatInfo Create()
    {
        var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
        nfi.NumberGroupSizes   = [3, 2];
        nfi.CurrencyGroupSizes = [3, 2];
        nfi.PercentGroupSizes  = [3, 2];
        nfi.CurrencySymbol     = "₹"; // invariant default is the generic ¤
        return NumberFormatInfo.ReadOnly(nfi);
    }
}

decimal amount = 123456789.5m;
Console.WriteLine(amount.ToString("N2", IndianNumberFormat.Grouping)); // 12,34,56,789.50
Console.WriteLine(amount.ToString("C",  IndianNumberFormat.Grouping)); // ₹12,34,56,789.50
```

Se você esquecer o passo 3 para moeda, obtém uma migração pela metade confusa. Alterando só `NumberGroupSizes`, `amount.ToString("C", nfi)` ainda imprimiu `¤123,456,789.50` no meu teste, porque o formato `C` lê `CurrencyGroupSizes`, que continuava `[3]`.

Para mudar o agrupamento de uma requisição ou thread inteira sem mexer no idioma de todo o resto, altere uma cultura gravável:

```csharp
// .NET 11, C# 14
using System.Globalization;

var culture = new CultureInfo("en-US");          // writable, unlike GetCultureInfo
culture.NumberFormat.NumberGroupSizes = [3, 2];
CultureInfo.CurrentCulture = culture;

Console.WriteLine($"{123456789:N0}");            // 12,34,56,789
Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0:N0}", 123456789)); // 123,456,789
```

A segunda linha lembra que um provedor explícito sempre prevalece sobre `CurrentCulture`.

## Como o array NumberGroupSizes é interpretado

As regras, verificadas contra o runtime em vez de aceitas na fé:

- O elemento 0 é o tamanho do grupo mais próximo do ponto decimal. O elemento 1 é o próximo grupo à esquerda, e assim por diante.
- O **último elemento se repete** para todos os grupos restantes. É por isso que `[3, 2]` continua produzindo grupos de dois indefinidamente.
- Se o último elemento for `0`, os dígitos restantes **não são agrupados** de forma alguma.
- Todo elemento deve estar entre 1 e 9, exceto o último, que pode ser 0. Qualquer outra coisa lança `ArgumentException` com a mensagem "Every element in the value array should be between one and nine, except for the last element, which can be zero."

Veja o que arrays diferentes fazem com `1234567890`:

```csharp
// .NET 11, C# 14
using System.Globalization;

var nfi = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
long n = 1234567890;

nfi.NumberGroupSizes = [3];       Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,890
nfi.NumberGroupSizes = [3, 2];    Console.WriteLine(n.ToString("N0", nfi)); // 1,23,45,67,890
nfi.NumberGroupSizes = [3, 0];    Console.WriteLine(n.ToString("N0", nfi)); // 1234567,890
nfi.NumberGroupSizes = [3, 2, 0]; Console.WriteLine(n.ToString("N0", nfi)); // 12345,67,890
nfi.NumberGroupSizes = [4];       Console.WriteLine(n.ToString("N0", nfi)); // 12,3456,7890
nfi.NumberGroupSizes = [1, 2, 3]; Console.WriteLine(n.ToString("N0", nfi)); // 1,234,567,89,0
nfi.NumberGroupSizes = [0];       Console.WriteLine(n.ToString("N0", nfi)); // 1234567890
nfi.NumberGroupSizes = [];        Console.WriteLine(n.ToString("N0", nfi)); // 1234567890

nfi.NumberGroupSizes = [3, 0, 2]; // ArgumentException: 0 is only allowed last
nfi.NumberGroupSizes = [10];      // ArgumentException: max is 9
```

`[4]` é o formato que você quer para o agrupamento do leste asiático por dez mil (wan/man), se um design pedir; nenhuma cultura embutida do .NET o usa por padrão. `[3, 0]` é útil quando uma especificação diz "separar apenas os milhares".

O getter retorna uma cópia do array. Escrever `nfi.NumberGroupSizes[0] = 9` compila e executa, mas não muda nada: no meu teste a saída continuou `12,34,56,789.50`. Sempre atribua um novo array.

## Quais formatos respeitam o agrupamento e quais não

Executei todos os caminhos comuns com `en-IN`:

| Chamada | Saída |
|---|---|
| `1234567890123L.ToString("N0", inr)` | `12,34,56,78,90,123` |
| `amount.ToString("#,##0.00", inr)` | `12,34,56,789.50` |
| `BigInteger.Parse("123456789012345").ToString("N0", inr)` | `12,34,56,78,90,12,345` |
| `12345678f.ToString("N0", inr)` | `1,23,45,678` |
| `int.MinValue.ToString("N0", inr)` | `-2,14,74,83,648` |
| `123456789.TryFormat(span, out _, "N0", inr)` | `12,34,56,789` |
| `1234567.ToString("D", inr)` / `"G"` / `"F2"` | `1234567` / `1234567` / `1234567.89` |

Portanto `N`, `C`, `P` e padrões personalizados com `,` seguem os arrays, inclusive no caminho `TryFormat` sem alocação. `D`, `G`, `F`, `E` e o `ToString()` sem parâmetros nunca agrupam, em nenhuma cultura.

Um detalhe do formato personalizado costuma pegar as pessoas: a posição da vírgula em um padrão personalizado não importa. `123456789.ToString("#,##,##0", enUS)` imprime `123,456,789`, e não `12,34,56,789`. Uma vírgula entre marcadores de dígito apenas liga o agrupamento; os tamanhos sempre vêm de `NumberGroupSizes`. Você não consegue o agrupamento indiano escrevendo o padrão "certo". É preciso mudar o provedor. Uma vírgula logo antes do ponto decimal (ou no final) é um recurso totalmente diferente: ela divide por 1.000 por vírgula, então `"0,,"` transforma `123456789` em `123`.

## Armadilhas

### O modo de globalização invariante imprime em silêncio o agrupamento ocidental

Esta é a que vai para produção. Muitas imagens de contêiner e apps Native AOT definem `<InvariantGlobalization>true</InvariantGlobalization>` (ou `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`) para dispensar a dependência do ICU. Nesse modo, `CultureInfo.GetCultureInfo("en-IN")` lança `CultureNotFoundException: Only the invariant culture is supported in globalization-invariant mode.` Isso pelo menos é barulhento.

A versão silenciosa acontece quando alguém também define `PredefinedCulturesOnly` como `false` (`DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY=0`) para fazer essa exceção sumir. Aí `new CultureInfo("en-IN")` funciona, mas a cultura carrega dados invariantes. Medi `sizes=3`, `123,456,789` de `N0` e `¤` como símbolo de moeda, sem exceção e sem aviso. Seus usuários indianos recebem vírgulas americanas.

Se você monta o `NumberFormatInfo` a partir de `InvariantCulture`, como na classe `IndianNumberFormat` acima, o agrupamento também funciona no modo invariante, porque nada depende de dados do ICU. É a opção mais robusta para contêineres. Se você precisa da cultura `en-IN` completa, mantenha o ICU na imagem; a [correção do ICU em contêineres](/pt-br/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) percorre os pacotes, e a [comparação de implantação em contêineres](/pt-br/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) mostra quais tipos de imagem ativam o modo invariante.

### A precisão padrão de "N" não é portável

Neste Mac, o ICU informou `NumberDecimalDigits = 3` para `en-IN`, `hi-IN`, `en-US` e `en-GB`, então `amount.ToString("N", inr)` imprimiu `12,34,56,789.500` com três casas decimais, enquanto `CurrencyDecimalDigits` ficou em 2. No modo invariante, a mesma chamada imprimiu duas casas. Os dados de cultura vêm do ICU do sistema operacional (ou do NLS em configurações antigas do Windows), então o padrão pode diferir entre seu notebook e seu servidor. Sempre passe uma precisão explícita: `N0`, `N2`, nunca `N` sozinho, para qualquer coisa que um usuário ou um teste compare.

### O parse ignora as posições dos grupos

`decimal.Parse("1,23,45,678.90", NumberStyles.Number, enUS)` retorna `12345678.90`, e `decimal.Parse("12,345,678", NumberStyles.Number, inr)` também. Com `NumberStyles.AllowThousands`, o .NET aceita separadores de grupo em qualquer ponto da parte inteira e não os valida contra `NumberGroupSizes`. Isso é conveniente para aceitar os dois estilos de entrada, mas significa que o parse não é um validador. Se você precisa rejeitar `12,345,678` em um campo no formato indiano, verifique a forma com uma regex como `^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$` antes de fazer o parse.

### Um separador diferente

Guias de estilo indianos às vezes pedem um espaço fino em vez de vírgula. Defina `NumberGroupSeparator` (e `CurrencyGroupSeparator` para `C`) no mesmo `NumberFormatInfo` clonado; testei `"\u202F"` (espaço estreito sem quebra) e obtive `12 34 56 789` com os tamanhos inalterados. Use um espaço sem quebra para que o número nunca seja quebrado entre linhas.

## Imprimindo "12.35 lakh" e "2.5 crore"

`NumberGroupSizes` controla separadores, não palavras. O .NET não tem um formatador compacto embutido que produza "lakh" ou "crore" (o conceito `CompactDecimalFormat` existe no ICU, mas não é exposto por `ToString`). Um pequeno helper cobre a necessidade comum de UI:

```csharp
// .NET 11, C# 14
using System.Globalization;

static string ToLakhCrore(decimal value, int decimals = 2)
{
    var inr = CultureInfo.GetCultureInfo("en-IN");
    const decimal Lakh = 1_00_000m, Crore = 1_00_00_000m;
    decimal abs = Math.Abs(value);
    string sign = value < 0 ? "-" : "";
    string fmt = "#,##0." + new string('#', decimals);

    // Round in the target unit first, then promote if rounding crossed the boundary.
    decimal inLakh = Math.Round(abs / Lakh, decimals, MidpointRounding.AwayFromZero);
    if (abs >= Crore || inLakh >= 100m)
        return sign + Math.Round(abs / Crore, decimals, MidpointRounding.AwayFromZero).ToString(fmt, inr) + " crore";
    if (abs >= Lakh || inLakh >= 1m)
        return sign + inLakh.ToString(fmt, inr) + " lakh";
    return sign + abs.ToString(fmt, inr);
}

Console.WriteLine(ToLakhCrore(45_000m));         // 45,000
Console.WriteLine(ToLakhCrore(1_25_000m));       // 1.25 lakh
Console.WriteLine(ToLakhCrore(12_34_567m));      // 12.35 lakh
Console.WriteLine(ToLakhCrore(99_99_999m));      // 1 crore
Console.WriteLine(ToLakhCrore(2_50_00_000m));    // 2.5 crore
Console.WriteLine(ToLakhCrore(1234_56_78_901m)); // 1,234.57 crore
Console.WriteLine(ToLakhCrore(-3_50_000m));      // -3.5 lakh
```

O passo "arredondar primeiro, depois promover" importa. Uma versão ingênua que verifica `abs >= Crore` antes de arredondar imprime `100 lakh` para `99,99,999`, o que nenhum leitor indiano escreveria. Observe os separadores de dígitos nos literais C# (`1_00_000m`): o compilador aceita `_` em qualquer lugar entre dígitos, então você pode espelhar o agrupamento indiano no código-fonte para facilitar a leitura.

Se o helper rodar em um contêiner com globalização invariante, troque `CultureInfo.GetCultureInfo("en-IN")` pelo provedor `IndianNumberFormat.Grouping` mostrado antes, pelos motivos da armadilha acima.

## Notas de desempenho

Os tamanhos de grupo são lidos uma vez por chamada de formatação a partir de arrays que já estão no `NumberFormatInfo`, então `[3, 2]` custa o mesmo que `[3]`. O erro caro é criar um novo `CultureInfo` ou clonar um `NumberFormatInfo` a cada chamada. Guarde o provedor em cache em um campo `static readonly`, como mostrado acima, e use `TryFormat` em um buffer na pilha ao formatar em um loop crítico; a [comparação de StringBuilder com interpolação](/pt-br/2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11/) mostra quanto o caminho sem alocação economiza ao montar strings maiores a partir de muitos números.

## Relacionados

- [Fix: Couldn't find a valid ICU package installed on the system in a .NET container](/pt-br/2026/07/fix-couldnt-find-a-valid-icu-package-installed-on-the-system/) se `en-IN` lançar exceção no Docker.
- [Framework-dependent vs self-contained vs Native AOT for a .NET 11 container image](/pt-br/2026/09/framework-dependent-vs-self-contained-vs-native-aot-for-a-dotnet-11-container-image/) para saber onde a globalização invariante é ativada.
- [How to use Native AOT with ASP.NET Core minimal APIs](/pt-br/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/), que usa o modo invariante por padrão.
- [.NET 11 can round-trip a double as hex, bit for bit](/pt-br/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/) para outro canto da formatação numérica e de `NumberStyles`.

## Fontes

- [NumberFormatInfo.NumberGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.numbergroupsizes) no Microsoft Learn.
- [NumberFormatInfo.CurrencyGroupSizes property](https://learn.microsoft.com/en-us/dotnet/api/system.globalization.numberformatinfo.currencygroupsizes) no Microsoft Learn.
- [Standard numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/standard-numeric-format-strings) e [custom numeric format strings](https://learn.microsoft.com/en-us/dotnet/standard/base-types/custom-numeric-format-strings), incluindo o separador de grupo e o especificador de escala numérica.
- [Globalization and ICU in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/globalization-icu).
- [Culture creation and case mapping in globalization-invariant mode](https://learn.microsoft.com/en-us/dotnet/core/compatibility/globalization/6.0/culture-creation-invariant-mode), a mudança do .NET 6 que introduziu `PredefinedCulturesOnly`.
