using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Oxide.Plugins
{
    [Info("AmapBridge", "NOR", "1.4.1")]
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
            // playerdata_get_*/playerdata_set_* read/write a file in
            // AMAP/Files/Config directly - no script involved at all, see
            // RunPlayerDataGet/RunPlayerDataSet below.
            public bool IsPlayerDataGet;
            public bool IsPlayerDataSet;
            public string PlayerDataFile;
            // backup_list is read-only too, but lists ServerBackups.sh's
            // output directory rather than reading one known file - see
            // RunBackupList below.
            public bool IsBackupList;
        }

        // Resolved once at plugin load from the OS account this Rust server
        // process actually runs under - the same idea as the bash scripts'
        // $USERNAME in config.sh, just read straight from the OS instead of
        // a config file. Lets this same plugin file run unmodified on any
        // server, instead of needing this username hardcoded per-install.
        private static readonly string HomeDir = $"/home/{Environment.UserName}";

        private static readonly string WipeConfigPath = $"{HomeDir}/AMAP/Files/Config/config.cfg";
        private static readonly string ConfigDir = $"{HomeDir}/AMAP/Files/Config";
        // Where ServerBackups.sh actually writes timestamped backup
        // folders (confirmed by reading that script directly) - not under
        // AMAP/Files at all, a level up at the home directory.
        private static readonly string BackupsDir = $"{HomeDir}/BackUps";

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
            // Backs the dashboard's cross-admin player notes/stats sync
            // (see player_data_sync.py) - reads/writes these two files
            // directly over RCON instead of SSH, so it only ever needs the
            // same RCON credentials the rest of the dashboard already
            // requires, not a separate SSH key setup.
            ["playerdata_get_notes"] = new AmapAction { IsPlayerDataGet = true, PlayerDataFile = "DB-player_notes.json" },
            ["playerdata_get_stats"] = new AmapAction { IsPlayerDataGet = true, PlayerDataFile = "DB-player_stats.json" },
            ["playerdata_set_notes"] = new AmapAction { IsPlayerDataSet = true, PlayerDataFile = "DB-player_notes.json" },
            ["playerdata_set_stats"] = new AmapAction { IsPlayerDataSet = true, PlayerDataFile = "DB-player_stats.json" },
            // Lists ServerBackups.sh's output - read-only, see RunBackupList.
            ["backup_list"] = new AmapAction { IsBackupList = true },
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

            if (info.IsPlayerDataGet)
            {
                RunPlayerDataGet(arg, info.PlayerDataFile);
                return;
            }

            if (info.IsBackupList)
            {
                RunBackupList(arg);
                return;
            }

            if (info.IsPlayerDataSet)
            {
                var base64Json = (arg.GetString(1) ?? "").Trim();
                RunPlayerDataSet(arg, info.PlayerDataFile, base64Json);
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

        // Replies with the raw file content directly - the Python side
        // (player_data_sync.py) parses it as JSON. A missing file isn't an
        // error (a server that's never been synced to yet) - replies with
        // "{}" so the caller treats it the same as an empty-but-successful
        // read, not a failure to fall back from.
        private void RunPlayerDataGet(ConsoleSystem.Arg arg, string filename)
        {
            try
            {
                var path = $"{ConfigDir}/{filename}";
                if (!System.IO.File.Exists(path))
                {
                    arg.ReplyWith("{}");
                    return;
                }
                arg.ReplyWith(System.IO.File.ReadAllText(path));
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to read {filename}: {ex.Message}");
                arg.ReplyWith($"ERROR: {ex.Message}");
            }
        }

        // Caps how many backup entries get reported - ServerBackups.sh
        // runs every 5 minutes and prunes anything older than 24h, which
        // is still up to ~288 folders; dumping all of them into the AMAP
        // tab's result log isn't useful (confirmed against the live
        // server - it really does build up that many). Most recent 15
        // covers a bit over an hour, which is what you'd actually check
        // this for.
        private const int MaxBackupsListed = 15;

        // Lists ServerBackups.sh's output directory, newest first - just
        // folder names and each one's own last-write time, both single
        // stat calls against the top-level directory only. Deliberately
        // does NOT recurse into each backup to sum its size - tried that
        // first and it took over a second against this server's real
        // backups (LIVE_FILES is tens of thousands of files), long enough
        // to trip the same Oxide slow-hook-call race documented on
        // RunWipeConfigure above and get the wrong text captured as the
        // reply.
        private void RunBackupList(ConsoleSystem.Arg arg)
        {
            try
            {
                if (!System.IO.Directory.Exists(BackupsDir))
                {
                    arg.ReplyWith("No backups directory found yet - run a backup first.");
                    return;
                }
                var dirs = System.IO.Directory.GetDirectories(BackupsDir);
                if (dirs.Length == 0)
                {
                    arg.ReplyWith("No backups found yet.");
                    return;
                }
                Array.Sort(dirs);
                Array.Reverse(dirs);
                var lines = new List<string>();
                var shown = Math.Min(dirs.Length, MaxBackupsListed);
                for (var i = 0; i < shown; i++)
                {
                    var name = System.IO.Path.GetFileName(dirs[i]);
                    var modified = System.IO.Directory.GetLastWriteTimeUtc(dirs[i]);
                    lines.Add($"{name} (completed {modified:yyyy-MM-dd HH:mm} UTC)");
                }
                if (dirs.Length > shown)
                {
                    lines.Add($"...and {dirs.Length - shown} more.");
                }
                arg.ReplyWith(string.Join("\n", lines));
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to list backups: {ex.Message}");
                arg.ReplyWith($"Failed to list backups: {ex.Message}");
            }
        }

        // base64Json arrives as a single RCON argument token (no
        // whitespace, so Oxide's space-delimited arg parsing can't split
        // it apart) - base64 specifically so the JSON's own quotes/braces/
        // newlines never have to survive that parsing intact. Writes via a
        // temp file + delete + move rather than a direct write, so a
        // request that fails partway through can't leave a half-written
        // file behind for the next reader to choke on.
        private void RunPlayerDataSet(ConsoleSystem.Arg arg, string filename, string base64Json)
        {
            try
            {
                string json;
                try
                {
                    json = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(base64Json));
                }
                catch (FormatException)
                {
                    arg.ReplyWith("ERROR: payload was not valid base64");
                    return;
                }

                if (!System.IO.Directory.Exists(ConfigDir))
                {
                    System.IO.Directory.CreateDirectory(ConfigDir);
                }

                var path = $"{ConfigDir}/{filename}";
                var tmpPath = path + ".tmp";
                System.IO.File.WriteAllText(tmpPath, json);
                if (System.IO.File.Exists(path))
                {
                    System.IO.File.Delete(path);
                }
                System.IO.File.Move(tmpPath, path);

                arg.ReplyWith("OK");
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to write {filename}: {ex.Message}");
                arg.ReplyWith($"ERROR: {ex.Message}");
            }
        }
    }
}
