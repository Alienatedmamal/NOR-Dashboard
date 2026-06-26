using System;
using System.Collections.Generic;
using System.Diagnostics;

namespace Oxide.Plugins
{
    [Info("AmapBridge", "NOR", "1.0.0")]
    [Description("RCON-only bridge to a fixed whitelist of AMAP server-management scripts, for the NOR Dashboard's AMAP Scripts tab.")]
    public class AmapBridge : RustPlugin
    {
        // Fixed whitelist: action keyword -> exact shell command. The keyword
        // from RCON is matched against this dictionary's keys only - nothing
        // from the RCON request is ever passed through to the shell as-is.
        // Adding a new dashboard button means adding a new line here, not
        // accepting new shell text from outside.
        private static readonly Dictionary<string, string> Actions = new Dictionary<string, string>
        {
            ["stop"] = "/home/alienatedmammal/./rustserver stop",
            ["update_server"] = "/home/alienatedmammal/./rustserver update",
            ["update_plugins"] = "/home/alienatedmammal/./rustserver mods-update",
            ["backup"] = "/home/alienatedmammal/AMAP/Files/Scripts/./ServerBackups.sh",
            ["map_wipe"] = "/home/alienatedmammal/AMAP/Files/Scripts/./Mapwipe.sh",
            ["full_wipe"] = "/home/alienatedmammal/AMAP/Files/Scripts/./Fullwipe.sh",
            ["nightly_restart"] = "/home/alienatedmammal/AMAP/Files/Scripts/./Nightly.sh",
        };

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
            if (string.IsNullOrEmpty(action) || !Actions.TryGetValue(action, out var command))
            {
                arg.ReplyWith($"Unknown action '{action}'. Allowed: {string.Join(", ", Actions.Keys)}");
                return;
            }

            // Several of these scripts stop the Rust server - which is the
            // very process this plugin runs inside - so this never waits on
            // the child process. It starts it detached and replies
            // immediately; the RCON connection dropping shortly after for a
            // stop/wipe/restart action is expected, not a failure, and the
            // dashboard already reconnects automatically once the server is
            // back.
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = $"-c \"{command}\"",
                    UseShellExecute = false,
                    WorkingDirectory = "/home/alienatedmammal",
                });
                // No Puts() here on purpose - it turns out ReplyWith's text
                // is buffered until this method returns, while Puts() hits
                // the wire immediately, so any Puts() call here would beat
                // the actual reply back to the dashboard and get captured
                // as "the" response instead of this message.
                arg.ReplyWith($"Started: {action}");
            }
            catch (Exception ex)
            {
                PrintError($"AmapBridge: failed to start '{action}': {ex.Message}");
                arg.ReplyWith($"Failed to start '{action}': {ex.Message}");
            }
        }
    }
}
