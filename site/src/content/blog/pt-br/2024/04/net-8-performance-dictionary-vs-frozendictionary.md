---
title: ".NET 8 ToFrozenDictionary: Dictionary vs FrozenDictionary"
description: "Converta um Dictionary em um FrozenDictionary com `ToFrozenDictionary()` no .NET 8 para leituras mais rápidas. Benchmark, quando usar e o trade-off em tempo de build."
pubDate: 2024-04-27
updatedDate: 2025-03-27
tags:
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2024/04/net-8-performance-dictionary-vs-frozendictionary"
translatedBy: "claude"
translationDate: 2026-05-01
---
Com o .NET 8 somos apresentados a um novo tipo de dicionário que melhora o desempenho das operações de leitura. O detalhe: você não pode fazer alterações nas chaves e nos valores depois que a coleção for criada. Esse tipo é particularmente útil para coleções que são preenchidas no primeiro uso e depois mantidas por toda a vida útil de um serviço de longa duração.

Vamos ver o que isso significa em números. Estou interessado em duas coisas:

-   o desempenho da criação do dicionário, já que o trabalho feito para a otimização de leitura provavelmente terá impacto nisso
-   o desempenho de leitura para uma chave aleatória da lista

## Impacto no desempenho durante a criação

Para este teste, pegamos 10.000 `KeyValuePair<string, string>` já instanciados e criamos três tipos diferentes de dicionários:

-   um dicionário normal: `new Dictionary(source)`
-   um dicionário congelado: `source.ToFrozenDictionary(optimizeForReading: false)`
-   e um dicionário congelado otimizado para leitura: `source.ToFrozenDictionary(optimizeForReading: true)`

E medimos quanto tempo cada uma dessas operações leva usando o BenchmarkDotNet. Estes são os resultados:

```plaintext
|                              Method |       Mean |    Error |   StdDev |
|------------------------------------ |-----------:|---------:|---------:|
|                          Dictionary |   284.2 us |  1.26 us |  1.05 us |
|        FrozenDictionaryNotOptimized |   486.0 us |  4.71 us |  4.41 us |
| FrozenDictionaryOptimizedForReading | 4,583.7 us | 13.98 us | 12.39 us |
```

Já sem otimização, podemos ver que criar o `FrozenDictionary` leva cerca do dobro do tempo necessário para criar o dicionário normal. Mas o impacto real aparece quando otimizamos os dados para leitura. Nesse cenário, temos um aumento de `16x`. Vale a pena? Quão rápida é a leitura?

## Desempenho de leitura do dicionário congelado

Neste primeiro cenário, em que testamos a recuperação de uma única chave do 'meio' do dicionário, obtemos os seguintes resultados:

```plaintext
|                              Method |      Mean |     Error |    StdDev |
|------------------------------------ |----------:|----------:|----------:|
|                          Dictionary | 11.609 ns | 0.0170 ns | 0.0142 ns |
|        FrozenDictionaryNotOptimized | 10.203 ns | 0.0218 ns | 0.0193 ns |
| FrozenDictionaryOptimizedForReading |  4.789 ns | 0.0121 ns | 0.0113 ns |
```

Em essência, o `FrozenDictionary` parece ser `2,4x` mais rápido que o `Dictionary` normal. Uma melhoria considerável!

Algo importante a observar são as diferentes unidades de medida aqui. Para a criação, os tempos estão na faixa de microssegundos e, no total, perdemos cerca de 4299 us (microssegundos). Isso, convertido para ns (nanossegundos), são 4.299.000 ns. Ou seja, para ter um benefício de desempenho usando o `FrozenDictionary`, precisaríamos fazer pelo menos 630.351 operações de leitura sobre ele. É muita leitura.

Vejamos mais alguns cenários de teste e qual o impacto deles no desempenho.

### Cenário 2: dicionário pequeno (100 itens)

