---
title: "AdMob роняет приложения Windows Phone. Что использовать вместо него?"
description: "AdMob ронял моё приложение Windows Phone через WebBrowser.InvokeScript. Здесь вы найдёте stack trace, корневую причину и альтернативные рекламные сети, например InnerActive."
pubDate: 2012-09-16
updatedDate: 2023-11-05
tags:
  - "windows-phone"
lang: "ru"
translationOf: "2012/09/admob-crashing-windows-phone-apps-what-is-the-alternative"
translatedBy: "claude"
translationDate: 2026-05-01
---
Не так давно я опубликовал своё первое приложение через девелоперский аккаунт devcenter, а не через global publisher - и буквально через пару дней (или, точнее, недель) стал замечать crash-репорты по приложению. Скачал данные stack trace в надежде понять, в чём проблема, но безуспешно - они почти ничего не сообщали о причине. Знаю только, что дело в браузере.

Мой stack trace:

```plaintext
Frame    Image             Function                                                   Offset
0        coredll.dll       xxx_RaiseException                                         19
1        mscoree3_7.dll                                                               436172
2        mscoree3_7.dll                                                               383681
3        mscoree3_7.dll                                                               540620
4                          TransitionStub                                             0
5                          Microsoft.Phone.Controls.NativeMethods.ValidateHResult     236
6                          Microsoft.Phone.Controls.WebBrowserInterop.InvokeScript    128
7                          Microsoft.Phone.Controls.WebBrowser.InvokeScript           84
8                          .__c__DisplayClass36._RunScripts_b__34                     228
9        mscoree3_7.dll                                                               428848
10       mscoree3_7.dll                                                               222523
11       mscoree3_7.dll                                                               221143
12                         System.Reflection.RuntimeMethodInfo.InternalInvoke         112
13                         System.Reflection.RuntimeMethodInfo.InternalInvoke         1556
14                         System.Reflection.MethodBase.Invoke                        104
15                         System.Delegate.DynamicInvokeOne                           564
16                         System.MulticastDelegate.DynamicInvokeImpl                 84
17                         System.Windows.Threading.DispatcherOperation.Invoke        80
18                         System.Windows.Threading.Dispatcher.Dispatch               404
19                         System.Windows.Threading.Dispatcher.OnInvoke               56
```

Следующий вопрос: какая часть моего приложения использует web browser? Ответ: никакая. Кроме рекламной части. И тут на сцену выходит AdMob. Несколько поисков спустя я выяснил, что не один с этой проблемой - есть много разработчиков с похожим stack trace, и все используют AdMob для показа рекламы.

Даже Google-группа AdMob полна подобных issue и crash, и тем не менее с этим ничего не делают. Существуют обходные пути - например, помечать unhandled exception как handled, чтобы приложение не падало, - но при этом и реклама становится некликабельной, что неприемлемо.

Поэтому я начал искать альтернативы и через какое-то время остановился на InnerActive. Большинство разработчиков, похоже, рекомендуют именно её как замену Pub Center от Microsoft и AdMob - и, судя по моим наблюдениям, у них есть приятные партнёрства с известными издателями, такими как HalfBrick или ZeptoLab. Дам им попробовать.

Я уже немного посмотрел их документацию и поддерживаемые типы рекламы - выглядят нормально (в любом случае намного лучше AdMob). Интегрирую их рекламу в одно из своих приложений и поделюсь, что получилось.
