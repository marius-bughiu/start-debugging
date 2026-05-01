---
title: "Helper de IsolatedStorageSettings para Windows Phone"
description: "Uma classe simples IsolatedStorageSettingsHelper para Windows Phone com métodos para obter, salvar e salvar em lote itens no IsolatedStorageSettings."
pubDate: 2012-11-03
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "pt-br"
translationOf: "2012/11/insolated-storage-settings-helper-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
Resolvi compartilhar uma classe helper bem simples que uso bastante nos meus apps Windows Phone. Ela se chama IsolatedStorageSettingsHelper e tem só três métodos:

-   **T GetItem<T>(string key)** -- obtém o objeto com a chave informada do IsolatedStorageSettings. Se não houver objeto com essa chave, retorna null. Se o objeto não for do tipo especificado, retorna uma nova instância de T.
-   **void SaveItem(string key, object item)** -- salva o item passado como parâmetro no IsolatedStorageSettings usando a chave informada.
-   **void SaveItems(Dictionary<string, object> items)** -- usado para salvar vários itens de uma vez. Todos os itens do dicionário são salvos no IsolatedStorageSettings com suas respectivas chaves.

Não é muito, mas foi tudo que precisei nos meus apps. Espero que ajude. Código abaixo.

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
