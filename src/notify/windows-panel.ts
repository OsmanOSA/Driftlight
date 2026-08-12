import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeNotification } from "./backend.js";

export const WINDOWS_PANEL_STARTUP_MS = 8_000;

/**
 * Attente d'une confirmation d'affichage lorsque le panneau passe en premier.
 *
 * Plus court que le budget d'aperçu : au-delà, l'utilisateur attendrait cette
 * durée-là **avant** que le toast de repli ne parte, et une alerte rouge n'a pas
 * ce temps. PowerShell et WPF démarrent en une à deux secondes.
 */
export const WINDOWS_PANEL_CONFIRM_MS = 5_000;
const WINDOWS_PANEL_BROKER_MS = 3_000;
export const WINDOWS_PANEL_WIDTH = 412;
/**
 * Plafond, et non hauteur fixe : le panneau se dimensionne sur son contenu, de
 * sorte qu'une alerte sans demande d'origine ni conduite à tenir n'affiche pas
 * de rangées vides. Chaque bloc étant lui-même borné, ce plafond n'est qu'un
 * filet de sécurité — la taille courante reste bien en dessous.
 */
export const WINDOWS_PANEL_MAX_HEIGHT = 396;

/**
 * Hiérarchie du panneau.
 *
 * Elle suit l'ordre dans lequel la question se pose : d'où ça vient, quelle
 * action est proposée, ce que DriftLight a vu, sur quoi précisément, ce qui a
 * été demandé, et enfin ce que le hook a obtenu. Le sujet est rendu en chasse
 * fixe dans un encart en retrait — une commande ou un chemin se lisent comme du
 * code, pas comme de la prose, et l'encart les sépare nettement du commentaire.
 *
 * Aucun bouton d'accord ou de refus : le panneau ne détient pas la décision.
 * Le hook l'a déjà rendue quand la fenêtre s'affiche, et l'agent tranche dans
 * sa propre interface. Deux boutons ici seraient décoratifs, donc mensongers.
 */
