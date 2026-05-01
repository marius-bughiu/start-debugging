---
title: "Windows Phone 用 IsolatedStorageSettings ヘルパー"
description: "Windows Phone 向けのシンプルな IsolatedStorageSettingsHelper クラス。IsolatedStorageSettings 上のアイテムを取得、保存、まとめて保存するメソッドを提供します。"
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "ja"
translationOf: "2012/11/insolated-storage-settings-helper-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
私が Windows Phone アプリでよく使っている、本当にシンプルな helper クラスを共有しようと思います。名前は IsolatedStorageSettingsHelper で、メソッドは 3 つだけです。

-   **T GetItem<T>(string key)** -- IsolatedStorageSettings から指定したキーのオブジェクトを取得します。そのキーのオブジェクトがなければ null を返します。指定された型でない場合は、T の新しいインスタンスを返します。
-   **void SaveItem(string key, object item)** -- パラメーターで渡したアイテムを、指定キーで IsolatedStorageSettings に保存します。
-   **void SaveItems(Dictionary<string, object> items)** -- 複数のアイテムを一度に保存するために使います。dictionary のすべてのアイテムが、それぞれのキーで IsolatedStorageSettings に保存されます。

これだけですが、私のアプリで必要だったのはこれだけでした。お役に立てば幸いです。コードは下のとおりです。

```csharp
public class IsolatedStorageSettingsHelper
{
   public static void SaveItem(string key, object item)
   {
      IsolatedStorageSettings.ApplicationSettings[key] = item;
      IsolatedStorageSettings.ApplicationSettings.Save();
   }

   public static void SaveItems(Dictionary<string, object> items)
   {
      foreach (var item in items)
         IsolatedStorageSettings.ApplicationSettings[item.Key] = item.Value;
      IsolatedStorageSettings.ApplicationSettings.Save();
   }

   public static T GetItem<T>(string key)
   {
      T item;
      try
      {
         IsolatedStorageSettings.ApplicationSettings.TryGetValue<T>(key, out item);
      }
      catch (InvalidCastException ice)
      {
         return default(T);
      }
      return item;
   }
}
```
