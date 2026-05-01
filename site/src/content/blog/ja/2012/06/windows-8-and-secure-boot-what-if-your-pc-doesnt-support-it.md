---
title: "Windows 8 と Secure Boot - PC が対応していない場合はどうする？"
description: "Windows 8 のインストール時に 'Secure Boot isn't compatible with your PC' エラーが出たときの対処方法と、Secure Boot とは実際に何かを解説します。"
pubDate: 2012-06-05
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "ja"
translationOf: "2012/06/windows-8-and-secure-boot-what-if-your-pc-doesnt-support-it"
translatedBy: "claude"
translationDate: 2026-05-01
---
今日、(うっかり) Windows 7 を Windows 8 にアップグレードしようとしたところ、互換性チェックで 6 つのエラーに遭遇しました。そのうちの 1 つはこれです。

> Secure Boot isn't compatible with your PC

最初は、Consumer Preview は問題なく動いていた (少しの例外を除いて) のに Windows 8 をインストールできないのかと思って嫌な予感がしました。でも、いくつか検索してみてわかったのは、これはまったく問題ではない、ということでした。Secure Boot はスキップできる機能で、それでも全体は問題なく動きます。

**Secure Boot とは何か？**

Secure Boot は新しい起動プロセス (measured boot) で、UEFI 2.3.1 (Unified Extensible Firmware Interface) と組み合わさることで、現在の BIOS 設計で既に存在する、悪意あるソフトウェアが OS より先にロードされてしまうセキュリティホールに対処します。仕組みは証明書を使うもので -- 基本的に、Microsoft が署名したものでない限り何もロードされません -- つまり malware が入り込めません。

この機能は比較的新しいシステムでのみ利用できます。Trusted Platform Module (TPM) というチップを必要とするためです。このチップは、Secure Boot が依拠する、署名・保護・計測された起動プロセスを保存するのに使われます。

つまり、TPM がなければ Secure Boot もなく、通常の起動だけになるということで -- これによって Windows 8 をマシンにインストールできなくなることはありません。
