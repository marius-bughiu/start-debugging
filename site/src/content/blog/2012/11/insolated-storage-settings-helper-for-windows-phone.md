---
title: "Insolated Storage Settings Helper for Windows Phone"
description: "Decided that I’d share a really simple helper class that I often use in my Windows Phone apps. It’s called IsolatedStorageSettingsHelper and it only has three methods: This is not much, but that’s all I ever needed for my apps. Hope it will be of help. Code below."
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
---
Decided that I’d share a really simple helper class that I often use in my Windows Phone apps. It’s called IsolatedStorageSettingsHelper and it only has three methods:

-   **T GetItem<T>(string key)** – gets the object with the specified key from the IsolatedStorageSettings. If there isn’t an object with that key it will return null. If the object is not of the type specified then it will return a new instance of T.
-   **void SaveItem(string key, object item)** – saves the item passed as a parameter in the IsolatedStorageSettings using the specified key.
-   **void SaveItems(Dictionary<string, object> items)**  – used for saving multiple items at once. All the items in the dictionary are saved in the IsolatedStorageSettings with their respective keys.

This is not much, but that’s all I ever needed for my apps. Hope it will be of help. Code below.

```cs
public class IsolatedStorageSettingsHelper
{
   public static void SaveItem(string key, object item)
   {
      IsolatedStorageSettings.ApplicationSettings[key] = item;
      IsolatedStorageSettings.ApplicationSettings.Save();
   }

   public static void SaveItems(Dictionary&lt;string, object&gt; items)
   {
      foreach (var item in items)
         IsolatedStorageSettings.ApplicationSettings[item.Key] = item.Value;
      IsolatedStorageSettings.ApplicationSettings.Save();
   }

   public static T GetItem&lt;T&gt;(string key)
   {
      T item;
      try
      {
         IsolatedStorageSettings.ApplicationSettings.TryGetValue&lt;T&gt;(key, out item);
      }
      catch (InvalidCastException ice)
      {
         return default(T);
      }
      return item;
   }
}
```
