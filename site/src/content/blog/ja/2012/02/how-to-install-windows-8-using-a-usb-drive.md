---
title: "USB ドライブから Windows 8 をインストールする方法"
description: "Windows 7 USB/DVD Download Tool を使って USB ドライブから Windows 8 をインストールする手順を、フォーマットや BIOS 設定、トラブルシューティングのヒントとともに解説します。"
pubDate: 2012-02-01
updatedDate: 2023-11-05
tags:
  - "windows"
lang: "ja"
translationOf: "2012/02/how-to-install-windows-8-using-a-usb-drive"
translatedBy: "claude"
translationDate: 2026-05-01
---
始めるには Windows 8 の ISO イメージと、それを USB スティックに書き込むための Windows 7 USB / DVD Download Tool が必要です。それぞれ下の画像をクリックしてダウンロードできます。

[![Windows 8 Developer Preview 64bit](https://lh6.googleusercontent.com/-mq-MQd8BRhI/TylZRYlL90I/AAAAAAAAADU/8EBFMLQqkiw/s257/Windows%25208%2520Developer%2520Preview%252064bit.PNG)](http://msdn.microsoft.com/en-us/windows/apps/br229516)

[![Windows USB Tool](https://lh3.googleusercontent.com/-RTG-V-mR--I/TylZRp6bKsI/AAAAAAAAADQ/CLxQ1-cwuis/s256/Windows%2520USB%2520DVD%2520Tool.PNG)](https://go.microsoft.com/fwlink/?LinkId=691209)

ダウンロードが終わったら Windows 7 USB Tool をインストールします。プログラム名に Windows 7 とありますが気にしないでください。Windows 8 でも問題なく動きます。

必要なファイルが揃ったら、USB ドライブを PC に挿し、右クリックして format を選びます。私が見たほとんどのチュートリアルでは FAT32 にフォーマットすべき、それ以外では動かないと書かれていますが -- ツールで Windows のファイルを USB にコピーすると、ツール自体は NTFS にフォーマットしてしまいます。妙ですが、まあそれはそれで。

[![Windows Format Window](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)](https://lh5.googleusercontent.com/-q1Y_Qpe7Jkk/TylZRdFy35I/AAAAAAAAADM/y3b2ZxFNnOg/s464/Format%2520Window.PNG)

quick format で FAT32 にしてください。**データのバックアップを忘れずに！**

USB のフォーマットが終わったら Windows 7 USB Tool を開き、**Browse** をクリックして、先ほどダウンロードした ISO イメージを選択します。

[![Windows USB Tool Choose an ISO File](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)](https://lh3.googleusercontent.com/-ZSLcuA3yIWM/TylZRwtOwdI/AAAAAAAAADY/_KP3ttPuD5w/s568/Download%2520Tool%2520Step%25201.PNG)

**Next** をクリックし、メディアタイプを選ぶ次の画面で **USB device** を選びます。ご覧のとおり、イメージを直接 DVD に書き込むオプションも提供されていますが、本 how-to では USB を使います。

[![Windows USB Tool Choose Media Type](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)](https://lh6.googleusercontent.com/-zW4emO8smpg/TylZSMucF5I/AAAAAAAAADg/t-EN-a_2764/s568/Download%2520Tool%2520Step%25202.PNG)

ツールにインストールファイルを書き込ませる USB デバイスを選び、**Begin copying.** をクリックします。

[![Windows USB Tool Choose USB Drive](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)](https://lh3.googleusercontent.com/-avDPGBgz0QE/TylZSXIILDI/AAAAAAAAADs/1K8gpJDCUKU/s568/Download%2520Tool%2520Step%25203.PNG)

これで、Windows のインストールファイルが USB ドライブにコピーされ始めます。

[![Windows USB Tool Copying Files](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)](https://lh3.googleusercontent.com/-XDpAQ6PdRKI/TylZSoFrDEI/AAAAAAAAADw/7Jer1cl75Bo/s568/Download%2520Tool%2520Step%25204.PNG)

すべての処理がエラーなく終わったら、PC を再起動し、ブートメニューを開き (私の場合は POST 中に F12)、USB ドライブを選択します。USB が一覧に出てこない場合は、BIOS に入り **Legacy USB Support** が **Enabled** になっているか確認してください。

**メモ:**

-   現在 32-bit OS で動作している場合、64-bit Windows を入れたブータブル USB は作れません。64-bit Windows のブータブル USB を作るには 64-bit OS が必要です。
-   USB は十分な容量が必要です。シンプルな 32-bit / 64-bit 版なら 4 GB で十分ですが、developer tools を含む 64-bit 版の場合は ISO 単体で 4.7 GB あるため、8 GB の USB が必要になります。
-   フォーマットの前に必ず USB のデータをバックアップしてください。さもないと失われます。また、OS をインストールするパーティションは慎重に選び、既存の Windows インストールを誤って上書きしないようにしてください。これでも全データが失われます。

最後に: 真新しい Windows 8 から公開しています。ですので、実際に動くことが確認できています。
