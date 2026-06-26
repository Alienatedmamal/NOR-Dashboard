#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"


# This is to curl from Battlemetrics and gather information needed. Puts it in a nice file that lives in the live file directory. 
$SAYDATE "ServerStats: Gathering Server Data and Files..." >> $LOGS

# Needs to copy templete due to if server goes offline will replace with a blank line then wont update after that.
$SAYDATE "ServerStats: Clearing Old Data....." >> $LOGS
echo > /home/$USERNAME/LIVE_FILES/ServerStatus 
$SAYDATE "ServerStats: Copying Template to ServeStatus....." >> $LOGS
cat /home/$USERNAME/AMAP/Files/Config/tempServerStats > /home/$USERNAME/LIVE_FILES/ServerStatus

# Online Player Count
$SAYDATE "ServerStats: Gathering Player Count...." >> $LOGS
PLAYERS_ONLINE=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -o '"players":[0-9]*')
sed -i "s/\"players\":[0-9]*/$PLAYERS_ONLINE/" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Player Count Gathered" >> $LOGS

# Map Seed
$SAYDATE "ServerStats: Gathering Map Seed...." >> $LOGS
MAPSEED=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -o '"rust_world_seed":[0-9]*')
sed -i "s/\"rust_world_seed\":[0-9]*/$MAPSEED/" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Map Seed Gathered" >> $LOGS

# MAP SIZE
$SAYDATE "ServerStats: Gathering Map Size....." >> $LOGS
MAPSIZE=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -o '"rust_world_size":[0-9]*')
sed -i "s/\"rust_world_size\":[0-9]*/$MAPSIZE/" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Map Size Gathered" >> $LOGS

# Map Seed URL
$SAYDATE "ServerStats: Gathering Map Seed......" >> $LOGS
MAPURL=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -oP '"url":\s*"https://[^"]+')
ESCAPED_URL=$(printf '%s\n' "$MAPURL" | sed 's/[&/\]/\\&/g')
sed -i "s|\"url\":.*|$ESCAPED_URL|" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Map Seed Gathered" >> $LOGS

# MAP URL Image File
$SAYDATE "ServerStats: Gathering Map URL...." >> $LOGS
THUMBURL=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -oP '"thumbnailUrl":\s*"https://[^"]+')
sed -i "s|\"thumbnailUrl\":.*|$THUMBURL|" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Map URL Gathered" >> $LOGS

#  Server Status Online/Offline
$SAYDATE "ServerStats: Gathering Server Status....." >> $LOGS
STATUS_LINE=$(curl -s https://api.battlemetrics.com/servers/39370730 | grep -oP '"status":\s*"[^"]+"')
ESCAPED=$(printf '%s\n' "$STATUS_LINE" | sed 's/[&/\]/\\&/g')
sed -i "s|\"status\":.*|$ESCAPED|" /home/$USERNAME/LIVE_FILES/ServerStatus
$SAYDATE "ServerStats: Server Status Gathered" >> $LOGS
$SAYDATE "ServerStats: Server Data Has been Gathered" >> $LOGS
