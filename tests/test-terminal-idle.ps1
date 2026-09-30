param([switch]$Baseline)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path $PSScriptRoot -Parent
$taskSource = if ($Baseline) { (git -C $taskRepo show HEAD:HxShell/Program.cs) -join [Environment]::NewLine } else { [IO.File]::ReadAllText((Join-Path $taskRepo 'HxShell/Program.cs')) }
$taskRouteStart = $taskSource.IndexOf('app.MapGet("/api/terminal/ws"')
$taskRouteEnd = $taskSource.IndexOf('// 向交互终端写输入', $taskRouteStart)
$taskRoute = $taskSource.Substring($taskRouteStart, $taskRouteEnd - $taskRouteStart)
$taskManagerStart = $taskSource.IndexOf('public sealed class ConnectionManager')
$taskManagerEnd = $taskSource.LastIndexOf('/// <summary>', $taskSource.IndexOf('public sealed class ServerCopyJob'))
$taskManager = $taskSource.Substring($taskManagerStart, $taskManagerEnd - $taskManagerStart)
# Only time constants are accelerated; endpoint and reclamation bodies stay real.
$taskRoute = $taskRoute.Replace('TimeSpan.FromSeconds(30)', 'TimeSpan.FromMilliseconds(30)')
$taskManager = $taskManager.Replace('TimeSpan.FromMinutes(30)', 'TimeSpan.FromMilliseconds(300)').Replace('TimeSpan.FromMinutes(5)', 'TimeSpan.FromMilliseconds(50)')
$taskWsStart = $taskSource.IndexOf('app.UseWebSockets(')
$taskWsEnd = $taskSource.IndexOf(';', $taskWsStart)
$taskWs = $taskSource.Substring($taskWsStart, $taskWsEnd - $taskWsStart + 1)
$taskWs = $taskWs.Replace('KeepAliveInterval = TimeSpan.FromSeconds(30)', 'KeepAliveInterval = TimeSpan.FromMilliseconds(100)').Replace('KeepAliveTimeout = TimeSpan.FromSeconds(30)', 'KeepAliveTimeout = TimeSpan.FromMilliseconds(300)')
$taskPrefix = @'
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton<ConnectionManager>();
await using var app = builder.Build();
var mgr = app.Services.GetRequiredService<ConnectionManager>();
using var shutdownCts = new CancellationTokenSource();
var cleanup = mgr.CleanupLoop(shutdownCts.Token);
'@
$taskSuffix = @'
await app.StartAsync();
var address = app.Urls.Single().Replace("http:", "ws:");
using var first = new ClientWebSocket();
using var background = new ClientWebSocket();
using var stalled = new ClientWebSocket();
var firstId = mgr.Add(new SshSession());
var backgroundId = mgr.Add(new SshSession());
try
{
    await first.ConnectAsync(new Uri($"{address}/api/terminal/ws?connId={firstId}"), CancellationToken.None);
    await background.ConnectAsync(new Uri($"{address}/api/terminal/ws?connId={backgroundId}"), CancellationToken.None);
    var firstRead = Receive(first);
    var backgroundRead = Receive(background);
    // No input, output or one-shot APIs for either tab.
    await Task.Delay(1000);
    Check(mgr.GetSilently(firstId) is not null && mgr.GetSilently(backgroundId) is not null,
        "An open idle terminal was reclaimed");
    Console.WriteLine("PASS: multiple idle tabs survive repeated idle cleanup");

    first.Abort(); background.Abort();
    await Task.WhenAll(firstRead, backgroundRead);
    await Task.Delay(1200);
    Check(mgr.GetSilently(firstId) is null && mgr.GetSilently(backgroundId) is null,
        "Disconnected terminal continued renewing its SSH session");
    Console.WriteLine("PASS: disconnected tabs stop renewing and become reclaimable");

    // A client that never receives cannot process Ping or send Pong.
    var stalledId = mgr.Add(new SshSession());
    await stalled.ConnectAsync(new Uri($"{address}/api/terminal/ws?connId={stalledId}"), CancellationToken.None);
    await Task.Delay(1200);
    Check(mgr.GetSilently(stalledId) is null, "Unresponsive WebSocket kept its session alive indefinitely");
    Console.WriteLine("PASS: missing Pong ends renewal and allows cleanup");

    using var shellClosed = new ClientWebSocket();
    var shellId = mgr.Add(new SshSession());
    await shellClosed.ConnectAsync(new Uri($"{address}/api/terminal/ws?connId={shellId}"), CancellationToken.None);
    var shellRead = Receive(shellClosed);
    mgr.GetSilently(shellId)!.Dispose();
    await shellRead.WaitAsync(TimeSpan.FromSeconds(2));
    Console.WriteLine("PASS: SSH shell closure promptly ends terminal WebSocket");
}
catch (Exception ex) { Console.Error.WriteLine("FAIL: " + ex.Message); Environment.ExitCode = 1; }
finally
{
    first.Abort(); background.Abort(); stalled.Abort();
    shutdownCts.Cancel();
    mgr.DisposeAll();
    await cleanup;
    using var stopCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
    await app.StopAsync(stopCts.Token);
}
static void Check(bool condition, string error)
{
    if (!condition) throw new Exception(error);
}
static async Task Receive(ClientWebSocket ws)
{
    try
    {
        var buffer = new byte[8192];
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
                return;
            }
        }
    }
    catch (WebSocketException) { }
    catch (OperationCanceledException) { }
}
static async Task SendWsJsonAsync(WebSocket ws, object payload, CancellationToken ct)
{
    await ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload)),
        WebSocketMessageType.Text, true, ct);
}
// Only the remote SSH boundary is substituted. No SSH server or credentials needed.
public sealed class ShellStream
{
    public void Write(string value) { }
    public void Flush() { }
    public void ChangeWindowSize(uint cols, uint rows, uint width, uint height) { }
}
public sealed class FakeClient { public bool IsConnected => true; }
public sealed class SshSession
{
    public FakeClient Ssh { get; } = new();
    public FakeClient Sftp { get; } = new();
    public object ShellLock { get; } = new();
    public StringBuilder ShellTail { get; } = new();
    public ShellStream? Shell { get; private set; } = new();
    public Channel<byte[]>? ShellOutput { get; } = Channel.CreateUnbounded<byte[]>();
    public bool ShellAlive => Shell is not null;
    public DateTime LastUsedUtc { get; private set; } = DateTime.UtcNow;
    public void Touch() => LastUsedUtc = DateTime.UtcNow;
    public void Dispose() { Shell = null; ShellOutput!.Writer.TryComplete(); }
}
'@
$taskTmp = Join-Path ([IO.Path]::GetTempPath()) ('HxShell-terminal-idle-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTmp | Out-Null
try {
    [IO.File]::WriteAllText((Join-Path $taskTmp 'IdleRegression.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>')
    [IO.File]::WriteAllText((Join-Path $taskTmp 'Program.cs'), (@($taskPrefix, $taskWs, $taskRoute, $taskSuffix, $taskManager) -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    dotnet run --project (Join-Path $taskTmp 'IdleRegression.csproj') --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw "Terminal regression failed (exit $LASTEXITCODE)" }
}
finally {
    $taskResolved = [IO.Path]::GetFullPath($taskTmp)
    $taskTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (!$taskResolved.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary path' }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
}