const PANEL_XAML = String.raw`<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:AutomationProperties="clr-namespace:System.Windows.Automation;assembly=PresentationCore" Title="DriftLight" Width="${WINDOWS_PANEL_WIDTH}" SizeToContent="Height" MaxHeight="${WINDOWS_PANEL_MAX_HEIGHT}" AllowsTransparency="True" Background="Transparent" WindowStyle="None" ResizeMode="NoResize" ShowInTaskbar="False" ShowActivated="False" Topmost="True" Opacity="0" UseLayoutRounding="True" SnapsToDevicePixels="True" TextOptions.TextFormattingMode="Ideal" FontFamily="Segoe UI Variable Text, Segoe UI">
  <Grid>
    <Border x:Name="PanelCard" Margin="10" CornerRadius="14" BorderThickness="1" Padding="16,14,16,14">
      <Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="0.8,1"><GradientStop Color="#FF202129" Offset="0"/><GradientStop Color="#FF171820" Offset="0.52"/><GradientStop Color="#FF30343D" Offset="1"/></LinearGradientBrush></Border.Background>
      <Border.BorderBrush><LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#FF5B5E69" Offset="0"/><GradientStop Color="#FF3E414B" Offset="0.6"/><GradientStop Color="#FF555966" Offset="1"/></LinearGradientBrush></Border.BorderBrush>
      <Border.Effect><DropShadowEffect Color="#FF000000" BlurRadius="22" ShadowDepth="6" Opacity="0.55"/></Border.Effect>
      <Grid>
        <Ellipse Width="190" Height="120" HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,-82,-68" IsHitTestVisible="False" Opacity="0.15">
          <Ellipse.Fill><RadialGradientBrush><GradientStop x:Name="PanelGlow" Color="#FFFF8F6B" Offset="0"/><GradientStop Color="#00FF8F6B" Offset="1"/></RadialGradientBrush></Ellipse.Fill>
          <Ellipse.Effect><BlurEffect Radius="34"/></Ellipse.Effect>
        </Ellipse>
        <StackPanel>
          <Grid>
            <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="9"/><ColumnDefinition Width="*"/><ColumnDefinition Width="8"/><ColumnDefinition Width="26"/></Grid.ColumnDefinitions>
            <Ellipse x:Name="PanelStatus" Grid.Column="0" Width="9" Height="9" VerticalAlignment="Center"/>
            <TextBlock x:Name="PanelContext" Grid.Column="2" Foreground="#FF9E9EA9" FontSize="11.5" FontWeight="SemiBold" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
            <Button x:Name="PanelClose" Grid.Column="4" Content="×" Width="26" Height="26" HorizontalAlignment="Right" VerticalAlignment="Center" Foreground="#FFD2D2DA" FontSize="17" FontWeight="Normal" BorderThickness="0" Cursor="Hand" Padding="0" AutomationProperties:AutomationProperties.Name="Ignorer">
              <Button.Background><SolidColorBrush Color="#00FFFFFF"/></Button.Background>
              <Button.Template><ControlTemplate TargetType="Button"><Border x:Name="ButtonSurface" CornerRadius="8" Background="{TemplateBinding Background}" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-2,0,0"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="ButtonSurface" Property="Background" Value="#20FFFFFF"/></Trigger><Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonSurface" Property="Opacity" Value="0.64"/></Trigger><Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="ButtonSurface" Property="Background" Value="#2AFFFFFF"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Button.Template>
            </Button>
          </Grid>
          <StackPanel x:Name="PanelVerbRow" Orientation="Horizontal" Margin="0,13,0,0">
            <TextBlock x:Name="PanelGlyph" Text="&#x26A0;" FontSize="13" FontFamily="Segoe UI Symbol" VerticalAlignment="Center" Margin="0,0,7,0"/>
            <TextBlock x:Name="PanelVerb" Foreground="#FFF2F2F6" FontSize="13.5" FontWeight="SemiBold" VerticalAlignment="Center"/>
          </StackPanel>
          <TextBlock x:Name="PanelHeadline" Margin="0,6,0,0" Foreground="#FFF8F8FA" FontSize="15.5" FontWeight="SemiBold" TextWrapping="Wrap" MaxHeight="40" TextTrimming="CharacterEllipsis"/>
          <Border x:Name="PanelEvidence" Margin="0,11,0,0" CornerRadius="9" Padding="11,8,11,9" Background="#FF111218" BorderThickness="1" BorderBrush="#FF2D3039">
            <TextBlock x:Name="PanelEvidenceText" FontFamily="Cascadia Mono, Consolas, Courier New" FontSize="11.5" Foreground="#FFDCDDE6" TextWrapping="Wrap" MaxHeight="32" TextTrimming="CharacterEllipsis"/>
          </Border>
          <TextBlock x:Name="PanelMeta" Margin="0,7,0,0" Foreground="#FF83828E" FontSize="11" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="PanelIntent" Margin="0,10,0,0" Foreground="#FFA8A7B2" FontSize="12" FontStyle="Italic" TextWrapping="Wrap" MaxHeight="32" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="PanelAction" Margin="0,7,0,0" Foreground="#FFD7D6DE" FontSize="12" TextWrapping="Wrap" MaxHeight="30" TextTrimming="CharacterEllipsis"/>
          <Border Margin="0,12,0,0" Height="1" Background="#FF32353E"/>
          <Grid Margin="0,9,0,0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="8"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
            <TextBlock x:Name="PanelStatusText" Grid.Column="0" Foreground="#FFB9B8C3" FontSize="11.5" FontWeight="SemiBold" VerticalAlignment="Center" TextWrapping="Wrap" MaxHeight="30" TextTrimming="CharacterEllipsis"/>
            <Border x:Name="PanelHint" Grid.Column="2" CornerRadius="5" Padding="6,1,6,2" Background="#14FFFFFF" BorderThickness="1" BorderBrush="#26FFFFFF" VerticalAlignment="Center">
              <TextBlock Text="Échap" Foreground="#FF9A99A5" FontSize="10.5" FontWeight="SemiBold"/>
            </Border>
          </Grid>
          <Grid x:Name="PanelDecision" Margin="0,11,0,0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="9"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
            <Button x:Name="PanelKeep" Grid.Column="0" Height="31" Cursor="Hand" BorderThickness="0" Foreground="#FFDDDCE4" FontSize="12" FontWeight="SemiBold" AutomationProperties:AutomationProperties.Name="Garder le refus">
              <Button.Template><ControlTemplate TargetType="Button"><Border x:Name="Surface" CornerRadius="8" Background="#18FFFFFF" BorderThickness="1" BorderBrush="#26FFFFFF"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Surface" Property="Background" Value="#26FFFFFF"/></Trigger><Trigger Property="IsPressed" Value="True"><Setter TargetName="Surface" Property="Opacity" Value="0.65"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Button.Template>
              <TextBlock Text="Garder le refus"/>
            </Button>
            <Button x:Name="PanelAuthorize" Grid.Column="2" Height="31" Cursor="Hand" BorderThickness="0" Foreground="#FF16171D" FontSize="12" FontWeight="SemiBold" AutomationProperties:AutomationProperties.Name="Autoriser cette action">
              <Button.Template><ControlTemplate TargetType="Button"><Border x:Name="Surface" CornerRadius="8" BorderThickness="0"><Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#FFF4F4F7" Offset="0"/><GradientStop Color="#FFD3D4DC" Offset="1"/></LinearGradientBrush></Border.Background><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Surface" Property="Opacity" Value="0.9"/></Trigger><Trigger Property="IsPressed" Value="True"><Setter TargetName="Surface" Property="Opacity" Value="0.72"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter TargetName="Surface" Property="Opacity" Value="0.4"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Button.Template>
              <TextBlock x:Name="PanelAuthorizeLabel" Text="Autoriser"/>
            </Button>
          </Grid>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>`;

