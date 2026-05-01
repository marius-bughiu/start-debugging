---
title: "Windows Phone 用の透明な TextBox"
description: "Windows Phone 用の XAML スタイルで、TextBox を完全に透明にし、タップ時に出る白い背景のフォーカスエフェクトも消します。"
pubDate: 2012-01-02
updatedDate: 2023-11-04
tags:
  - "windows-phone"
lang: "ja"
translationOf: "2012/01/transparent-textbox-for-windows-phone"
translatedBy: "claude"
translationDate: 2026-05-01
---
以下のスタイルを textbox に適用すると、textbox を完全に透明にできます。このスタイルを適用するのと、単に textbox の `Background` プロパティを transparent にするか、あるいは完全に取り除くのとの違いは、このスタイルがタップ時に textbox に発生するフォーカスエフェクトも取り除く点です。背景色をどのように設定しても、textbox がフォーカスを得ると背景は白くなります。

スタイルはこちらです (アプリ／ページ／ユーザーコントロールのリソースに追加する必要があります)。

```xml
<ControlTemplate x:Key="PhoneDisabledTextBoxTemplate" TargetType="TextBox">
	<ContentControl x:Name="ContentElement" BorderThickness="0" HorizontalContentAlignment="Stretch" Margin="{StaticResource PhoneTextBoxInnerMargin}" Padding="{TemplateBinding Padding}" VerticalContentAlignment="Stretch"/>
</ControlTemplate>
<Style x:Key="TransparentTextBoxStyle" TargetType="TextBox">
	<Setter Property="FontFamily" Value="{StaticResource PhoneFontFamilyNormal}"/>
	<Setter Property="FontSize" Value="{StaticResource PhoneFontSizeMediumLarge}"/>
	<Setter Property="Background" Value="{StaticResource PhoneTextBoxBrush}"/>
	<Setter Property="Foreground" Value="{StaticResource PhoneTextBoxForegroundBrush}"/>
	<Setter Property="BorderBrush" Value="{StaticResource PhoneTextBoxBrush}"/>
	<Setter Property="SelectionBackground" Value="{StaticResource PhoneAccentBrush}"/>
	<Setter Property="SelectionForeground" Value="{StaticResource PhoneTextBoxSelectionForegroundBrush}"/>
	<Setter Property="BorderThickness" Value="{StaticResource PhoneBorderThickness}"/>
	<Setter Property="Padding" Value="2"/>
	<Setter Property="Template">
		<Setter.Value>
			<ControlTemplate TargetType="TextBox">
				<Grid Background="Transparent">
					<VisualStateManager.VisualStateGroups>
						<VisualStateGroup x:Name="CommonStates">
							<VisualState x:Name="Normal"/>
							<VisualState x:Name="MouseOver"/>
							<VisualState x:Name="Disabled">
								<Storyboard>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="EnabledBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Collapsed</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="DisabledOrReadonlyBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Visible</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
								</Storyboard>
							</VisualState>
							<VisualState x:Name="ReadOnly">
								<Storyboard>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="EnabledBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Collapsed</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Visibility" Storyboard.TargetName="DisabledOrReadonlyBorder">
										<DiscreteObjectKeyFrame KeyTime="0">
											<DiscreteObjectKeyFrame.Value>
												<Visibility>Visible</Visibility>
											</DiscreteObjectKeyFrame.Value>
										</DiscreteObjectKeyFrame>
									</ObjectAnimationUsingKeyFrames>
									<ObjectAnimationUsingKeyFrames Storyboard.TargetProperty="Foreground" Storyboard.TargetName="DisabledOrReadonlyContent">
										<DiscreteObjectKeyFrame KeyTime="0" Value="{StaticResource PhoneTextBoxReadOnlyBrush}"/>
									</ObjectAnimationUsingKeyFrames>
								</Storyboard>
							</VisualState>
						</VisualStateGroup>
						<VisualStateGroup x:Name="FocusStates">
							<VisualState x:Name="Focused"/>
							<VisualState x:Name="Unfocused"/>
						</VisualStateGroup>
						<VisualStateGroup x:Name="ValidationStates">
							<VisualState x:Name="InvalidFocused"/>
							<VisualState x:Name="Valid"/>
							<VisualState x:Name="InvalidUnfocused"/>
						</VisualStateGroup>
					</VisualStateManager.VisualStateGroups>
					<Border x:Name="EnabledBorder" BorderThickness="{TemplateBinding BorderThickness}" Margin="{StaticResource PhoneTouchTargetOverhang}">
						<ContentControl x:Name="ContentElement" BorderThickness="0" HorizontalContentAlignment="Stretch" Margin="{StaticResource PhoneTextBoxInnerMargin}" Padding="{TemplateBinding Padding}" VerticalContentAlignment="Stretch"/>
					</Border>
					<Border x:Name="DisabledOrReadonlyBorder" BorderThickness="{TemplateBinding BorderThickness}" Margin="{StaticResource PhoneTouchTargetOverhang}" Visibility="Collapsed">
						<TextBox x:Name="DisabledOrReadonlyContent" Foreground="{StaticResource PhoneDisabledBrush}" FontWeight="{TemplateBinding FontWeight}" FontStyle="{TemplateBinding FontStyle}" FontSize="{TemplateBinding FontSize}" FontFamily="{TemplateBinding FontFamily}" IsReadOnly="True" SelectionForeground="{TemplateBinding SelectionForeground}" SelectionBackground="{TemplateBinding SelectionBackground}" TextAlignment="{TemplateBinding TextAlignment}" TextWrapping="{TemplateBinding TextWrapping}" Text="{TemplateBinding Text}" Template="{StaticResource PhoneDisabledTextBoxTemplate}"/>
					</Border>
				</Grid>
			</ControlTemplate>
		</Setter.Value>
	</Setter>
</Style>
```

スタイルが用意できたら、あとは textbox に次のように適用するだけです。

```xml
<TextBox Style="{StaticResource TransparentTextBoxStyle}"/>
```

これで完了です。textbox は 100% 透明になっているはずです。なお、使う前に試したい方のためにサンプルプロジェクトを用意したので、[こちら](https://www.dropbox.com/s/mees8r22uug23sn/TransparentTextboxSample.zip?dl=0) からダウンロードできます。
