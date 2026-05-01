---
title: "Quanto tempo um PC leva para contar até um trillion"
description: "Benchmarking de quanto tempo um PC leva para contar até um trillion e além, com resultados atualizados de 2023."
pubDate: 2013-10-13
updatedDate: 2023-11-05
tags:
  - "csharp"
lang: "pt-br"
translationOf: "2013/10/counting-up-to-one-trillion"
translatedBy: "claude"
translationDate: 2026-05-01
---
Essa é uma pergunta que surgiu numa conversa com um colega sobre uma empresa avaliada em mais de 20 trillion dollars; e simplesmente não conseguíamos imaginar como aquela quantidade de dinheiro pareceria em espécie. Para ter uma noção, calculamos quantas notas de cem dólares seriam necessárias para circundar a Terra uma vez. A resposta foi, se não me engano, em torno de 240.000.000, o que dá cerca de 24 billion US dollars. É muito dinheiro. Quanto tempo uma pessoa levaria para contar tudo isso? Bem, ninguém pode dizer com certeza, mas é da ordem de dezenas de milhares de anos.

Dito isso, dá para ter uma boa ideia de quanto tempo um computador levaria para contar até um trillion. Apenas iterar, sem nenhuma outra ação no meio. Para isso, escrevi um pequeno trecho de código que mede quanto tempo leva para contar até um billion e depois faz contas simples para estimar quanto levaria até valores diferentes, exibindo os resultados de forma amigável.

Os resultados são interessantes. E a resposta é: depende da sua máquina. Mesmo na mesma máquina você terá resultados diferentes dependendo da carga. Mas vejamos os meus por um instante:

**Resultados atualizados em outubro de 2023** -- desta vez em um i9-11900k com refrigeração líquida.

```plaintext
9 minutes, 38 seconds         for 1 trillion (12 zeros)
6 days, 16 hours              for 1 quadrillion (15 zeros)
18 years, 130 days            for 1 quintillion (18 zeros)
18356 years, 60 days          for 1 sextillion (21 zeros)
```

É bem interessante comparar esses resultados com os de 10 anos atrás, quando criei este post originalmente. O tempo caiu de várias horas para menos de 10 minutos. Claro, em parte estamos comparando coisas diferentes, já que o benchmark original rodou em uma CPU de notebook básica, enquanto os números atualizados vêm de uma CPU desktop unlocked com refrigeração líquida. Mas, ainda assim, é curioso ver como isso evolui no tempo.

> Os resultados originais de 2013, executados em um notebook, são os seguintes:
> 
> -   one billion (9 zeros) é alcançado rápido -- 15 segundos
> -   mas chegar a one trillion (12 zeros) -- a diferença é impressionante -- 4 horas e 10 minutos. Basicamente 1000 vezes mais.
> -   as diferenças ficam ainda mais impressionantes ao subir para quadrillions (15 zeros), que levariam 173 dias, e depois para quintillions (18 zeros), que levariam 475 anos
> -   o último para o qual fiz a conta é one sextillion (21 zeros) e prepare-se: meu notebook levaria exatamente 475473 anos, 292 dias, 6 horas, 43 minutos e 52 segundos para iterar até esse valor.

Como eu disse, esses valores dependem muito da máquina. Então tente você mesmo e, se quiser, compartilhe os resultados. Código abaixo:

```cs
using System.Diagnostics;

var sw = new Stopwatch();
sw.Start();

// 10 billion iterations (10 zeros)
for (long i = 1; i <= 10000000000; i++) ;

sw.Stop();

Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100)} for 1 trillion (12 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000)} for 1 quadrillion (15 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000)} for 1 quintillion (18 zeros)");
Console.WriteLine($"{FormatString(sw.ElapsedTicks, 100000000000)} for 1 sextillion (21 zeros)");

Console.ReadKey();

string FormatString(long elapsed, long multiplier)
{
    var span = new TimeSpan(elapsed * multiplier).Duration();

    return string.Format("{0}{1}{2}{3}{4}",
        span.Days > 364 ? $"{span.Days / 365} years, " : "",
        span.Days > 0        ? $"{span.Days % 365} days, "  : "",
        span.Hours > 0       ? $"{span.Hours} hours, "      : "",
        span.Minutes > 0     ? $"{span.Minutes} minutes, "  : "",
        span.Seconds > 0     ? $"{span.Seconds} seconds"    : "");
}
```

## E quanto a iterar todos os GUIDs?

Em seguida, no espírito de engenheiro, mudei para outro assunto -- totalmente relacionado (para mim): a unicidade dos GUIDs. Eu já havia me perguntado quão único realmente é um GUID. E obtive uma resposta na época, mas agora acho que ficou ainda mais claro.

Para começar -- GUIDs costumam ser representados como 32 dígitos hexadecimais. Então podemos pegar o maior número hex de 32 dígitos (`ffffffffffffffffffffffffffffffff`) e convertê-lo para decimal, obtendo: 340.282.366.920.938.463.463.374.607.431.768.211.455 -- isso é 39 dígitos, e arredondando em português: 340 undecillions.

Então, se minha conta está certa, pegamos o tempo do sextillion (18365 anos), multiplicamos por 1.000.000.000.000.000 (os 15 dígitos extras entre undecillion e sextillion), depois por 340, já que falamos de 340 undecillions.

Isso é cerca de 6.244.100.000.000.000.000.000 anos -- ou seja, 6.244.100.000.000 milhões de milênios. É quanto meu computador levaria para iterar todos os valores possíveis de um GUID. Quão único é isso, então?
