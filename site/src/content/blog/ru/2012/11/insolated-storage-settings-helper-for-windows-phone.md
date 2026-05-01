---
title: "Helper для IsolatedStorageSettings в Windows Phone"
description: "Простой класс IsolatedStorageSettingsHelper для Windows Phone с методами получения, сохранения и пакетного сохранения элементов в IsolatedStorageSettings."
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "ru"
translationOf: "2012/11/insolated-storage-settings-helper-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
Решил поделиться очень простым helper-классом, который часто использую в своих Windows Phone приложениях. Он называется IsolatedStorageSettingsHelper и содержит всего три метода:

-   **T GetItem<T>(string key)** -- получает объект по указанному ключу из IsolatedStorageSettings. Если объекта с таким ключом нет, возвращает null. Если объект не указанного типа, возвращает новый экземпляр T.
-   **void SaveItem(string key, object item)** -- сохраняет переданный параметр в IsolatedStorageSettings под указанным ключом.
-   **void SaveItems(Dictionary<string, object> items)** -- используется для сохранения нескольких элементов сразу. Все элементы словаря сохраняются в IsolatedStorageSettings под своими ключами.

Это немного, но мне для моих приложений всегда хватало. Надеюсь, пригодится. Код ниже.

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
