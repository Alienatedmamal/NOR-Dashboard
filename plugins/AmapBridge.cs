using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Oxide.Plugins
{
    [Info("AmapBridge", "NOR", "1.1.0")]
    [Description("RCON-only bridge to a fixed whitelist of AMAP server-management scripts, for the NOR Dashboard's AMAP Scripts tab.")]
    public class AmapBridge : RustPlugin
    {
        private class AmapAction
        {
            public string ScriptPath;
            // Only wipe_configure needs this - it's the one script in this
            // whitelist that's interactive (reads seed/map size/wipe
            // date/wipe type via `read -p`). Everything else takes no input.
            public bool NeedsArgs;
        }

        // Fixed whitelist: action keyword -> exact script path. The keyword
        // from RCON is matched against this dictionary's keys only - nothing
        // from the RCON request is ever passed through to the shell as a
        // command string. Adding a new dashboard button means adding a new
        // line here, not accepting new shell text from outside.
        private static readonly Dictionary<string, AmapAction> Actions = new Dictionary<string, AmapAction>
        {
            ["full_wipe"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./Fullwipe.sh" },
            ["log_cleaner"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./LogCleaner.sh" },
            ["map_wipe"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./Mapwipe.sh" },
            ["nightly_restart"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./Nightly.sh" },
            ["backup"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./ServerBackups.sh" },
            ["server_checker"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./ServerChecker.sh" },
            ["updater"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./Updater.sh" },
            ["wipe_configure"] = new AmapAction { ScriptPath = "/home/alienatedmammal/AMAP/Files/Scripts/./wipeconfigure.sh", NeedsArgs = true },
        };

        private static readonly Regex DigitsOnly = new Regex(@"^\d+$");
        private static readonly Regex WipeDatePattern = new Regex(@"^\d{2}-\d{2}-\d{2,4}$");

        [ConsoleCommand("amap.run")]
        private void RunAmapAction(ConsoleSystem.Arg arg)
        {
            // arg.Connection is null for the server console and RCON, and
            // non-null for a connected player's in-game F1 console - this is
            // the standard Oxide way to restrict a console command to
            // RCON/server-console only.
            if (arg.Connection != null)
            {
                arg.ReplyWith("Not allowed from in-game.");
                return;
            }

            var action = (arg.GetString(0) ?? "").Trim();
            if (string.IsNullOrEmpty(action) || !Actions.TryGetValue(action, out var info))
            {
                arg.ReplyWith($"Unknown action '{action}'. Allowed: {string.Join(", ", Actions.Keys)}");
                return;
            }

            if (info.NeedsArgs)
            {
                RunWipeConfigure(arg, info.ScriptPath);
                return;
            }

            // Several of these scripts stop the Rust server - which is the
            // very process this plugin runs inside - so this never waits on
            // the child process. It starts it detached and replies
            // immediately; the RCON connection dropping shortly after for a
            // stop/wipe/restart/update action is expected, not a failure,
            // and the dashboard already reconnects automatically once the
            // server is back.
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = $"-c \"{info.ScriptPath}\"",
                    UseShellExecute = false,
                    WorkingDirectory = "/home/alienatedmammal",
                });
                // No Puts() here on purpose - ReplyWith's text is buffered
                // until this method returns, while Puts() hits the wire
                // immediately, so any Puts() call here would beat the
                // actual reply back to the dashboard and get captured as
                // "the" response instead of this message.
                arg.ReplyWith($"Started: {action}");
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to start '{action}': {ex.Message}");
                arg.ReplyWith($"Failed to start '{action}': {ex.Message}");
            }
        }

        // wipeconfigure.sh prompts interactively for 4 values (read -p) and
        // sed-substitutes them straight into the next wipe's config file.
        // Each value is validated to a strict format before it ever reaches
        // the script - partly so a typo can't break the sed substitution
        // (which uses "/" as its delimiter), partly so nothing but plain
        // digits/dashes/an exact enum value ever flows into that file.
        // Values are fed over stdin, never interpolated into the shell
        // command string, so there's no shell-injection angle either way.
        private void RunWipeConfigure(ConsoleSystem.Arg arg, string scriptPath)
        {
            var seed = (arg.GetString(1) ?? "").Trim();
            var mapSize = (arg.GetString(2) ?? "").Trim();
            var wipeDate = (arg.GetString(3) ?? "").Trim();
            var wipeType = (arg.GetString(4) ?? "").Trim();

            if (!DigitsOnly.IsMatch(seed))
            {
                arg.ReplyWith("Invalid seed - must be digits only.");
                return;
            }
            if (!DigitsOnly.IsMatch(mapSize))
            {
                arg.ReplyWith("Invalid map size - must be digits only.");
                return;
            }
            if (!WipeDatePattern.IsMatch(wipeDate))
            {
                arg.ReplyWith("Invalid wipe date - use MM-DD-YY or MM-DD-YYYY.");
                return;
            }
            if (wipeType != "BP" && wipeType != "Map")
            {
                arg.ReplyWith("Invalid wipe type - must be exactly 'BP' or 'Map'.");
                return;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = $"-c \"{scriptPath}\"",
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    WorkingDirectory = "/home/alienatedmammal",
                };
                var proc = Process.Start(psi);
                proc.StandardInput.WriteLine(seed);
                proc.StandardInput.WriteLine(mapSize);
                proc.StandardInput.WriteLine(wipeDate);
                proc.StandardInput.WriteLine(wipeType);
                proc.StandardInput.Close();

                // Waiting on the script's output is fast in practice (it's
                // just file copies + sed, no network calls) but still
                // genuinely blocking I/O - doing that on Oxide's main
                // thread would freeze the live game server for everyone
                // for however long it takes. Wait on a background thread
                // instead and hop back to the main thread via NextTick
                // just to send the reply.
                System.Threading.Tasks.Task.Run(() =>
                {
                    string output;
                    try
                    {
                        output = proc.StandardOutput.ReadToEnd();
                        proc.WaitForExit(10000);
                    }
                    catch (Exception ex)
                    {
                        output = $"Error reading output: {ex.Message}";
                    }
                    finally
                    {
                        proc.Dispose();
                    }
                    var result = string.IsNullOrWhiteSpace(output) ? "wipe_configure finished with no output." : output.Trim();
                    NextTick(() => arg.ReplyWith(result));
                });
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to run wipe_configure: {ex.Message}");
                arg.ReplyWith($"Failed to run wipe_configure: {ex.Message}");
            }
        }
    }
}
