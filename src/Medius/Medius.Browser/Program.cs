using System.Runtime.InteropServices.JavaScript;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Browser;
using Medius;
using Medius.Browser;
using Medius.Services;

internal sealed partial class Program
{
    private static async Task Main(string[] args)
    {
        await JSHost.ImportAsync("medius-player", "../player.js?v=6");
        PlatformServices.Playback = new BrowserPlaybackHost();
        PlatformServices.Authentication = new BrowserAuthenticationHost();
        PlatformServices.Mounts = new BrowserMountStore();
        PlatformServices.Offline = new BrowserOfflineMediaStore();
        PlatformServices.StateProtector = new BrowserAppStateProtector();
        PlatformServices.PortableAppData = new BrowserPortableAppDataHost();
        await BuildAvaloniaApp()
            .WithInterFont()
            .StartBrowserAppAsync("out");
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>();
}