export interface WindowsPanelPayload {
  /**
   * Décision offerte à l'utilisateur, absente pour toute alerte qui n'a rien
   * arrêté : un bouton sans conséquence est un mensonge poli.
   */
  authorize?: {
    label: string;
    exe: string;
    args: string[];
    confirmation: string;
    failure: string;
  };
  context: string;
  verb: string;
  headline: string;
  evidence: string;
  meta: string;
  intent: string;
  action: string;
  status: string;
  persistent: boolean;
  sound: boolean;
  accentStart: string;
  accentEnd: string;
  eventName?: string;
  readyFile?: string;
}

export function panelEventName(eventId: string): string {
  const safe = eventId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return `Local\\DriftLight.Notification.${safe || "alert"}`;
}

export function safePanelReadyFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = path.resolve(value);
  const relative = path.relative(path.resolve(os.tmpdir()), candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return path.basename(candidate).startsWith("driftlight-panel-ready-") ? candidate : undefined;
}

function capitalise(value: string): string {
  return value.length > 0 ? value[0]?.toLocaleUpperCase("fr-FR") + value.slice(1) : value;
}

/**
 * Repli pour une notification construite à la main, sans description structurée.
 *
 * Le rendu y perd le verbe et le décompte des signaux, mais garde sa hiérarchie :
 * une notification écrite ailleurs dans le code reste lisible, elle est
 * seulement moins riche.
 */
function payloadFromText(notification: NativeNotification, verdict: string): Partial<WindowsPanelPayload> {
  const lines = notification.message.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const first = lines[0] ?? "";
  const cut = first.lastIndexOf(" : ");
  return {
    verb: "",
    headline: cut > 0 ? first.slice(0, cut) : first,
    evidence: cut > 0 ? first.slice(cut + 3) : "",
    meta: "",
    intent: lines[1] ?? "",
    action: lines[2] ?? "",
    status: verdict,
  };
}

