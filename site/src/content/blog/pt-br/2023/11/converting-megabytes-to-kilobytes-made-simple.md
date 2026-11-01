---
title: "Convertendo Megabytes para Kilobytes de forma simples"
description: "Converta megabytes para kilobytes multiplicando por 1.000. Veja quando usar 1.024 para converter MiB em KiB, com exemplos e uma tabela de unidades."
pubDate: 2023-11-13
updatedDate: 2026-11-01
tags:
  - "informational"
lang: "pt-br"
translationOf: "2023/11/converting-megabytes-to-kilobytes-made-simple"
translatedBy: "claude"
translationDate: 2026-05-01
---
Para converter megabytes em kilobytes, multiplique por **1.000**: **1 MB = 1.000 kB**. Se você estiver usando as unidades binárias mebibytes e kibibytes, use **1 MiB = 1.024 KiB**. As unidades determinam qual fórmula usar.

## Megabytes, kilobytes e unidades binárias

Os prefixos decimais kilo e mega representam potências de dez. Os prefixos binários kibi e mebi representam potências de dois. A [referência do NIST sobre prefixos binários](https://physics.nist.gov/cuu/Units/binary.html) explica a nomenclatura da IEC e a compara com os prefixos do SI.

| Unidade | Símbolo | Bytes |
| --- | --- | ---: |
| Kilobyte | kB | 1.000 |
| Megabyte | MB | 1.000.000 |
| Kibibyte | KiB | 1.024 |
| Mebibyte | MiB | 1.048.576 |

Embora “KB” seja comum nas interfaces de software, aqui usamos **kB** como símbolo decimal. Alguns programas identificam medidas binárias como KB ou MB, então confira a definição da ferramenta antes de converter o valor exibido. Nosso artigo sobre a [diferença entre MB e MiB](/pt-br/2020/08/mib-vs-mb/) explica essa confusão com mais detalhes.

## A fórmula: de MB para kB

**Kilobytes = megabytes × 1.000**

Por exemplo:

- 5 MB × 1.000 = **5.000 kB**
- 10 MB × 1.000 = **10.000 kB**
- 0,5 MB × 1.000 = **500 kB**

Para converter no sentido inverso, divida por 1.000. Um arquivo de 2.500 kB tem 2,5 MB.

## Quando multiplicar por 1.024

Use 1.024 ao converter entre as unidades binárias **MiB e KiB**:

**Kibibytes = mebibytes × 1.024**

Por exemplo, 5 MiB equivalem a 5.120 KiB. Essa quantidade é diferente de 5 MB, portanto trocar apenas a unidade, sem converter o valor, produz um resultado incorreto.

## Conversão entre unidades decimais e binárias

Para passar de um sistema para o outro, use bytes como etapa intermediária:

1. Multiplique o valor inicial pelo número de bytes da unidade de origem.
2. Divida o resultado pelo número de bytes da unidade de destino.

Por exemplo, 1 MB equivale a 1.000.000 de bytes. Dividindo por 1.024, obtemos **976,5625 KiB**. No sentido inverso, 1 MiB equivale a 1.048.576 bytes, ou **1.048,576 kB**.

Isso também explica por que o mesmo arquivo pode apresentar tamanhos numéricos diferentes em duas ferramentas sem que nenhum byte seja perdido.

## Escolhendo a conversão certa na prática

Antes de usar uma calculadora ou comparar um arquivo com um limite de upload, identifique o significado das unidades dos dois lados. Se o limite estiver documentado em bytes, compare diretamente as quantidades de bytes. Se a documentação disser apenas “MB”, confira se ela usa unidades decimais ou uma convenção binária.

Inclua as unidades nos cabeçalhos das colunas de planilhas, nos relatórios e na documentação das APIs. Um valor como “5.120” é ambíguo sozinho; “5.120 KiB” deixa a quantidade clara.

Também diferencie bytes de bits: **1 byte = 8 bits**. Uma taxa de transferência em megabits por segundo não é um tamanho de arquivo em megabytes.

_Corrigido em 1º de novembro de 2026: uma versão anterior usava incorretamente 1.024 para converter MB em kilobytes. Esse fator se aplica à conversão de MiB para KiB; a conversão decimal de MB para kB usa 1.000._
