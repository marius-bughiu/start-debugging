---
title: "MegaByte (MB) と MebiByte (MiB) の違いは？"
description: "メガバイト (MB) とメビバイト (MiB) の違い、なぜ 1 MB が 1024 KB ではなく 1000 KB なのか、そして異なる OS がこれらの単位をどのように扱っているかを解説します。"
pubDate: 2020-08-07
updatedDate: 2023-10-28
tags:
  - "technology"
lang: "ja"
translationOf: "2020/08/mib-vs-mb"
translatedBy: "claude"
translationDate: 2026-05-01
---
1 MB = 1024 KB と教わったなら、それは誤りです。実際には 1 MB = 1000 KB で、1 MiB = 1024 KiB です。MebiByte (MiB) の "mebi" は _mega_ と _binary_ を意味し、2 のべき乗であることを示します。だからこそ 32、64、128、256、512、1024、2048 といった値が現れます。

一方、メガバイト (MB) は常に 10 のべき乗で、1 KB = 1000 バイト、1 MB = 1000 KB、1 GB = 1000 MB です。

## OS による違い

ほとんどの OS でこれらの単位の扱い方が異なり、その中でも Windows がもっとも変わっています。実際にはすべてをメビバイトで計算しておきながら、最後に KB/MB/GB を付けて、あたかもメガバイトであるかのように表示します。1024 バイトのファイルは 1.00 KB と表示されますが、実態は 1.00 KiB すなわち 1.024 KB です。

これは自分でも簡単に確認できます。1000 文字 (1 文字 = 1 バイト) の TXT ファイルを作り、ファイル情報を見てみてください。

![MegaByte vs. MebiByte - Windows が 1024 バイトを 1 KiB や 1.024 KB ではなく 1 KB と表示している様子](/wp-content/uploads/2020/08/image-2.png)

Windows が 1024 バイトを 1 KiB や 1.024 KB ではなく 1 KB と表示している

このような表示は混乱の元になり、256 GB のハードドライブを買ったのに Windows では 238 GB と表示される (実際には 238 GiB を意味し、それは 256 GB と等しい) と、ユーザーがだまされたように感じることがよくあります。

10 のべき乗の定義を採用している他の OS には、macOS、iOS、Ubuntu、Debian があります。この方式は、CPU クロック周波数やパフォーマンス指標など、コンピューティングにおける他の SI 接頭辞の使い方とも一貫しています。

メモ: Mac OS X 10.6 Snow Leopard より前の macOS は 2 のべき乗の単位でメモリを測定していましたが、Apple は 10 のべき乗ベースの単位に切り替えました。iOS 11 以降も同様です。

## 矛盾した定義への対処

メビバイトは、メガバイトが国際単位系 (SI) における接頭辞 "mega" の定義と矛盾していたことから、それを置き換えるために設計されました。しかし、1998 年に International Electrotechnical Commission (IEC) によって制定され、主要な標準化団体すべてに受け入れられたにもかかわらず、業界やメディアでは広く認知されていません。

IEC 接頭辞は国際量体系の一部であり、IEC はさらに、kilobyte は 1000 バイトを指すためにのみ使用すべきだと規定しています。これがキロバイトの現代の標準的定義です。

## 10 進数と 2 進数単位の比較

最後に、バイトの倍数を表すさまざまな単位の名称をすべてまとめた表を載せておきます。なお、ronna- と quetta- は最近 -- 2022 年 -- に International Bureau of Weights and Measures (BIPM) によって採用されましたが、10 のべき乗の単位に対してのみです。2 進数の対応物は協議文書で示されたものの、IEC や ISO ではまだ採用されていません。

| 10 進数の値 | メートル法 | 2 進数の値 | IEC | メモリ |
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

*10 進数および 2 進数におけるバイトの倍数*
