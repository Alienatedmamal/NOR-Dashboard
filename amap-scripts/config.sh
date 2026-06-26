# config.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

###############################################################
################## Replace with your information ##############
#########This Should Auto-Fill if not replace USER NAME########
                     USERNAME="USERNAME_HERE"

               HOSTNAME="HOSTNAME_HERE"
               DISCORDURL="CHANGE_ME"

###############################################################

###########################################################################################################################################################################
### !!!!!Do not edit below this line!!!!! ### !!!!!Do not edit below this line!!!!! ### !!!!!Do not edit below this line!!!!! ### !!!!!Do not edit below this line!!!!! ###
###########################################################################################################################################################################

# Location of Rust Server
SERVER_LOCATION="/home/$USERNAME/"

# Rust Server Control:
SERVERDETAILS="$SERVER details"
SERVERCONSOLE="$SERVER console"

# AMAP:
SCRIPTS="$SCRIPT_DIR"
FILES="$DIR/Files/"
AMAPNC="$SCRIPT_DIR/./AMAPNC.sh"
AMAP="$SCRIPT_DIR/./AMAP.sh"
CONFIG="Files/config.sh"
AMAPLOGO="Files/Images/logo"
OPTIONS="Files/Images/menu"
SERVERMAN="Files/Images/servman"
WIPECON="Files/Images/wipecon"
LOGGING="Files/Images/logging"
BACKUPCON="Files/Images/backup"
RUSTINSTALL="Files/Images/rustinstall"
WARNING="Files/Images/warning"
AWAP="$DIR/Files/Images/awap"
PLUGINMOVE="$DIR/Files/Scripts/./PluginsMove.sh"
SERVERCONFIG="$DIR/Files/Scripts/./ServerConfigurator.sh"
FINISH="$DIR/Files/Config/finish"

# Running Scripts:
LOGCLEANER="$DIR/Files/Scripts/./LogCleaner.sh"
SERVERBACKUP="$DIR/Files/Scripts/./ServerBackups.sh"
FULLWIPE="$DIR/Files/Scripts/./Fullwipe.sh"
MAPWIPE="$DIR/Files/Scripts/./Mapwipe.sh"
NIGHTLY="$DIR/Files/Scripts/./Nightly.sh"
RMPLUGIN="$DIR/Files/Scripts/./RMPlugins.sh"
SERVERCHECKER="$DIR/Files/Scripts/./ServerChecker.sh"
SERVERSTART="$SCRIPT_DIR/./ServerStart.sh"
SCHEDULE="$DIR/Files/Scripts/./Schedule.sh"
UPDATER="$DIR/Files/Scripts/./Updater.sh"

# Script Names
SCRIPTFULL="Fullwipe:"
SCRIPTLOGCLEAN="LogCleaner:"
SCRIPTNIGHTLY="Nightly:"
SCRIPTBACKUPS="ServerBackup:"
SCRIPTSERVERSTART="ServerStart:"
SCRIPTMAPWIPE="MapWipe:"

# Sripts File Locations:
FULLWIPESH="$DIR/Files/Scripts/Fullwipe.sh"
MAPWIPESH="$DIR/Files/Scripts/Mapwipe.sh"
NIGHTLYSH="$DIR/Files/Scripts/Nightly.sh"
SERVERBACKUPSH="$DIR/Files/Scripts/ServerBackups.sh"
SERVERCHECKERSH="$DIR/Files/Scripts/./ServerChecker.sh"
SERVERSTARTSH="$DIR/Files/Scripts/ServerStart.sh"
SCHEDULESH="$DIR/Files/Scripts/Schedule.sh"
LOGCLEANERSH="$DIR/Files/Scripts/LogCleaner.sh"
EAMAPSH="$SCRIPT_DIR/AMAP.sh"

#OXIDE LOCATIONS:
OXIDECONFIG="/home/$USERNAME/serverfiles/oxide/config/"
OXIDEPLUGINS="/home/$USERNAME/serverfiles/oxide/plugins/"
AUTOMATEDEVENTS="/home/$USERNAME/serverfiles/oxide/config/AutomatedEvents.json"
BACKPACKS="/home/$USERNAME/serverfiles/oxide/config/Backpacks.json"
BETTERCHAT="/home/$USERNAME/serverfiles/oxide/config/BetterChat.json"
BGRADE="/home/$USERNAME/serverfiles/oxide/config/BGrade.json"
CUSTOMICON="/home/$USERNAME/serverfiles/oxide/config/CustomIcon.json"
DISCORDREPORT="/home/$USERNAME/serverfiles/oxide/config/DiscordReport.json"
EDITKITS="/home/$USERNAME/serverfiles/oxide/data/Kits/kits_data.json"
MAGICIMAGESPANEL="/home/$USERNAME/serverfiles/oxide/config/MagicPanel/MagicImagesPanel.json"
MAGICMESSAGEPANEL="/home/$USERNAME/serverfiles/oxide/config/MagicPanel/MagicMessagePanel.json"
MAGICPANEL="/home/$USERNAME/serverfiles/oxide/config/MagicPanel/MagicPanel.json"
RUSTCORD="/home/$USERNAME/serverfiles/oxide/config/Rustcord.json"
TIMEDEXECUTE="/home/$USERNAME/serverfiles/oxide/config/TimedExecute.json"
RUSTMOVE="mv lgsm /home/$USERNAME/ && mv rustserver /home/$USERNAME/ && mv linuxgsm.sh /home/$USERNAME/"
RUSTCONFIGS="lgsm/config-lgsm/rustserver"

# Scripts
SERVERNAME="Rust"
SAYDATE="echo $(date)"
USER="sudo -u $USERNAME "
SYNC="rsync --copy-links --stats -azh -s --delete"
SAY="echo $(date)"
BACKUPS="$DIR/Files/RustBackups/"
LOGS="/home/$USERNAME/LIVE_FILES/Logs.txt"
CLEANLOGS="echo > $LOGS"
SERVER="/home/$USERNAME/./rustserver"

# Locations
BACKUP_DIR="/home/$USERNAME/BackUps/"
LGSM_SCRIPT="/home/$USERNAME/rustserver"

##########################Depricated############################################################
#VIPTRIAL="/home/$USERNAME/serverfiles/oxide/config/VIPTrial.json"
#SCRIPTWIPECONFIG="Wipeconfigurator:"
#WIPER="$DIR/Files/Logs/WipeOutput.txt"
#SERVERINFO="/home/$USERNAME/serverfiles/oxide/config/ServerInfo.json"
SMARTCHATBOT="/home/$USERNAME/serverfiles/oxide/config/SmartChatBot.json"
#STARTUPDATER="$DIR/Files/Updater/Update/./update.sh"
#SERVERSTOP="$SERVER stop"
#SERVERSTART="$SERVER start"
#SERVERUPDATE="$SERVER update && $SERVER mods-update"
#AMAPUPDATE=:"$DIR/Files/Scripts"
#WIPECONFIGURE="$SCRIPT_DIR/Files/Scripts/./wipeConfigure.sh"
#UPDATER="$DIR/Files/Updater/Updater/./update.sh"