export function windowsPanelPayload(notification: NativeNotification): WindowsPanelPayload {
  const separator = notification.title.lastIndexOf(" — ");
  const context = separator >= 0 ? notification.title.slice(0, separator) : "DriftLight";
  const verdict = capitalise(separator >= 0 ? notification.title.slice(separator + 3) : notification.title);
  // La gravité est portée explicitement ; l'icône et le verdict ne servent que
  // de secours aux notifications construites sans elle.
  const red = notification.level !== undefined
    ? notification.level === "RED"
    : /(?:red|rouge)/i.test(path.basename(notification.icon ?? ""))
      || /(?:bloquée|rouge|refusée)/i.test(verdict);
  const readyFile = safePanelReadyFile(notification.readyFile);
  const content = notification.detail
    ? { ...notification.detail, headline: capitalise(notification.detail.headline) }
    : payloadFromText(notification, verdict);
  return {
    context,
    verb: "",
    headline: "",
    evidence: "",
    meta: "",
    intent: "",
    action: "",
    status: verdict,
    ...content,
    persistent: notification.persistent === true,
    sound: notification.sound,
    accentStart: red ? "#FFFFA079" : "#FFFFC66B",
    accentEnd: red ? "#FFCA5C78" : "#FFD58B4E",
    ...(notification.authorize ? { authorize: notification.authorize } : {}),
    ...(notification.tag ? { eventName: panelEventName(notification.tag) } : {}),
    ...(readyFile ? { readyFile } : {}),
  };
}

