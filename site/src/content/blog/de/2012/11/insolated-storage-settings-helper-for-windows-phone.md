---
title: "IsolatedStorageSettings-Helper für Windows Phone"
description: "Eine einfache IsolatedStorageSettingsHelper-Klasse für Windows Phone mit Methoden zum Abrufen, Speichern und Massen-Speichern von Items in IsolatedStorageSettings."
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "de"
translationOf: "2012/11/insolated-storage-settings-helper-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
Ich habe beschlossen, eine wirklich einfache Helper-Klasse zu teilen, die ich in meinen Windows-Phone-Apps häufig verwende. Sie heißt IsolatedStorageSettingsHelper und hat nur drei Methoden:

-   **T GetItem<T>(string key)** -- holt das Objekt mit dem angegebenen Schlüssel aus IsolatedStorageSettings. Wenn kein Objekt mit diesem Schlüssel existiert, gibt sie null zurück. Falls das Objekt nicht vom angegebenen Typ ist, wird eine neue Instanz von T zurückgegeben.
-   **void SaveItem(string key, object item)** -- speichert das als Parameter übergebene Item unter dem angegebenen Schlüssel in IsolatedStorageSettings.
-   **void SaveItems(Dictionary<string, object> items)** -- zum Speichern mehrerer Items auf einmal. Alle Einträge im Dictionary werden mit ihren jeweiligen Schlüsseln in IsolatedStorageSettings gespeichert.

Das ist nicht viel, aber das ist alles, was ich für meine Apps je gebraucht habe. Hoffentlich hilft es. Der Code folgt unten.

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
