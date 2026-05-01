---
title: "Helper de IsolatedStorageSettings para Windows Phone"
description: "Una clase simple IsolatedStorageSettingsHelper para Windows Phone con métodos para obtener, guardar y guardar en lote elementos en IsolatedStorageSettings."
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "es"
translationOf: "2012/11/insolated-storage-settings-helper-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
Decidí compartir una clase helper realmente simple que uso a menudo en mis apps de Windows Phone. Se llama IsolatedStorageSettingsHelper y solo tiene tres métodos:

-   **T GetItem<T>(string key)** -- obtiene el objeto con la clave especificada desde IsolatedStorageSettings. Si no hay objeto con esa clave, devuelve null. Si el objeto no es del tipo especificado, devuelve una nueva instancia de T.
-   **void SaveItem(string key, object item)** -- guarda el item pasado como parámetro en IsolatedStorageSettings usando la clave indicada.
-   **void SaveItems(Dictionary<string, object> items)** -- se usa para guardar varios items a la vez. Todos los items del diccionario se guardan en IsolatedStorageSettings con sus respectivas claves.

No es mucho, pero es todo lo que he necesitado para mis apps. Espero que sirva. Código abajo.

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