export function windowsPanelScript(notification: NativeNotification): string {
  const payload = Buffer.from(JSON.stringify(windowsPanelPayload(notification)), "utf8").toString("base64");
  const xaml = Buffer.from(PANEL_XAML, "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase",
    `$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json`,
    `$xaml=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xaml}'))`,
    "$reader=New-Object System.Xml.XmlNodeReader ([xml]$xaml)",
    "$window=[Windows.Markup.XamlReader]::Load($reader)",
    "$card=$window.FindName('PanelCard')",
    "$close=$window.FindName('PanelClose')",
    "$dot=$window.FindName('PanelStatus')",
    "$glyph=$window.FindName('PanelGlyph')",
    "$evidence=$window.FindName('PanelEvidence')",
    // Un champ vide replie sa rangée au lieu de laisser un blanc : le panneau se
    // dimensionne sur ce qu'il a réellement à dire.
    "$fill={param($name,$text) $block=$window.FindName($name);if([string]::IsNullOrWhiteSpace($text)){$block.Visibility=[Windows.Visibility]::Collapsed}else{$block.Text=$text}}",
    "&$fill 'PanelContext' $payload.context",
    "&$fill 'PanelHeadline' $payload.headline",
    "&$fill 'PanelMeta' $payload.meta",
    "&$fill 'PanelIntent' $payload.intent",
    "&$fill 'PanelAction' $payload.action",
    "&$fill 'PanelStatusText' $payload.status",
    "&$fill 'PanelEvidenceText' $payload.evidence",
    "if([string]::IsNullOrWhiteSpace($payload.evidence)){$evidence.Visibility=[Windows.Visibility]::Collapsed}",
    "if([string]::IsNullOrWhiteSpace($payload.verb)){$window.FindName('PanelVerbRow').Visibility=[Windows.Visibility]::Collapsed}else{$window.FindName('PanelVerb').Text=$payload.verb}",
    "$accentA=[Windows.Media.ColorConverter]::ConvertFromString($payload.accentStart)",
    "$accentB=[Windows.Media.ColorConverter]::ConvertFromString($payload.accentEnd)",
    "$dot.Fill=New-Object Windows.Media.SolidColorBrush($accentA)",
    "$glyph.Foreground=New-Object Windows.Media.SolidColorBrush($accentA)",
    // Halo décoratif : un pinceau figé refuserait la teinte, ce qui ne justifie
    // pas de perdre l'alerte.
    "try{$window.FindName('PanelGlow').Color=$accentB}catch{}",
    // La hauteur découle du contenu : elle n'est connue qu'une fois la fenêtre
    // mesurée, d'où le placement différé à ContentRendered.
    "$work=[Windows.SystemParameters]::WorkArea",
    "$window.Left=$work.Right-$window.Width-18",
    "$window.Top=$work.Bottom-260",
    "$place={$window.Left=$work.Right-$window.ActualWidth-18;$window.Top=$work.Bottom-$window.ActualHeight-18}.GetNewClosure()",
    // Sans décision en attente, la rangée disparaît : l'alerte n'a rien retenu,
    // il n'y a rien à trancher.
    "$decision=$window.FindName('PanelDecision')",
    "$authorize=$window.FindName('PanelAuthorize')",
    "if(-not $payload.authorize){$decision.Visibility=[Windows.Visibility]::Collapsed}else{",
    "  $window.FindName('PanelAuthorizeLabel').Text=$payload.authorize.label",
    "  $window.FindName('PanelHint').Visibility=[Windows.Visibility]::Collapsed",
    "  $window.FindName('PanelKeep').Add_Click({$window.Close()}.GetNewClosure())",
    // Les arguments partent en tableau, jamais en ligne de commande : aucun
    // chemin ni texte d'alerte ne traverse d'interpréteur.
    "  $authorize.Add_Click({",
    "    $authorize.IsEnabled=$false",
    "    $ok=$false",
    "    try{ $p=Start-Process -FilePath $payload.authorize.exe -ArgumentList $payload.authorize.args -WindowStyle Hidden -PassThru -Wait; $ok=($p.ExitCode -eq 0) }catch{ $ok=$false }",
    "    $status=$window.FindName('PanelStatusText')",
    "    $status.Text=$(if($ok){$payload.authorize.confirmation}else{$payload.authorize.failure})",
    "    $decision.Visibility=[Windows.Visibility]::Collapsed",
    // L'utilisateur doit voir que son geste a porté : la fenêtre reste, et cesse
    // seulement de réclamer une décision déjà rendue.
    "  }.GetNewClosure())",
    "}",
    "$close.Add_Click({$window.Close()})",
    "$window.Add_KeyDown({if($_.Key -eq [Windows.Input.Key]::Escape){$window.Close()}})",
    "$signal=$null",
    "if($payload.eventName){try{$created=$false;$signal=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::AutoReset,$payload.eventName,[ref]$created)}catch{}}",
    "$started=[DateTime]::UtcNow",
    "$timer=New-Object Windows.Threading.DispatcherTimer",
    "$timer.Interval=[TimeSpan]::FromMilliseconds(250)",
    "$timer.Add_Tick({if($signal -and $signal.WaitOne(0)){$window.Close();return};if(-not $payload.persistent -and -not $window.IsMouseOver -and ([DateTime]::UtcNow-$started).TotalSeconds -ge 10){$window.Close()}}.GetNewClosure())",
    "$timer.Start()",
    "$move=New-Object Windows.Media.TranslateTransform(0,12)",
    "$card.RenderTransform=$move",
    "$ease=New-Object Windows.Media.Animation.CubicEase",
    "$ease.EasingMode=[Windows.Media.Animation.EasingMode]::EaseOut",
    "$duration=New-Object Windows.Duration([TimeSpan]::FromMilliseconds(220))",
    "$slide=New-Object Windows.Media.Animation.DoubleAnimation(12,0,$duration)",
    "$slide.EasingFunction=$ease",
    "$fade=New-Object Windows.Media.Animation.DoubleAnimation(0,1,$duration)",
    "$fade.EasingFunction=$ease",
    "$app=New-Object Windows.Application",
    "$app.ShutdownMode=[Windows.ShutdownMode]::OnExplicitShutdown",
    "$window.Add_ContentRendered({&$place;if([Windows.SystemParameters]::ClientAreaAnimation){$move.BeginAnimation([Windows.Media.TranslateTransform]::YProperty,$slide);$window.BeginAnimation([Windows.Window]::OpacityProperty,$fade)}else{$move.Y=0;$window.Opacity=1};if($payload.sound){[System.Media.SystemSounds]::Exclamation.Play()};if($payload.readyFile){[IO.File]::WriteAllText($payload.readyFile,'ready')}}.GetNewClosure())",
    "$window.Add_Closed({$timer.Stop();if($signal){$signal.Dispose()};$app.Shutdown()}.GetNewClosure())",
    // Donner explicitement la fenêtre à Application.Run est le point de durée
    // de vie : sans propriétaire, PowerShell peut rendre la main et détruire le
    // panneau juste après son premier rendu, même s'il est persistant.
    "$null=$app.Run($window)",
  ].join("\n");
}

