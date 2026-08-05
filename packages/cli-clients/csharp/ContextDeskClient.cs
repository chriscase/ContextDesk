// Minimal C# thin client — ProcessStartInfo with ArgumentList (no shell).
// Future: native ABI interop is staged, not implemented here.
// See docs/CLI_CLIENT_PROTOCOL.md.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;

public sealed class ContextDeskClient
{
    private readonly string _bin;
    private readonly string? _dataDir;

    public ContextDeskClient(string? bin = null, string? dataDir = null)
    {
        _bin = bin
            ?? Environment.GetEnvironmentVariable("CONTEXTDESK_BIN")
            ?? "contextdesk";
        _dataDir = dataDir;
    }

    public async Task<string> RunJsonAsync(IEnumerable<string> commandArgs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _bin,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false, // never shell
            CreateNoWindow = true,
        };
        if (!string.IsNullOrEmpty(_dataDir))
        {
            psi.ArgumentList.Add("--data-dir");
            psi.ArgumentList.Add(_dataDir!);
        }
        psi.ArgumentList.Add("--json");
        foreach (var a in commandArgs)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("failed to spawn contextdesk");
        var stdout = await proc.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        var stderr = await proc.StandardError.ReadToEndAsync().ConfigureAwait(false);
        await proc.WaitForExitAsync().ConfigureAwait(false);
        var text = stdout.Trim();
        if (string.IsNullOrEmpty(text))
        {
            throw new InvalidOperationException($"empty stdout exit={proc.ExitCode} stderr={stderr}");
        }
        return text;
    }

    public Task<string> CapabilitiesAsync() => RunJsonAsync(new[] { "capabilities" });

    public static async Task<int> Main(string[] args)
    {
        string? dataDir = null;
        var cmd = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--data-dir" && i + 1 < args.Length)
            {
                dataDir = args[++i];
            }
            else
            {
                cmd.Add(args[i]);
            }
        }
        if (cmd.Count == 0) cmd.Add("capabilities");
        var client = new ContextDeskClient(dataDir: dataDir);
        Console.WriteLine(await client.RunJsonAsync(cmd).ConfigureAwait(false));
        return 0;
    }
}
