using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Oxide.Plugins
{
    [Info("AmapBridge", "NOR", "1.2.0")]
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
            // wipe_configure_view is read-only - it just greps the current
            // wipe config and reports back, no script to run.
            public bool IsView;
        }

        // Resolved once at plugin load from the OS account this Rust server
        // process actually runs under - the same idea as the bash scripts'
        // $USERNAME in config.sh, just read straight from the OS instead of
        // a config file. Lets this same plugin file run unmodified on any
        // server, instead of needing this username hardcoded per-install.
        private static readonly string HomeDir = $"/home/{Environment.UserName}";

        private static readonly string WipeConfigPath = $"{HomeDir}/AMAP/Files/Config/config.cfg";

        // Fixed whitelist: action keyword -> exact script path. The keyword
        // from RCON is matched against this dictionary's keys only - nothing
        // from the RCON request is ever passed through to the shell as a
        // command string. Adding a new dashboard button means adding a new
        // line here, not accepting new shell text from outside.
        private static readonly Dictionary<string, AmapAction> Actions = new Dictionary<string, AmapAction>
        {
            ["full_wipe"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./Fullwipe.sh" },
            ["log_cleaner"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./LogCleaner.sh" },
            ["map_wipe"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./Mapwipe.sh" },
            ["backup"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./ServerBackups.sh" },
            ["server_checker"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./ServerChecker.sh" },
            ["updater"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./Updater.sh" },
            ["wipe_configure"] = new AmapAction { ScriptPath = $"{HomeDir}/AMAP/Files/Scripts/./wipeconfigure.sh", NeedsArgs = true },
            ["wipe_configure_view"] = new AmapAction { IsView = true },
        };

        private static readonly Regex DigitsOnly = new Regex(@"^\d+$");
        private static readonly Regex WipeDatePattern = new Regex(@"^\d{2}-\d{2}-\d{2,4}$");
        // The wipe date has no cfg key of its own - it only ever shows up
        // embedded in the description field's "Next Wipe MM-DD-YY ..." text
        // (see wipeconfigure.sh/templateconfig.cfg), so View Current Config
        // has to pull it back out of there to show it as its own line.
        private static readonly Regex WipeDateInDescription = new Regex(@"Next Wipe (\S+)");

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

            if (info.IsView)
            {
                RunWipeConfigureView(arg);
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
                    WorkingDirectory = HomeDir,
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

            // Same fire-and-forget shape as the other actions: spawning
            // bash consistently takes ~200ms+, which is long enough to
            // cross Oxide's own slow-hook-call threshold - and once that
            // happens, Oxide's own "Calling 'RunAmapAction' took Nms"
            // warning beats a synchronous reply back to the dashboard and
            // gets captured as "the" response instead (confirmed by
            // testing - this isn't theoretical). Replying immediately and
            // letting the script run detached avoids the race entirely.
            // Use View Current Config afterward to confirm it took effect.
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = $"-c \"{scriptPath}\"",
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    WorkingDirectory = HomeDir,
                };
                var proc = Process.Start(psi);
                proc.StandardInput.WriteLine(seed);
                proc.StandardInput.WriteLine(mapSize);
                proc.StandardInput.WriteLine(wipeDate);
                proc.StandardInput.WriteLine(wipeType);
                proc.StandardInput.Close();
                arg.ReplyWith("Started: wipe_configure - use View Current Config in a few seconds to confirm.");
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to run wipe_configure: {ex.Message}");
                arg.ReplyWith($"Failed to run wipe_configure: {ex.Message}");
            }
        }

        // Only reports the fields that actually matter for "what's the next
        // wipe configured to do" - seed, map size, and wipe type, plus the
        // wipe date pulled back out of the description text (see
        // WipeDateInDescription above). Deliberately does not dump the
        // whole file, since config.cfg also holds the live RCON password
        // and a Discord webhook URL in plain text.
        //
        // Reads the file directly instead of shelling out to grep - even a
        // "fast" subprocess (bash + grep on a tiny file) reliably took
        // ~230ms here, which is enough to trip the same Oxide slow-hook
        // warning described above. A plain File.ReadLines call has none of
        // that process-spawn overhead, so it stays comfortably fast enough
        // to reply synchronously without the race.
        //
        // Reports each value on its own clearly-labeled line (Seed/Map
        // Size/Wipe Type/Wipe Date) instead of the raw cfg lines verbatim -
        // the raw "wipetype=..." syntax mixed in with seed's long inline
        // comment made the wipe type easy to miss at a glance.
        private void RunWipeConfigureView(ConsoleSystem.Arg arg)
        {
            try
            {
                if (!System.IO.File.Exists(WipeConfigPath))
                {
                    arg.ReplyWith("No wipe config file found yet - run the Wipe Configurator first.");
                    return;
                }
                string seed = null, worldSize = null, wipeType = null, description = null;
                foreach (var line in System.IO.File.ReadLines(WipeConfigPath))
                {
                    if (line.StartsWith("seed=")) seed = ExtractCfgValue(line);
                    else if (line.StartsWith("worldsize=")) worldSize = ExtractCfgValue(line);
                    else if (line.StartsWith("wipetype=")) wipeType = ExtractCfgValue(line);
                    else if (line.StartsWith("description=")) description = ExtractCfgValue(line);
                }
                if (seed == null && worldSize == null && wipeType == null && description == null)
                {
                    arg.ReplyWith("Wipe config file exists but none of the expected fields were found.");
                    return;
                }
                var dateMatch = description != null ? WipeDateInDescription.Match(description) : Match.Empty;
                var wipeDate = dateMatch.Success ? dateMatch.Groups[1].Value : "(not found)";
                var summary = $"Seed: {seed ?? "(not set)"}\nMap Size: {worldSize ?? "(not set)"}\nWipe Type: {wipeType ?? "(not set)"}\nWipe Date: {wipeDate}";
                arg.ReplyWith(summary);
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to view wipe config: {ex.Message}");
                arg.ReplyWith($"Failed to view wipe config: {ex.Message}");
            }
        }

        // Strips a cfg line down to its value - everything after the first
        // "=", minus any trailing "# comment" and surrounding quotes.
        private static string ExtractCfgValue(string line)
        {
            var eq = line.IndexOf('=');
            var value = eq >= 0 ? line.Substring(eq + 1) : line;
            var hash = value.IndexOf('#');
            if (hash >= 0) value = value.Substring(0, hash);
            return value.Trim().Trim('"');
        }
    }
}