Os múltiplos parecem se manter ao lidar com um dicionário menor. Em termos de custo-benefício, parece que começamos a ter ganho um pouco antes, depois de cerca de 4800 operações de leitura.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|                          Dictionary_Create |  1.477 us | 0.0033 us | 0.0028 us |
| FrozenDictionaryOptimizedForReading_Create | 31.922 us | 0.1346 us | 0.1259 us |
|                            Dictionary_Read | 10.788 ns | 0.0156 ns | 0.0122 ns |
|   FrozenDictionaryOptimizedForReading_Read |  4.444 ns | 0.0155 ns | 0.0129 ns |
```

### Cenário 3: ler chaves de posições diferentes

Neste cenário, testamos se o desempenho é de alguma forma afetado pela chave que estamos recuperando (sua posição na estrutura de dados interna). E, com base nos resultados, isso não tem nenhum impacto sobre o desempenho de leitura.

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|  FrozenDictionaryOptimizedForReading_First |  4.314 ns | 0.0102 ns | 0.0085 ns |
| FrozenDictionaryOptimizedForReading_Middle |  4.311 ns | 0.0079 ns | 0.0066 ns |
|   FrozenDictionaryOptimizedForReading_Last |  4.314 ns | 0.0180 ns | 0.0159 ns |
```

### Cenário 4: dicionário grande (10 milhões de itens)

No caso de dicionários grandes, o desempenho de leitura permanece quase o mesmo. Vemos um aumento de 18% no tempo de leitura, apesar de um aumento de `1000x` no tamanho do dicionário. No entanto, o número-alvo de leituras necessárias para se ter um ganho líquido de desempenho sobe de forma significativa, para 2.135.735.439, ou seja, mais de 2 bilhões de leituras.

```plaintext
|                                     Method |        Mean |     Error |    StdDev |
|------------------------------------------- |------------:|----------:|----------:|
|                          Dictionary_Create |    905.1 ms |   2.56 ms |   2.27 ms |
| FrozenDictionaryOptimizedForReading_Create | 13,886.4 ms | 276.22 ms | 483.77 ms |
|                            Dictionary_Read |   11.203 ns | 0.2601 ns | 0.3472 ns |
|   FrozenDictionaryOptimizedForReading_Read |    5.125 ns | 0.0295 ns | 0.0230 ns |
```

### Cenário 5: chave complexa

Aqui os resultados são muito interessantes. Nossa chave é assim:

```cs
public class MyKey
{
    public string K1 { get; set; }

    public string K2 { get; set; }
}
```

E, como podemos ver, neste caso quase não há melhoria de desempenho na leitura em comparação com o `Dictionary` normal, enquanto a criação do dicionário é cerca de 4 vezes mais lenta.

```plaintext
|                                     Method |     Mean |     Error |    StdDev |
|------------------------------------------- |---------:|----------:|----------:|
|                          Dictionary_Create | 247.7 us |   3.27 us |   3.05 us |
| FrozenDictionaryOptimizedForReading_Create | 991.2 us |   8.75 us |   8.18 us |
|                            Dictionary_Read | 6.344 ns | 0.0602 ns | 0.0533 ns |
|   FrozenDictionaryOptimizedForReading_Read | 6.041 ns | 0.0954 ns | 0.0845 ns |
```

### Cenário 6: usando records

Mas e se usássemos um `record` em vez de uma `class`? Isso deveria oferecer mais desempenho, certo? Aparentemente não. É ainda mais estranho, já que os tempos de leitura saltam de `6 ns` para `44 ns`.

```plaintext
|                                     Method |       Mean |    Error |   StdDev |
|------------------------------------------- |-----------:|---------:|---------:|
|                          Dictionary_Create |   654.1 us |  2.29 us |  2.14 us |
| FrozenDictionaryOptimizedForReading_Create | 1,761.4 us |  8.67 us |  8.11 us |
|                            Dictionary_Read |   45.37 ns | 0.088 ns | 0.082 ns |
|   FrozenDictionaryOptimizedForReading_Read |   44.44 ns | 0.120 ns | 0.107 ns |
```

## Conclusões

Com base nos cenários testados, a única melhoria que observamos foi ao usar chaves do tipo `string`. Qualquer outra coisa que tentamos até aqui levou ao mesmo desempenho de leitura do `Dictionary` normal, com uma sobrecarga adicional na criação.

Mesmo quando você usa `string` como chave do seu `FrozenDictionary`, é preciso considerar quantas leituras você fará durante a vida útil desse dicionário, já que há uma sobrecarga associada à criação. No teste de 10.000 itens, essa sobrecarga foi de cerca de 4.299.000 ns. O desempenho de leitura teve uma melhoria de `2,4x`, caindo de `11,6 ns` para `4,8 ns`, mas isso ainda significa que você precisa de cerca de 630.351 operações de leitura sobre o dicionário antes de ter um ganho líquido de desempenho.
