---
title: "code snippets を使って生産性を上げる"
description: "Visual Studio の code snippets が、短いエイリアスで再利用可能なコード片を挿入できる仕組みで、いかに生産性を上げてくれるかを解説します。"
pubDate: 2012-01-06
updatedDate: 2023-11-04
tags:
  - "csharp"
  - "visual-studio"
lang: "ja"
translationOf: "2012/01/improve-productivity-by-using-code-snippets"
translatedBy: "claude"
translationDate: 2026-05-01
---
code snippets は、後で短いエイリアスからプロジェクトに挿入できるコード片を定義できるため、生産性を上げる素晴らしい手段です。

Visual Studio にはかなり前から存在していますが、それが何で、何をして、どう使えば自分の役に立つのかを知っている人は多くありません。聞いたことがあるのと使うのは別の話です。コードを書く人なら、ほぼ誰もが人生で一度は使ったことがあるはずで、思い浮かぶ最良の例は foreach です。何度 foreach と入力して TAB を 2 回押し、カーソル位置に魔法のようにコードが現れたことか。そう、それが code snippet です。同じようなものはまだまだあります。クラス定義、constructors、destructors、structures、for、do-while などに対する code snippets があり、(C# 向けの) 完全な一覧はこちら: [Visual C# Default Code Snippets](http://msdn.microsoft.com/en-US/library/z41h7fat%28v=VS.100%29.aspx "Visual C# Default Code Snippets")。

ただ、それは Visual Studio に標準で同梱されているものに過ぎず、code snippets が提供できることのほんの一部です。本当に良いのは、自分で snippet を定義し、好きな場所と好きなタイミングでプロジェクトに挿入できる点です。来週のどこかで、自分の code snippet を作る簡単なチュートリアルを書こうと思います。それまでは [このページを参照](http://msdn.microsoft.com/en-us/library/ms165393.aspx "can check out this page") してみてください。

既存のものに加えて使える、いくつか汎用的な snippets を探している方は、[codeplex のいい感じのプロジェクト](http://vssnippets.codeplex.com/ "C# Code Snippets") があり、コレクションに追加できる 38 個の C# code snippets が含まれています。Visual Studio に追加するのは簡単です。上のリンクから zip をダウンロードして展開してください。次に Tools -> Code Snippet Manager に行く (または Ctrl + K, Ctrl + B) を押し、Import をクリック。zip を展開したフォルダーへ移動し、フォルダー内のすべての code snippets を選択して Open を押し、追加先のフォルダー / カテゴリを選び (既定では My Code Snippets)、finish をクリックします。これで使えるようになります。動くかどうか試すには、例えば task や thread をどこかに入力し、TAB を 2 回押してください。コードが自動で挿入されるはずです。

今回はここまでです。約束どおり、自分の code snippets の作り方と、もしかしたら snippet designers についても、来週やります。
