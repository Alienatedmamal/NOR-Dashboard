#!/bin/bash
DIR="$(cd "$(dirname "$0")/../../" && pwd)"
source "$DIR/config.sh"

####################################################################################################
##				   WIPE-CONFIGURATOR						  ##
## This is to create a new file that the server pulls from for server information and		  ##
## configuration like Map size, Map Seed, Wipe date and any other information need for server.	  ##
## This is setup to run with amap. If used in another location will have to change file locations ##
## and file output locations.									  ##
##												  ##
####################################################################################################

echo "Create config file for the next wipe"
sleep 2

# Prompts user for information needed for server config. Seed, Map Size, and Wipe Date.
cat $DIR/Files/Images/wipecon
read -p "Enter seed: " seed
read -p "Enter map size: " map_size
read -p "Enter next wipe date MM-DD-YR(Use - not /): " wipe_date
read -p "Enter next wipe type: (BP or Map) " wipe_type

# File path for template to copy to
file="/home/$USERNAME/AMAP/Files/Config/config.cfg"
file1="/home/$USERNAME/AMAP/Files/Config/SmartChatBot.json"

# Original and ouput file paths
templateconfig="/home/$USERNAME/AMAP/Files/Config/templateconfig.cfg"
templatesmartbot="/home/$USERNAME/AMAP/Files/Config/templatesmartbot.json"
outputconfig="/home/$USERNAME/AMAP/Files/Config/config.cfg"
outputcommon="/home/$USERNAME/AMAP/Files/Config/common.cfg"
outputrustserver="/home/$USERNAME/AMAP/Files/Config/rustserver.cfg"
outputsmartbot="/home/$USERNAME/AMAP/Files/Config/SmartChatBot.json"

# Check if file exists before doing anything
if [[ ! -f "$file" ]]; then
    echo "❌ Error: File '$file' not found."
    exit 1
fi

# Copy the template to a new file
cp "$templateconfig" "$outputconfig"
cp "$templatesmartbot" "$outputsmartbot"

# This finds the variables and changes in the config and rustserver config files

if sed -i "s/{{SEED}}/$seed/g" "$file" && sed -i "s/{{MAP_SIZE}}/$map_size/g" "$file" && sed -i "s/{{WIPE_DATE}}/$wipe_date/g" "$file" && sed -i "s/{{WIPE_TYPE}}/$wipe_type/g" "$file"; then
    echo "✅ Updated $file with seed=$seed, map size=$map_size, and wipedate=$wipe_date this file is ready for wipe."
else
    echo "❌ Error: Could not update the file."
    exit 1
fi

# This finds the variables and changes in the SmartChatBot config file.

if sed -i "s/{{SEED}}/$seed/g" "$file1" && sed -i "s/{{MAP_SIZE}}/$map_size/g" "$file1" && sed -i "s/{{WIPE_DATE}}/$wipe_date/g" "$file1"; then
    echo "✅ Updated $file1 with wipedate=$wipe_date this file is ready for wipe."
else
    echo "❌ Error: Could not update the file."
    exit 1
fi

# Copies new file created to rustserver.cfg since it uses both files for configurations.
cp "$outputconfig" "$outputrustserver"
cp "$outputconfig" "$outputcommon"

# This will log the file creation in logs
$SAYDATE Wipeconfigurator $SERVERNAME New Server Config Created Map Seed=$seed, Wipe Date=$wipe_date, Wipe Type=$wipe_type..... >> $LOGS

