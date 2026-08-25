using System.Runtime.InteropServices.JavaScript;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Medius.Browser;
using Medius.Services;
using Medius.ViewModels;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#out");
builder.RootComponents.Add<HeadOutlet>("head::after");

await JSHost.ImportAsync("medius-player", "../player.js?v=7");
PlatformServices.Playback = new BrowserPlaybackHost();
PlatformServices.BackgroundConversion = new BrowserBackgroundConversionHost();
PlatformServices.Downloads = new BrowserFileDownloadHost();
PlatformServices.Authentication = new BrowserAuthenticationHost();
PlatformServices.Mounts = new BrowserMountStore();
PlatformServices.Offline = new BrowserOfflineMediaStore();
PlatformServices.StateProtector = new BrowserAppStateProtector();
PlatformServices.PortableAppData = new BrowserPortableAppDataHost();

builder.Services.AddSingleton<MainViewModel>();

await builder.Build().RunAsync();