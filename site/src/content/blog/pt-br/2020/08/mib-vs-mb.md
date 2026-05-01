---
title: "Qual a diferença entre um MegaByte (MB) e um MebiByte (MiB)?"
description: "Conheça a diferença entre megabytes (MB) e mebibytes (MiB), por que 1 MB equivale a 1000 KB (não 1024) e como diferentes sistemas operacionais lidam com essas unidades."
pubDate: 2020-08-07
updatedDate: 2023-10-28
tags:
  - "technology"
lang: "pt-br"
translationOf: "2020/08/mib-vs-mb"
translatedBy: "claude"
translationDate: 2026-05-01
---
Se você aprendeu que 1 MB = 1024 KB, aprendeu errado. 1 MB na verdade equivale a 1000 KB, enquanto 1 MiB = 1024 KiB. O prefixo "mebi" em MebiByte (MiB) significa _mega_ e _binário_, indicando que se trata de uma potência de 2; daí valores como 32, 64, 128, 256, 512, 1024, 2048 e assim por diante.

O megabyte (MB), por outro lado, é sempre uma potência de 10, então temos 1 KB = 1000 bytes, 1 MB = 1000 KB e 1 GB = 1000 MB.

## Diferenças entre sistemas operacionais

Quase cada sistema operacional lida com essas unidades de forma diferente, e o Windows é o mais peculiar. Na verdade ele calcula tudo em mebibytes e depois adiciona KB/MB/GB no final, dizendo basicamente que é megabyte. Assim, um arquivo de 1024 bytes é mostrado como 1.00 KB, quando na realidade é 1.00 KiB ou 1.024 KB.

Você mesmo pode testar criando um arquivo TXT com 1000 caracteres (1 caractere = 1 byte) e verificando as informações do arquivo.

![MegaByte vs. MebiByte - Windows mostrando 1024 bytes como 1 KB em vez de 1 KiB ou 1.024 KB](/wp-content/uploads/2020/08/image-2.png)

Windows mostrando 1024 bytes como 1 KB em vez de 1 KiB ou 1.024 KB

Esse tipo de exibição leva a todo tipo de confusão; os usuários costumam se sentir enganados ao comprar um HD de 256 GB e ver no Windows 238 GB (quando na verdade é 238 GiB, equivalentes a 256 GB).

Outros sistemas operacionais que adotam essa definição em potências de 10 são macOS, iOS, Ubuntu e Debian. Esse jeito de medir memória também é coerente com os demais usos dos prefixos SI na computação, como velocidades de clock de CPU ou medidas de desempenho.

Observação: o macOS media memória em unidades de potências de 2 antes do Mac OS X 10.6 Snow Leopard, quando a Apple migrou para unidades baseadas em potências de 10. O mesmo se aplica a partir do iOS 11.

## Lidando com definições conflitantes

O mebibyte foi criado para substituir o megabyte por entrar em conflito com a definição do prefixo "mega" no Sistema Internacional de Unidades (SI). Mas, apesar de ter sido estabelecido pela International Electrotechnical Commission (IEC) em 1998 e aceito por todas as principais organizações de padrões, ele não é amplamente reconhecido pela indústria nem pela mídia.

Os prefixos da IEC fazem parte do Sistema Internacional de Quantidades, e a IEC especificou ainda que o kilobyte deve ser usado apenas para se referir a 1000 bytes. Essa é a definição moderna atual do kilobyte.

## Comparação de unidades decimais e binárias

Por fim, deixo você com uma tabela contendo todos os nomes das diferentes unidades de medida, múltiplos de bytes. Uma observação: os prefixos ronna- e quetta- foram adotados recentemente, em 2022, pelo Bureau Internacional de Pesos e Medidas (BIPM), mas apenas para as unidades em potências de 10. As contrapartes binárias foram apresentadas em um documento de consulta, mas ainda não foram adotadas pela IEC ou pela ISO.

| Valor decimal | Métrico | Valor binário | IEC | Memória |
| --- | --- | --- | --- | --- |
| 1 | B byte | 1 | B byte | B byte |
| 1000 | kB kilobyte | 1024 | KiB kibibyte | kB kilobyte |
| 1000^2 | MB megabyte | 1024^2 | MiB mebibyte | MB megabyte |
| 1000^3 | GB gigabyte | 1024^3 | GiB gibibyte | GB gigabyte |
| 1000^4 | TB terabyte | 1024^4 | TiB tebibyte | TB terabyte |
| 1000^5 | PB petabyte | 1024^5 | PiB pebibyte | |
| 1000^6 | EB exabyte | 1024^6 | EiB exbibyte | |
| 1000^7 | ZB zettabyte | 1024^7 | ZiB zebibyte | |
| 1000^8 | YB yottabyte | 1024^8 | YiB yobibyte | |
| 1000^9 | RB ronnabyte | | | |
| 1000^10 | QB quettabyte | | | |

*Múltiplos de bytes em decimal e binário*