async function launchPanel(script: string): Promise<boolean> {
  const panelEncoded = Buffer.from(script, "utf16le").toString("base64");
  const launchFile = path.join(os.tmpdir(), `driftlight-panel-launch-${process.pid}-${randomUUID()}.txt`);
  writeFileSync(launchFile, panelEncoded, { encoding: "ascii", mode: 0o600 });
  const quotedLaunchFile = launchFile.replace(/'/g, "''");
  const bootstrap = [
    `$launchFile='${quotedLaunchFile}'`,
    "$encoded=[IO.File]::ReadAllText($launchFile)",
    "[IO.File]::Delete($launchFile)",
    "$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))",
    "&([ScriptBlock]::Create($source))",
  ].join(";");
  const bootstrapEncoded = Buffer.from(bootstrap, "utf16le").toString("base64");
  const panelArguments = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -STA -EncodedCommand ${bootstrapEncoded}`;
  const broker = [
    "$ErrorActionPreference='Stop'",
    "$shell=New-Object -ComObject Shell.Application",
    `$shell.ShellExecute('powershell.exe','${panelArguments}','','open',0)`,
  ].join(";");
  const brokerEncoded = Buffer.from(broker, "utf16le").toString("base64");
  const launched = await new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", brokerEncoded],
      { stdio: "ignore", windowsHide: true },
    );
    const finish = (started: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(started);
    };
    const guard = setTimeout(() => {
      child.kill();
      finish(false);
    }, WINDOWS_PANEL_BROKER_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
  if (!launched) {
    try {
      unlinkSync(launchFile);
    } catch {
      // Le broker peut avoir lu le fichier juste avant de signaler son échec.
    }
    return false;
  }
  // Le processus lancé par Explorer lit puis supprime lui-même ce fichier. Le
  // supprimer ici créerait une course entre le broker et son nouveau processus.
  return true;
}

/**
 * Affiche le panneau, et — si on le lui demande — attend qu'il le confirme.
 *
 * Le lancement passe par Explorer pour survivre au hook, ce qui a un prix :
 * un lancement réussi ne prouve pas qu'une fenêtre soit apparue. Le panneau
 * écrit donc un accusé au premier rendu. Sans cette attente, un panneau mort-né
 * ferait croire l'alerte remise alors que rien ne s'est affiché, et c'est la
 * seule panne qu'un voyant n'a pas le droit d'avoir.
 *
 * `confirmMs` à zéro conserve l'ancien comportement : on rend la main dès le
 * lancement, ce qui suffit quand le panneau n'est qu'un repli de dernier rang.
 */
export async function showWindowsPanel(
  notification: NativeNotification,
  confirmMs = 0,
): Promise<boolean> {
  const supplied = safePanelReadyFile(notification.readyFile);
  const own = confirmMs > 0 && supplied === undefined
    ? path.join(os.tmpdir(), `driftlight-panel-ready-${process.pid}-${randomUUID()}`)
    : undefined;
  const acknowledgement = supplied ?? own;
  const launched = await launchPanel(windowsPanelScript(
    own ? { ...notification, readyFile: own } : notification,
  ));
  if (!launched || confirmMs <= 0 || acknowledgement === undefined) return launched;
  try {
    const deadline = Date.now() + confirmMs;
    while (Date.now() < deadline) {
      if (existsSync(acknowledgement)) return true;
      await delay(60);
    }
    return false;
  } finally {
    // Seul l'accusé que nous avons créé nous revient : celui de l'appelant lui
    // appartient, et il l'attend peut-être encore.
    if (own !== undefined) {
      try {
        unlinkSync(own);
      } catch {
        // Jamais écrit : le panneau n'a pas démarré, ce que l'attente a déjà dit.
      }
    }
  }
}
